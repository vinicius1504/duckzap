// Ids que o PRÓPRIO DuckChat acabou de enviar por um canal. O provedor (Evolution) ecoa no webhook toda mensagem que sai da conta,
// tanto a nossa quanto a que a pessoa digitou no celular. Para não gravar duas vezes a nossa, quem trata o eco pergunta aqui.
//
// Por que em memória e não só no banco: o envio grava `provider_message_id` dentro de uma transação que pode durar vários
// segundos (a IA manda várias partes e fotos numa só); o eco chega antes do commit e não enxerga a linha. O registro é feito no
// instante em que o provedor responde. Com mais de uma instância da API o registro não é compartilhado: aí vale a conferência no
// banco (e a pequena espera) feita por quem trata o eco.

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 10_000;

const seen = new Map<string, number>();

const keyOf = (channelId: string, providerMessageId: string) => `${channelId}:${providerMessageId}`;

function prune(now: number) {
  for (const [key, expiresAt] of seen) {
    if (expiresAt > now && seen.size <= MAX_ENTRIES) break; // Map guarda a ordem de inserção: o resto é mais novo
    seen.delete(key);
  }
}

export function rememberSentByUs(channelId: string, providerMessageId: string, now = Date.now()) {
  seen.delete(keyOf(channelId, providerMessageId));
  seen.set(keyOf(channelId, providerMessageId), now + TTL_MS);
  prune(now);
}

export function wasSentByUs(channelId: string, providerMessageId: string, now = Date.now()): boolean {
  const expiresAt = seen.get(keyOf(channelId, providerMessageId));
  return expiresAt !== undefined && expiresAt > now;
}

/** Só para testes. */
export function clearSentByUs() {
  seen.clear();
}
