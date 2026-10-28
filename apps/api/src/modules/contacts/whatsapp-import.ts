import {
  WHATSAPP_IMPORT_MAX_ROWS,
  type ImportResult,
  type WhatsappCandidate,
  type WhatsappImportCommit,
  type WhatsappImportPreview,
} from "@duckzap/contracts/contacts";
import { schema, type Transaction } from "@duckzap/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { ProviderError, type ChannelRef, type MessagingProvider, type ProviderContact } from "../../lib/messaging";
import { readCredentials, findChannel } from "../channels/repo";
import { applyImport, checkImportTargets, claimPendingImport, loadPendingImport, type ImportCandidate } from "./import-export";
import { normalizePhone } from "./phone";
import { chunk, fail, newId, ok, type Result, type ServiceCtx } from "./result";

const { contacts, contactImports } = schema;

// Importar do WhatsApp: busca os contatos que o WhatsApp do canal (QR Code) conhece, guarda a lista na mesma tabela de
// preparo da planilha e, na confirmação, termina pelo mesmo miolo (`applyImport`): origem, etiquetas, lista, dedupe por telefone.

const IMPORT_TTL_MS = 60 * 60 * 1000;
/** O nome do arquivo guardado vira o título do evento "Importado de …" na linha do tempo do cliente. */
const SOURCE_PREFIX = "WhatsApp · ";

/** Roda um trecho dentro do tenant (a rota usa `withOrg`). A chamada ao provedor fica FORA da transação: é lenta. */
export type RunInTenant = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

/** O que o canal precisa dar (Canais é dono): o registro de provedores e um log sem dado pessoal. */
export type WhatsappImportDeps = {
  providers: { get(kind: string): MessagingProvider | undefined };
  log: { warn(message: string, meta?: Record<string, unknown>): void };
};

type SourceChannel = { id: string; name: string; ownPhone: string | null; ref: ChannelRef; list: (ref: ChannelRef) => Promise<ProviderContact[]> };

async function loadSourceChannel(
  tx: Transaction,
  ctx: ServiceCtx,
  channelId: string,
  deps: WhatsappImportDeps,
): Promise<Result<SourceChannel, "channel_not_found" | "channel_unsupported" | "channel_disconnected">> {
  const row = await findChannel(tx, ctx.organizationId, channelId);
  if (!row) return fail("channel_not_found", "Canal não encontrado.");
  const provider = row.type === "whatsapp_qr" ? deps.providers.get(row.provider) : undefined;
  const list = provider?.listContacts?.bind(provider);
  if (!list) {
    return fail(
      "channel_unsupported",
      "Só dá para importar contatos de um WhatsApp conectado por QR Code. O WhatsApp oficial (Meta) e o Instagram não permitem ver a lista de contatos.",
    );
  }
  if (row.status !== "connected") return fail("channel_disconnected", "Este WhatsApp está desconectado. Reconecte o canal em Canais e tente de novo.");
  const own = row.address ? normalizePhone(row.address) : null;
  const ref: ChannelRef = { id: row.id, organizationId: row.organizationId, credentials: readCredentials(row), ...(row.address ? { address: row.address } : {}) };
  return ok({ id: row.id, name: row.name, ownPhone: own?.ok ? own.phone : null, ref, list });
}

export type WhatsappCandidatesBreakdown = {
  /** Só `phone` e `name` (já aparado e limitado); `existing` é preenchido depois, com a base. */
  candidates: Omit<WhatsappCandidate, "existing">[];
  groups: number;
  hidden: number;
  /** Transmissão/status, número inválido, o próprio número do canal e repetidos. */
  other: number;
};

/**
 * Contatos do provedor → candidatos. Telefone E.164 igual ao que a entrada de mensagens grava (`+` + dígitos do JID), para
 * o dedupe com Clientes bater. Fora: grupos, IDs ocultos (`@lid`), o número do próprio canal, número inválido e repetidos
 * (fica o que tem nome). Ordenado por nome, sem nome no fim. Invariante: `found = candidates + groups + hidden + other`.
 */
export function buildWhatsappCandidates(found: readonly ProviderContact[], ownPhone: string | null): WhatsappCandidatesBreakdown {
  let groups = 0;
  let hidden = 0;
  let other = 0;
  const byPhone = new Map<string, string>();
  for (const contact of found) {
    if (contact.kind === "group") {
      groups++;
      continue;
    }
    if (contact.kind === "hidden") {
      hidden++;
      continue;
    }
    const phone = contact.kind === "person" && contact.phoneDigits ? normalizePhone(`+${contact.phoneDigits}`) : null;
    if (!phone?.ok || phone.phone === ownPhone) {
      other++;
      continue;
    }
    const name = (contact.name ?? "").trim().slice(0, 120);
    const previous = byPhone.get(phone.phone);
    if (previous === undefined) {
      byPhone.set(phone.phone, name);
      continue;
    }
    other++;
    if (!previous && name) byPhone.set(phone.phone, name);
  }
  const candidates = [...byPhone].map(([phone, name]) => ({ phone, name }));
  candidates.sort((a, b) => {
    if (!a.name !== !b.name) return a.name ? -1 : 1;
    return a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }) || a.phone.localeCompare(b.phone);
  });
  return { candidates, groups, hidden, other };
}

