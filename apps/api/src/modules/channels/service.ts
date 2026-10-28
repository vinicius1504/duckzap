import type {
  Channel,
  ChannelsOverview,
  CreateChannelInput,
  OfficialCredentialsInput,
  OfficialWebhookInfo,
  QrSession,
  RotateWebhookTokenResult,
  UpdateChannelSettingsInput,
} from "@duckzap/contracts/channels";
import { schema, type Database, type Transaction } from "@duckzap/db";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { decryptSecret, encryptSecret, generateSecret, lastFour } from "../../lib/crypto";
import { resolvePlan } from "../../lib/plan";
import { queueRealtime, withOrgRealtime } from "../../lib/realtime";
import { ProviderError, type ChannelCredentials, type ConnectionStatus } from "../../lib/messaging";
import { setTeamChannels } from "./links";
import { allowedChannelTypes, checkCanCreate, type PlanInfo } from "./plan-limits";
import { providerKindForType } from "./providers/registry";
import { buildRef, channelWebhookUrl, findChannel, readCredentials, sealCredentials, toChannel, type ChannelRow } from "./repo";
import type { ChannelsRuntime } from "./runtime";
import { hashWebhookToken } from "./security";

export type Ctx = { organizationId: string };

export type Res<T, E extends string = never> = { ok: true; data: T } | { ok: false; code: E | "not_found" | "unavailable" | "invalid_credentials"; message: string };

const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });
const fail = <E extends string>(code: E, message: string): { ok: false; code: E; message: string } => ({ ok: false, code, message });
const notFound = () => fail("not_found" as const, "Canal não encontrado.");

function providerFailure(error: unknown) {
  if (error instanceof ProviderError) {
    if (error.code === "invalid_credentials") return fail("invalid_credentials" as const, error.message);
    return fail("unavailable" as const, error.message);
  }
  throw error;
}

/** Limites do plano da empresa (fonte única: `lib/plan.ts`). Sem assinatura/plano = nada liberado. */
async function planFor(tx: Transaction, organizationId: string): Promise<PlanInfo> {
  const plan = await resolvePlan(tx, organizationId);
  return { maxChannels: plan.limits.channels, features: plan.features };
}

const touch = () => ({ updatedAt: sql`now()` });

/** Muda o status e registra o instante da mudança só quando ele realmente mudou. */
export async function applyStatus(
  tx: Transaction,
  row: ChannelRow,
  status: ConnectionStatus,
  extra: Partial<typeof schema.channels.$inferInsert> = {},
) {
  const changed = row.status !== status;
  await tx
    .update(schema.channels)
    .set({
      status,
      ...(changed ? { lastStatusChangeAt: sql`now()` } : {}),
      ...(status === "connected" ? { qrPayloadEnc: null, qrExpiresAt: null } : {}),
      ...extra,
      ...touch(),
    })
    .where(eq(schema.channels.id, row.id));
  // aviso só com ids e o status (publicado depois do commit): a tela de Canais busca o resto pela API
  queueRealtime(tx, row.organizationId, { type: "channel.status", channelId: row.id, status });
}

// --- leitura ---------------------------------------------------------------------------------------------

export async function getOverview(db: Database, ctx: Ctx, rt: ChannelsRuntime): Promise<ChannelsOverview> {
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.organizationId, ctx.organizationId))
      .orderBy(asc(schema.channels.createdAt));
    const plan = await planFor(tx, ctx.organizationId);
    return {
      channels: rows.map(toChannel),
      teams: await rt.links.listTeams(tx, ctx.organizationId),
      agents: await rt.links.listAgents(tx, ctx.organizationId),
      limit: { used: rows.length, max: plan.maxChannels },
      allowedTypes: allowedChannelTypes(plan),
    };
  });
}

// --- criação / edição ------------------------------------------------------------------------------------

