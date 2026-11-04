import { schema, withOrg, type Database } from "@duckzap/db";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { makeAvatar } from "../../lib/thumbnail";
import { ProviderError, type MessagingProvider } from "../../lib/messaging";
import { queueRealtime, withOrgRealtime } from "../../lib/realtime";
import { buildRef, findChannel } from "../channels/repo";
import { getChannelsRuntime, type ChannelsRuntime } from "../channels/runtime";
import { InMemoryTokenBucket, type RateLimiter } from "../channels/rate-limit";
import { SIGNATURE_BYTES, hasSignature, storageKeyFor, type Signature } from "../media/logic";
import { MAX_REMOTE_IMAGE_BYTES, createImageFetcher, isAllowedImageUrl, type ImageFetcher } from "../media/remote-image";
import { getMediaRuntime, type MediaRuntime } from "../media/runtime";
import { fail, newId, ok, type Result } from "./result";

const { contacts, conversations, mediaFiles } = schema;

// Foto de perfil do WhatsApp do contato. O provedor devolve um link que EXPIRA, então a foto é baixada, reduzida e guardada por
// nós (mesmo armazenamento da mídia de conversa). É dado pessoal: nunca vai para log, e apagar o contato apaga a foto
// (`eraseMediaForContacts`). Melhor esforço: nada aqui atrasa nem derruba o recebimento de mensagem.

/** Quanto tempo vale a última tentativa: no máximo UMA consulta ao provedor por contato neste intervalo (com ou sem foto). */
export const AVATAR_REFRESH_MS = 7 * 86_400_000;
/** Foto de perfil do WhatsApp tem poucas dezenas de KB; acima disto o link não é o que esperamos. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Por canal: rajada de 10 consultas e uma nova a cada 2 s (uma importação de muitos contatos de uma vez não martela o provedor). */
export const AVATAR_LIMIT = { burst: 10, perSecond: 0.5 } as const;

const IMAGE_SIGNATURES: readonly Signature[] = ["jpeg", "png", "webp"];

export type AvatarOutcome =
  | "updated" // baixou e guardou a foto
  | "no_photo" // o contato não tem foto (ou é privada): a tentativa foi registrada e uma foto antiga, se havia, foi apagada
  | "not_due" // já tentamos há menos de 7 dias
  | "unsupported" // o provedor do canal não sabe buscar foto (Meta, Instagram…) ou o contato não tem telefone
  | "rate_limited" // limite por canal: nada foi gravado, a próxima mensagem do contato tenta de novo
  | "storage_off"; // sem armazenamento de mídia configurado
export type AvatarError = "not_found" | "provider_error" | "invalid_image" | "storage_failed";

export type AvatarDeps = {
  db: Database;
  channels: Pick<ChannelsRuntime, "providers" | "config">;
  media: MediaRuntime;
  fetchImage: ImageFetcher;
  limiter: RateLimiter;
  now(): Date;
  /** Só códigos e ids da empresa: nada de telefone, URL ou conteúdo da foto. */
  log: { warn(message: string, meta?: Record<string, unknown>): void };
};

/** O contato por id, ou pela conversa (é o que o recebimento de mensagem tem à mão). Precisa de um dos dois. */
export type AvatarTarget = { organizationId: string; channelId: string; contactId?: string; conversationId?: string };

type ProfileProvider = MessagingProvider & { fetchProfilePicture: NonNullable<MessagingProvider["fetchProfilePicture"]> };

type Prepared =
  | { kind: "stop"; outcome: AvatarOutcome }
  | { kind: "not_found" }
  | { kind: "go"; contactId: string; conversationId: string | null; phone: string; hadAvatar: boolean; provider: ProfileProvider; ref: ReturnType<typeof buildRef> };

/**
 * Busca e guarda a foto de perfil de UM contato, se estiver na hora. Ordem (o provedor e o download ficam FORA de transação):
 * 1) lê contato e canal e decide se vale tentar; 2) respeita o limite do canal; 3) "reserva" a tentativa gravando
 * `avatar_checked_at` (duas mensagens ao mesmo tempo não consultam duas vezes); 4) pergunta a URL ao provedor; 5) baixa e confere
 * (host do WhatsApp, tamanho, imagem de verdade); 6) guarda o objeto e troca a foto numa transação curta.
 */
