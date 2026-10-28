import {
  type ChannelRef,
  type ConnectResult,
  type ConnectionStatus,
  type InboundEvent,
  type MessagingProvider,
  type OutboundMessage,
  type ProviderCapabilities,
  type SendResult,
} from "../../../lib/messaging";

/**
 * Instagram (DM): nesta fase só a máquina de estados da conexão. A autorização OAuth é simulada pelo
 * serviço do módulo (`authorizeInstagram`); envio e recebimento ainda não existem e dizem isso claramente.
 */
export class InstagramProvider implements MessagingProvider {
  readonly kind = "instagram";

  capabilities(): ProviderCapabilities {
    return { buttons: false, lists: false, templates: false, media: false, reactions: false, window24h: true, presence: false };
  }

  /** Sem OAuth real: o canal fica aguardando autorização. */
  async connect(_channel: ChannelRef): Promise<ConnectResult> {
    return { status: "awaiting_authorization" };
  }

  async disconnect(_channel: ChannelRef): Promise<void> {}

  async status(channel: ChannelRef): Promise<ConnectionStatus> {
    return channel.address ? "connected" : "awaiting_authorization";
  }

  async send(_channel: ChannelRef, _message: OutboundMessage): Promise<SendResult> {
    return { ok: false, code: "rejected", message: "O envio de mensagens pelo Instagram ainda não está disponível." };
  }

  /** Falha fechada: não há webhook do Instagram implementado. */
  async verifyWebhook(_request: Request, _channel: ChannelRef): Promise<boolean> {
    return false;
  }

  async parseWebhook(_request: Request, _channel: ChannelRef): Promise<InboundEvent[]> {
    return [];
  }
}