export async function createChannel(
  db: Database,
  ctx: Ctx,
  input: CreateChannelInput,
): Promise<Res<Channel, "plan_limit" | "type_not_allowed" | "duplicate_name">> {
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    // serializa criações simultâneas da mesma empresa: sem isso duas abas furam o limite do plano
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`channels:${ctx.organizationId}`}))`);

    const [{ used } = { used: 0 }] = await tx
      .select({ used: count() })
      .from(schema.channels)
      .where(eq(schema.channels.organizationId, ctx.organizationId));
    const plan = await planFor(tx, ctx.organizationId);
    const check = checkCanCreate(plan, used, input.type);
    if (!check.ok) return fail(check.code, check.message);

    const [clash] = await tx
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.organizationId, ctx.organizationId), sql`lower(${schema.channels.name}) = lower(${input.name})`))
      .limit(1);
    if (clash) return fail("duplicate_name", "Já existe um canal com esse nome.");

    const id = uuidv7();
    const provider = providerKindForType[input.type];
    const webhookToken = generateSecret("dzwh_");
    const credentials: ChannelCredentials =
      input.type === "whatsapp_qr"
        ? { instanceName: `dz-${id.replaceAll("-", "")}`, webhookSecret: generateSecret("dzes_") }
        : input.type === "whatsapp_official"
          ? { verifyToken: generateSecret("dzv_") }
          : {};
    const [{ defaults } = { defaults: 0 }] = await tx
      .select({ defaults: count() })
      .from(schema.channels)
      .where(and(eq(schema.channels.organizationId, ctx.organizationId), eq(schema.channels.isDefault, true)));

    const [row] = await tx
      .insert(schema.channels)
      .values({
        id,
        organizationId: ctx.organizationId,
        name: input.name,
        type: input.type,
        provider,
        status: input.type === "instagram" ? "awaiting_authorization" : input.type === "whatsapp_qr" ? "qr_pending" : "disconnected",
        // o primeiro número de WhatsApp vira o padrão (Instagram nunca)
        isDefault: input.type !== "instagram" && defaults === 0,
        credentialsEnc: sealCredentials(ctx.organizationId, credentials),
        webhookTokenHash: hashWebhookToken(webhookToken),
        webhookTokenEnc: encryptSecret(ctx.organizationId, webhookToken),
      })
      .returning();
    if (!row) throw new Error("channel insert returned no row");
    queueRealtime(tx, ctx.organizationId, { type: "channel.status", channelId: row.id, status: row.status });
    return ok(toChannel(row));
  });
}

export async function updateChannelSettings(
  db: Database,
  ctx: Ctx,
  rt: ChannelsRuntime,
  id: string,
  input: UpdateChannelSettingsInput,
): Promise<Res<Channel, "invalid_link">> {
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    if (!row) return notFound();
    if (input.teamId && !(await rt.links.teamExists(tx, ctx.organizationId, input.teamId))) return fail("invalid_link", "Equipe não encontrada.");
    if (input.agentId && !(await rt.links.agentExists(tx, ctx.organizationId, input.agentId))) return fail("invalid_link", "Agente não encontrado.");
    const [updated] = await tx
      .update(schema.channels)
      .set({
        teamId: input.teamId,
        agentId: input.agentId,
        ...(input.replyMode ? { replyMode: input.replyMode } : {}),
        ...(input.signMessages === undefined ? {} : { signMessages: input.signMessages }),
        welcomeMessage: input.messages.welcome,
        outOfHoursMessage: input.messages.outOfHours,
        closingMessage: input.messages.closing,
        ratingMessage: input.messages.rating,
        inactivityTransferMinutes: input.inactivityTransferMinutes,
        ...touch(),
      })
      .where(eq(schema.channels.id, row.id))
      .returning();
    if (updated) queueRealtime(tx, ctx.organizationId, { type: "channel.status", channelId: updated.id, status: updated.status });
    return updated ? ok(toChannel(updated)) : notFound();
  });
}

export async function setDefaultChannel(db: Database, ctx: Ctx, id: string): Promise<Res<null, "not_whatsapp">> {
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    if (!row) return notFound();
    if (row.type === "instagram") return fail("not_whatsapp", "O canal padrão precisa ser um número de WhatsApp.");
    // tira o antigo antes de pôr o novo (índice único parcial: um padrão por empresa)
    await tx
      .update(schema.channels)
      .set({ isDefault: false, ...touch() })
      .where(and(eq(schema.channels.organizationId, ctx.organizationId), eq(schema.channels.isDefault, true), ne(schema.channels.id, row.id)));
    await tx.update(schema.channels).set({ isDefault: true, ...touch() }).where(eq(schema.channels.id, row.id));
    queueRealtime(tx, ctx.organizationId, { type: "channel.status", channelId: row.id, status: row.status });
    return ok(null);
  });
}

/**
 * Exclui o canal. As conversas e mensagens FICAM salvas (FK ON DELETE SET NULL em `conversations.channel_id` e
 * `messages.channel_id`): a conversa sem canal envia pelo canal padrão conectado e a próxima mensagem do contato
 * continua a MESMA conversa, já com o canal novo. Devolve quantas conversas foram preservadas.
 * Só quem tem `channel.manage` (proprietário/administrador) chega aqui.
 */
export async function deleteChannel(
  db: Database,
  ctx: Ctx,
  rt: ChannelsRuntime,
  id: string,
): Promise<Res<{ preservedConversations: number }, "is_default">> {
  const target = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    if (!row) return { kind: "missing" as const };
    const [{ total } = { total: 0 }] = await tx
      .select({ total: count() })
      .from(schema.channels)
      .where(eq(schema.channels.organizationId, ctx.organizationId));
    if (row.isDefault && total > 1) return { kind: "default" as const };
    return { kind: "ok" as const, row, ref: buildRef(row, rt) };
  });
  if (target.kind === "missing") return notFound();
  if (target.kind === "default") {
    return fail("is_default", "Este é o canal padrão. Escolha outro canal padrão antes de excluir.");
  }

  // derruba a sessão no provedor antes de apagar; se falhar, a linha some mesmo assim e o log avisa (instância órfã)
  try {
    await rt.providers.get(target.row.provider)?.disconnect(target.ref);
  } catch (error) {
    rt.log.warn("channels.delete.provider_cleanup_failed", { channelId: target.row.id, provider: target.row.provider, error: error instanceof Error ? error.name : "unknown" });
  }
  const preservedConversations = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const [{ conversations } = { conversations: 0 }] = await tx
      .select({ conversations: count() })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.organizationId, ctx.organizationId), eq(schema.conversations.channelId, target.row.id)));
    await tx.delete(schema.channels).where(and(eq(schema.channels.id, target.row.id), eq(schema.channels.organizationId, ctx.organizationId)));
    queueRealtime(tx, ctx.organizationId, { type: "channel.status", channelId: target.row.id, status: "deleted" });
    return conversations;
  });
  return ok({ preservedConversations });
}

/** Usado pela tela de Canais/Equipe: a fonte de verdade do vínculo é `channels.team_id` (ver `links.ts`). */
export async function assignTeamChannels(
  db: Database,
  ctx: Ctx,
  teamId: string,
  channelIds: string[],
): Promise<Res<null, "invalid_link">> {
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const result = await setTeamChannels(tx, ctx.organizationId, teamId, channelIds);
    if (result.ok) return ok(null);
    return fail("invalid_link", result.code === "invalid_team" ? "Equipe não encontrada." : "Canal não encontrado.");
  });
}

// --- conexão: QR (Evolution) ----------------------------------------------------------------------------

export async function startQrSession(db: Database, ctx: Ctx, rt: ChannelsRuntime, id: string): Promise<Res<QrSession, "wrong_type">> {
  const loaded = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    return row ? { row, ref: buildRef(row, rt) } : undefined;
  });
  if (!loaded) return notFound();
  if (loaded.row.type !== "whatsapp_qr") return fail("wrong_type", "Este canal não usa QR Code.");
  const provider = rt.providers.get(loaded.row.provider);
  if (!provider) return fail("unavailable", "Provedor indisponível.");

  let result;
  try {
    result = await provider.connect(loaded.ref);
  } catch (error) {
    return providerFailure(error);
  }
  const expiresAt = new Date(rt.now().getTime() + rt.config.qrTtlSeconds * 1000);
  const credentials = result.credentials ? { ...loaded.ref.credentials, ...result.credentials } : undefined;

  await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const extra: Partial<typeof schema.channels.$inferInsert> = {
      ...(credentials ? { credentialsEnc: sealCredentials(ctx.organizationId, credentials), credentialsHint: lastFour(credentials.instanceToken ?? "") } : {}),
    };
    if (result.status === "connected") {
      await applyStatus(tx, loaded.row, "connected", { ...extra, ...(result.address ? { address: result.address } : {}) });
    } else {
      await applyStatus(tx, loaded.row, "qr_pending", {
        ...extra,
        qrPayloadEnc: result.qrCode ? encryptSecret(ctx.organizationId, result.qrCode) : null,
        qrExpiresAt: expiresAt,
      });
    }
  });

  return ok({
    channelId: loaded.row.id,
    status: result.status === "connected" ? "connected" : "waiting",
    payload: result.status === "connected" ? "" : (result.qrCode ?? ""),
    expiresAt: expiresAt.toISOString(),
  });
}

export async function getQrSession(db: Database, ctx: Ctx, rt: ChannelsRuntime, id: string): Promise<Res<QrSession>> {
  const loaded = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    return row ? { row, ref: buildRef(row, rt) } : undefined;
  });
  if (!loaded || loaded.row.type !== "whatsapp_qr") return notFound();
  let { row } = loaded;
  const now = rt.now();

  if (row.status !== "connected") {
    // o webhook pode ter se perdido: confirma direto no provedor (consulta local e barata)
    const provider = rt.providers.get(row.provider);
    if (provider?.inspect && loaded.ref.credentials.instanceName) {
      const info = await provider.inspect(loaded.ref).catch(() => undefined);
      if (info?.status === "connected") {
        row = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
          await applyStatus(tx, row, "connected", info.address ? { address: info.address } : {});
          return (await findChannel(tx, ctx.organizationId, id)) ?? row;
        });
      }
    }
  }

  if (row.status === "connected") {
    return ok({ channelId: row.id, status: "connected", payload: "", expiresAt: now.toISOString() });
  }
  if (!row.qrPayloadEnc || !row.qrExpiresAt) return fail("not_found", "Gere um novo código.");
  const expired = row.qrExpiresAt.getTime() <= now.getTime();
  return ok({
    channelId: row.id,
    status: expired ? "expired" : "waiting",
    payload: expired ? "" : decryptSecret(row.organizationId, row.qrPayloadEnc),
    expiresAt: row.qrExpiresAt.toISOString(),
  });
}

// --- conexão: API oficial (Meta) -------------------------------------------------------------------------

export async function getOfficialWebhookInfo(db: Database, ctx: Ctx, rt: ChannelsRuntime, id: string): Promise<Res<OfficialWebhookInfo>> {
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    if (!row || row.type !== "whatsapp_official") return notFound();
    const url = channelWebhookUrl(row, rt);
    const verifyToken = readCredentials(row).verifyToken;
    if (!url || !verifyToken) return fail("unavailable", "Canal sem configuração de webhook.");
    return ok({ webhookUrl: url, verifyToken });
  });
}

export async function connectOfficialChannel(
  db: Database,
  ctx: Ctx,
  rt: ChannelsRuntime,
  id: string,
  input: OfficialCredentialsInput,
): Promise<Res<Channel, "invalid_credentials">> {
  const loaded = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    return row ? { row, credentials: readCredentials(row) } : undefined;
  });
  if (!loaded || loaded.row.type !== "whatsapp_official") return notFound();
  const provider = rt.providers.get(loaded.row.provider);
  if (!provider) return fail("unavailable", "Provedor indisponível.");

  const credentials: ChannelCredentials = {
    ...loaded.credentials,
    phoneNumberId: input.phoneNumberId,
    businessAccountId: input.businessAccountId,
    accessToken: input.accessToken,
    ...(input.appSecret ? { appSecret: input.appSecret } : {}),
  };
  let result;
  try {
    result = await provider.connect(buildRef(loaded.row, rt, credentials));
  } catch (error) {
    return providerFailure(error);
  }

  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    await applyStatus(tx, loaded.row, "connected", {
      credentialsEnc: sealCredentials(ctx.organizationId, credentials),
      credentialsHint: lastFour(input.accessToken),
      ...(result.address ? { address: result.address } : {}),
    });
    const row = await findChannel(tx, ctx.organizationId, id);
    return row ? ok(toChannel(row)) : notFound();
  });
}

// --- conexão: Instagram (simulada) ------------------------------------------------------------------------

/** SIMULADO: marca o canal como conectado. No back real devolve a URL do OAuth e o callback conclui. */
export async function authorizeInstagram(db: Database, ctx: Ctx, id: string): Promise<Res<Channel>> {
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    if (!row || row.type !== "instagram") return notFound();
    const handle = row.name.startsWith("@")
      ? row.name
      : `@${row.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9._]/g, "")}`;
    await applyStatus(tx, row, "connected", { address: handle });
    const updated = await findChannel(tx, ctx.organizationId, id);
    return updated ? ok(toChannel(updated)) : notFound();
  });
}

// --- desconectar / rotacionar webhook ---------------------------------------------------------------------

export async function disconnectChannel(db: Database, ctx: Ctx, rt: ChannelsRuntime, id: string): Promise<Res<Channel>> {
  const loaded = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    return row ? { row, credentials: readCredentials(row) } : undefined;
  });
  if (!loaded) return notFound();
  const provider = rt.providers.get(loaded.row.provider);
  if (!provider) return fail("unavailable", "Provedor indisponível.");
  try {
    await provider.disconnect(buildRef(loaded.row, rt, loaded.credentials));
  } catch (error) {
    // se a sessão não caiu no provedor, não dizemos que está desconectado (privacidade do número)
    return providerFailure(error);
  }

  // esquece o que o provedor invalidou: token da instância (Evolution) / token de acesso (Meta)
  const { instanceToken: _a, accessToken: _b, ...kept } = loaded.credentials;
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    await applyStatus(tx, loaded.row, loaded.row.type === "instagram" ? "awaiting_authorization" : "disconnected", {
      credentialsEnc: sealCredentials(ctx.organizationId, kept),
      credentialsHint: null,
      qrPayloadEnc: null,
      qrExpiresAt: null,
      ...(loaded.row.type === "instagram" ? { address: null } : {}),
    });
    const row = await findChannel(tx, ctx.organizationId, id);
    return row ? ok(toChannel(row)) : notFound();
  });
}

/**
 * Troca o token da URL. Provedores que guardam a URL (Evolution) são atualizados ANTES de gravar; se falharem,
 * o token antigo continua valendo (nada se perde). Na API oficial o usuário precisa colar a URL nova na Meta.
 */
export async function rotateWebhookToken(db: Database, ctx: Ctx, rt: ChannelsRuntime, id: string): Promise<Res<RotateWebhookTokenResult>> {
  const loaded = await withOrgRealtime(db, ctx.organizationId, async (tx) => {
    const row = await findChannel(tx, ctx.organizationId, id);
    return row ? { row, credentials: readCredentials(row) } : undefined;
  });
  if (!loaded) return notFound();

  const token = generateSecret("dzwh_");
  const next: ChannelRow = { ...loaded.row, webhookTokenEnc: encryptSecret(ctx.organizationId, token), webhookTokenHash: hashWebhookToken(token) };
  const provider = rt.providers.get(loaded.row.provider);
  if (provider?.updateWebhook && loaded.row.provider === "evolution") {
    try {
      await provider.updateWebhook(buildRef(next, rt, loaded.credentials));
    } catch (error) {
      return providerFailure(error);
    }
  }
  return withOrgRealtime(db, ctx.organizationId, async (tx) => {
    await tx
      .update(schema.channels)
      .set({ webhookTokenEnc: next.webhookTokenEnc, webhookTokenHash: next.webhookTokenHash, ...touch() })
      .where(eq(schema.channels.id, loaded.row.id));
    return ok({ webhookUrl: loaded.row.provider === "meta_cloud" ? (channelWebhookUrl(next, rt) ?? null) : null });
  });
}