export async function refreshContactAvatar(deps: AvatarDeps, target: AvatarTarget): Promise<Result<AvatarOutcome, AvatarError>> {
  const { organizationId } = target;
  const now = deps.now();
  if (!deps.media.storage) return ok("storage_off");

  // 1. contato + canal (transação curta)
  const prepared = await withOrg(deps.db, organizationId, async (tx): Promise<Prepared> => {
    const channel = await findChannel(tx, organizationId, target.channelId);
    if (!channel) return { kind: "not_found" };
    const provider = deps.channels.providers.get(channel.provider);
    if (!provider?.fetchProfilePicture) return { kind: "stop", outcome: "unsupported" };
    let contactId = target.contactId;
    if (!contactId && target.conversationId) {
      const [conv] = await tx
        .select({ contactId: conversations.contactId })
        .from(conversations)
        .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, target.conversationId)))
        .limit(1);
      contactId = conv?.contactId;
    }
    if (!contactId) return { kind: "not_found" };
    const [row] = await tx
      .select({ id: contacts.id, phone: contacts.phone, checkedAt: contacts.avatarCheckedAt, avatarMediaId: contacts.avatarMediaId })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
      .limit(1);
    if (!row) return { kind: "not_found" };
    if (!row.phone) return { kind: "stop", outcome: "unsupported" };
    if (row.checkedAt && row.checkedAt.getTime() > now.getTime() - AVATAR_REFRESH_MS) return { kind: "stop", outcome: "not_due" };
    return {
      kind: "go",
      contactId: row.id,
      conversationId: target.conversationId ?? null,
      phone: row.phone,
      hadAvatar: row.avatarMediaId !== null,
      provider: provider as ProfileProvider,
      ref: buildRef(channel, deps.channels),
    };
  });
  if (prepared.kind === "not_found") return fail("not_found", "Contato ou canal não encontrado.");
  if (prepared.kind === "stop") return ok(prepared.outcome);

  // 2. limite por canal (antes de gravar qualquer coisa: o que passou do limite tenta de novo na próxima mensagem do contato)
  const slot = await deps.limiter.take(`avatar:${target.channelId}`);
  if (!slot.allowed) return ok("rate_limited");

  // 3. reserva a tentativa; quem perdeu a corrida (outra mensagem já reservou) não consulta de novo
  const claimed = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .update(contacts)
      .set({ avatarCheckedAt: now })
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          eq(contacts.id, prepared.contactId),
          or(isNull(contacts.avatarCheckedAt), lte(contacts.avatarCheckedAt, new Date(now.getTime() - AVATAR_REFRESH_MS))),
        ),
      )
      .returning({ id: contacts.id }),
  );
  if (claimed.length === 0) return ok("not_due");

  // 4. URL no provedor (fora de transação)
  let url: string | null;
  try {
    url = await prepared.provider.fetchProfilePicture(prepared.ref, { to: prepared.phone });
  } catch (error) {
    deps.log.warn("contacts.avatar.provider_error", { channelId: target.channelId, code: error instanceof ProviderError ? error.code : "unknown" });
    return fail("provider_error", "O WhatsApp não devolveu a foto agora.");
  }
  if (!url) {
    // sem foto (ou privada): a que tínhamos não vale mais
    if (prepared.hadAvatar) await dropAvatar(deps, organizationId, prepared.contactId, prepared.conversationId);
    return ok("no_photo");
  }

  // 5. baixa e confere: host permitido, tamanho, tipo real (assinatura) e imagem que o decodificador abre
  if (!isAllowedImageUrl(url)) {
    deps.log.warn("contacts.avatar.url_rejected", { channelId: target.channelId });
    return fail("invalid_image", "O endereço da foto não é do WhatsApp.");
  }
  const downloaded = await deps.fetchImage(url);
  if (!downloaded || downloaded.bytes.length === 0 || downloaded.bytes.length > AVATAR_MAX_BYTES) {
    deps.log.warn("contacts.avatar.download_failed", { channelId: target.channelId });
    return fail("invalid_image", "Não foi possível baixar a foto.");
  }
  const head = downloaded.bytes.subarray(0, SIGNATURE_BYTES);
  const avatar = IMAGE_SIGNATURES.some((signature) => hasSignature(signature, head)) ? await makeAvatar(downloaded.bytes) : null;
  if (!avatar) {
    deps.log.warn("contacts.avatar.invalid_image", { channelId: target.channelId });
    return fail("invalid_image", "A foto não é uma imagem válida.");
  }

  // 6. guarda o objeto e troca a foto do contato
  const storage = deps.media.storage;
  const mediaId = newId();
  const storageKey = storageKeyFor(organizationId, now);
  try {
    await storage.put(storageKey, avatar, { contentType: "image/webp" });
  } catch {
    deps.log.warn("contacts.avatar.store_failed", { organizationId });
    return fail("storage_failed", "Não foi possível guardar a foto.");
  }
  try {
    const replaced = await withOrgRealtime(deps.db, organizationId, async (tx) => {
      // trava o contato: a exclusão (LGPD) e outra troca de foto esperam, e contato apagado no meio do caminho não ganha foto
      const [current] = await tx
        .select({ avatarMediaId: contacts.avatarMediaId })
        .from(contacts)
        .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, prepared.contactId)))
        .limit(1)
        .for("update");
      if (!current) throw new ContactGoneError();
      await tx.insert(mediaFiles).values({
        id: mediaId,
        organizationId,
        kind: "image",
        fileName: "avatar.webp",
        mimeType: "image/webp",
        sizeBytes: avatar.length,
        storageKey,
        thumbKey: null,
        status: "ready",
        direction: "in",
        createdBy: null,
        createdAt: now,
        readyAt: now,
      });
      await tx.update(contacts).set({ avatarMediaId: mediaId }).where(eq(contacts.id, prepared.contactId));
      let oldKey: string | null = null;
      if (current.avatarMediaId) {
        const [old] = await tx.delete(mediaFiles).where(and(eq(mediaFiles.organizationId, organizationId), eq(mediaFiles.id, current.avatarMediaId))).returning({ key: mediaFiles.storageKey });
        oldKey = old?.key ?? null;
      }
      if (prepared.conversationId) queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: prepared.conversationId, reason: "other" });
      return oldKey;
    });
    if (replaced) await storage.delete(replaced).catch(() => deps.log.warn("contacts.avatar.old_delete_failed", { organizationId }));
  } catch (error) {
    // o objeto novo não tem dono: sai do armazenamento
    await storage.delete(storageKey).catch(() => {});
    if (error instanceof ContactGoneError) return fail("not_found", "Contato não encontrado.");
    deps.log.warn("contacts.avatar.record_failed", { organizationId });
    return fail("storage_failed", "Não foi possível guardar a foto.");
  }
  return ok("updated");
}

