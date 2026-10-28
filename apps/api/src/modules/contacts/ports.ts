import { warmupDailyLimit } from "@duckzap/contracts/campaigns";
import { CHANNEL_DAILY_LIMIT, INVITE_DAILY_LIMIT, type InviteChannel } from "@duckzap/contracts/contacts";

// Portas do módulo Clientes para o que pertence a outros módulos (Canais, fila/worker). Este módulo NÃO importa
// Canais: quem integra implementa estas interfaces e as injeta em `contactsRoutes(deps, ports)`.

/** O que Clientes precisa saber de um número (vem do módulo Canais). */
export type InviteChannelInfo = {
  id: string;
  name: string;
  provider: "qr" | "official";
  connected: boolean;
  /** Mensagens de campanha/convite já enviadas hoje por este número (o teto de 50/dia é do canal). */
  messagesSentToday: number;
  /** Dia de aquecimento do número novo (1–7+), ou null se já aquecido. */
  warmupDay: number | null;
};

export interface ChannelDirectory {
  listInviteChannels(organizationId: string): Promise<InviteChannelInfo[]>;
}

/** Trabalho de envio do convite. O worker (futuro) sorteia intervalos, respeita a janela e chama o MessagingProvider. */
export type InviteJob = {
  organizationId: string;
  contactId: string;
  channelId: string;
  /** Telefone E.164 do destinatário. */
  to: string;
  text: string;
  /** Dia (AAAA-MM-DD, fuso da empresa) em que deve sair. */
  runOn: string;
};

export interface InviteQueue {
  enqueueInvites(jobs: readonly InviteJob[]): Promise<void>;
}

export type ContactsPorts = { channels: ChannelDirectory; queue: InviteQueue };

/** Limite diário de mensagens do número, pelo aquecimento (10 → 25 → 50). Útil para quem implementa `ChannelDirectory`. */
export function channelDailyLimit(warmupDay: number | null) {
  return warmupDay === null ? CHANNEL_DAILY_LIMIT : warmupDailyLimit(warmupDay);
}

export function toInviteChannel(info: InviteChannelInfo, invitesSentToday: number): InviteChannel {
  return {
    id: info.id,
    name: info.name,
    provider: info.provider,
    connected: info.connected,
    invitesSentToday,
    inviteDailyLimit: INVITE_DAILY_LIMIT,
    messagesSentToday: info.messagesSentToday,
    channelDailyLimit: channelDailyLimit(info.warmupDay),
    warmupDay: info.warmupDay,
  };
}

/** Adaptador em memória/no-op: sem canais conectados e fila que só guarda os jobs (testes e dev). */
export function createInMemoryPorts(initialChannels: InviteChannelInfo[] = []) {
  const channels = [...initialChannels];
  const jobs: InviteJob[] = [];
  const ports: ContactsPorts = {
    channels: { listInviteChannels: async () => [...channels] },
    queue: {
      enqueueInvites: async (batch) => {
        jobs.push(...batch);
      },
    },
  };
  return { ports, jobs, channels };
}