function providerFailure(error: unknown, deps: WhatsappImportDeps) {
  const code = error instanceof ProviderError ? error.code : "unknown";
  deps.log.warn("contacts.whatsapp_import.provider_error", { code });
  if (code === "invalid_credentials") {
    return fail("channel_disconnected" as const, "O WhatsApp deste canal não está conectado. Reconecte o canal em Canais e tente de novo.");
  }
  return fail("provider_unavailable" as const, "Não conseguimos buscar os contatos do WhatsApp agora. Tente de novo em alguns instantes.");
}

/**
 * Etapa 1: valida o canal, busca os contatos no WhatsApp, marca quem já é cliente e guarda a lista até a confirmação.
 * Quem chama deve limitar a taxa (a chamada ao provedor é pesada).
 */
export async function previewWhatsappImport(
  run: RunInTenant,
  ctx: ServiceCtx,
  input: { channelId: string },
  deps: WhatsappImportDeps,
  now = new Date(),
): Promise<Result<WhatsappImportPreview, "channel_not_found" | "channel_unsupported" | "channel_disconnected" | "provider_unavailable" | "too_large">> {
  const loaded = await run((tx) => loadSourceChannel(tx, ctx, input.channelId, deps));
  if (!loaded.ok) return loaded;
  const channel = loaded.data;

  let found: ProviderContact[];
  try {
    found = await channel.list(channel.ref);
  } catch (error) {
    return providerFailure(error, deps);
  }

  const built = buildWhatsappCandidates(found, channel.ownPhone);
  if (built.candidates.length > WHATSAPP_IMPORT_MAX_ROWS) {
    return fail("too_large", `Seu WhatsApp tem mais de ${WHATSAPP_IMPORT_MAX_ROWS.toLocaleString("pt-BR")} contatos. Use uma planilha para importar em partes.`);
  }

  return run(async (tx) => {
    const known = new Set<string>();
    for (const batch of chunk(built.candidates, 1000)) {
      const rows = await tx
        .select({ phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.phone, batch.map((c) => c.phone))));
      for (const row of rows) if (row.phone) known.add(row.phone);
    }
    const candidates: WhatsappCandidate[] = built.candidates.map((c) => ({ ...c, existing: known.has(c.phone) }));

    await tx.delete(contactImports).where(and(eq(contactImports.organizationId, ctx.organizationId), lt(contactImports.expiresAt, now)));
    const importId = newId();
    await tx.insert(contactImports).values({
      id: importId,
      organizationId: ctx.organizationId,
      fileName: `${SOURCE_PREFIX}${channel.name}`.slice(0, 200),
      rows: candidates.map((c) => ({ Nome: c.name, Telefone: c.phone })),
      createdBy: ctx.userId,
      expiresAt: new Date(now.getTime() + IMPORT_TTL_MS),
    });
    return ok({
      importId,
      channelId: channel.id,
      channelName: channel.name,
      candidates,
      summary: {
        found: found.length,
        people: candidates.length,
        existing: candidates.filter((c) => c.existing).length,
        groups: built.groups,
        hidden: built.hidden,
        other: built.other,
        noName: candidates.filter((c) => !c.name).length,
      },
    });
  });
}

/**
 * Etapa 2: importa a seleção. SÓ aceita telefones que vieram da prévia (qualquer outro derruba o pedido com `invalid`, sem
 * consumir a importação); aplica os nomes corrigidos (vazio vira "Sem nome", como na planilha) e termina em `applyImport`.
 * `skipped[].row` é a posição (1, 2, 3…) do contato na seleção enviada. Uso único, mesma expiração da planilha.
 */
export async function commitWhatsappImport(
  tx: Transaction,
  ctx: ServiceCtx,
  commit: WhatsappImportCommit,
  now = new Date(),
): Promise<Result<ImportResult, "not_found" | "invalid">> {
  const loaded = await loadPendingImport(tx, ctx, commit.importId, now);
  if (!loaded.ok) return fail("not_found", "A busca expirou. Busque os contatos do WhatsApp de novo.");
  const pending = loaded.data;
  // uma planilha guardada não serve aqui: este caminho só vale para listas que a busca no WhatsApp montou
  if (!pending.fileName.startsWith(SOURCE_PREFIX)) return fail("not_found", "A busca expirou. Busque os contatos do WhatsApp de novo.");

  const staged = new Set(pending.rows.map((row) => row.Telefone));
  if (commit.rows.some((row) => !staged.has(row.phone.trim()))) {
    return fail("invalid", "Há contatos que não vieram da busca no WhatsApp. Busque de novo e marque outra vez.");
  }

  const targets = await checkImportTargets(tx, commit.tagIds, commit.listId);
  if (!targets.ok) return targets;
  if (!(await claimPendingImport(tx, ctx, commit.importId))) return fail("not_found", "A busca expirou. Busque os contatos do WhatsApp de novo.");

  const result: ImportResult = { created: 0, updated: 0, skipped: [] };
  const candidates: ImportCandidate[] = [];
  const seen = new Set<string>();
  commit.rows.forEach((row, index) => {
    const phone = row.phone.trim();
    if (seen.has(phone)) return void result.skipped.push({ row: index + 1, reason: "duplicate" });
    seen.add(phone);
    candidates.push({ row: index + 1, name: row.name.trim().slice(0, 120) || "Sem nome", phone, email: null, birthDate: null, note: null });
  });

  const target = { origin: commit.origin, originNote: commit.originNote, tagIds: targets.data, listId: commit.listId, sourceName: pending.fileName };
  await applyImport(tx, ctx, target, candidates, result, now);
  return ok(result);
}