class ContactGoneError extends Error {}

/** O contato deixou de ter foto no WhatsApp: apaga a nossa cópia (registro e objeto). Melhor esforço no objeto. */
async function dropAvatar(deps: AvatarDeps, organizationId: string, contactId: string, conversationId: string | null) {
  try {
    const key = await withOrgRealtime(deps.db, organizationId, async (tx) => {
      const [current] = await tx
        .select({ avatarMediaId: contacts.avatarMediaId })
        .from(contacts)
        .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
        .limit(1)
        .for("update");
      if (!current?.avatarMediaId) return null;
      await tx.update(contacts).set({ avatarMediaId: null }).where(eq(contacts.id, contactId));
      const [old] = await tx.delete(mediaFiles).where(and(eq(mediaFiles.organizationId, organizationId), eq(mediaFiles.id, current.avatarMediaId))).returning({ key: mediaFiles.storageKey });
      if (conversationId) queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId, reason: "other" });
      return old?.key ?? null;
    });
    if (key) await deps.media.storage?.delete(key);
  } catch {
    deps.log.warn("contacts.avatar.drop_failed", { organizationId });
  }
}

// ── gancho do recebimento de mensagem ───────────────────────────────────────

/** O que o recebimento de mensagem chama. Nunca lança e nunca espera: a foto é melhor esforço em segundo plano. */
export type AvatarPort = {
  request(input: { organizationId: string; channelId: string; conversationId: string }): void;
};

type PortOptions = {
  db: Database;
  channels?: () => Pick<ChannelsRuntime, "providers" | "config" | "background" | "log">;
  media?: () => MediaRuntime;
  fetchImage?: ImageFetcher;
  limiter?: RateLimiter;
  now?: () => Date;
  /** Testes trocam por algo que guarde a promessa; o padrão é o `background` do runtime de canais. */
  background?: (task: () => Promise<void>) => void;
};

export function createAvatarPort(options: PortOptions): AvatarPort {
  const channelsRt = options.channels ?? getChannelsRuntime;
  const mediaRt = options.media ?? getMediaRuntime;
  const fetchImage = options.fetchImage ?? createImageFetcher(fetch, { maxBytes: Math.min(AVATAR_MAX_BYTES, MAX_REMOTE_IMAGE_BYTES) });
  const limiter = options.limiter ?? new InMemoryTokenBucket({ capacity: AVATAR_LIMIT.burst, refillPerSecond: AVATAR_LIMIT.perSecond });
  const now = options.now ?? (() => new Date());
  // contatos com uma busca em andamento NESTE processo (mensagens em rajada não disparam várias buscas iguais)
  const inFlight = new Set<string>();

  return {
    request(input) {
      try {
        const channels = channelsRt();
        const flightKey = `${input.organizationId}:${input.conversationId}`;
        if (inFlight.has(flightKey)) return;
        inFlight.add(flightKey);
        const background = options.background ?? channels.background;
        background(async () => {
          try {
            await refreshContactAvatar({ db: options.db, channels, media: mediaRt(), fetchImage, limiter, now, log: channels.log }, input);
          } finally {
            inFlight.delete(flightKey);
          }
        });
      } catch {
        // melhor esforço: nada daqui pode afetar a mensagem
      }
    },
  };
}
