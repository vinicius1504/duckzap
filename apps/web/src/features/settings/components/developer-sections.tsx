"use client";

import {
  apiKeyScopeSchema,
  webhookEventSchema,
  type ApiKey,
  type ApiKeyScope,
  type Webhook,
  type WebhookEvent,
} from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { Switch } from "@duckzap/ui/components/switch";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import { cn } from "@duckzap/ui/cn";
import { useState, useTransition } from "react";
import { formatDate } from "@/lib/format";
import {
  createApiKeyAction,
  createWebhookAction,
  deleteWebhookAction,
  revokeApiKeyAction,
  setWebhookActiveAction,
  testWebhookAction,
} from "../actions";
import { ConfirmDialog } from "./confirm-dialog";
import { CopyField } from "./copy-field";

const scopeLabels: Record<ApiKeyScope, string> = {
  "conversations:read": "Ler conversas",
  "messages:send": "Enviar mensagens",
  "contacts:read": "Ler clientes",
  "contacts:write": "Criar e editar clientes",
};

const eventLabels: Record<WebhookEvent, string> = {
  "message.received": "Mensagem recebida",
  "message.sent": "Mensagem enviada",
  "conversation.resolved": "Conversa resolvida",
  "contact.created": "Cliente criado",
  "appointment.created": "Agendamento criado",
};

const dateTime = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" } as const;
const dateOnly = { day: "2-digit", month: "2-digit", year: "numeric" } as const;

function toggle<T>(list: T[], value: T, on: boolean) {
  return on ? [...list, value] : list.filter((v) => v !== value);
}

/** Segredo mostrado uma única vez (chave de API, segredo de assinatura). */
function SecretOnce({ id, label, secret }: { id: string; label: string; secret: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warn" title="Copie agora.">
        Esta é a única vez que mostramos {label.toLowerCase()}. Guarde em um lugar seguro; se perder, crie outro.
      </Alert>
      <CopyField id={id} label={label} value={secret} mono />
    </div>
  );
}

// ---------- Chaves de API ----------

function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["conversations:read"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setName("");
          setScopes(["conversations:read"]);
          setSecret(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="primary">
          Criar chave
        </Button>
      </DialogTrigger>
      <DialogContent title={secret ? "Chave criada" : "Criar chave de API"} size="md">
        {secret ? (
          <>
            <SecretOnce id="nova-chave-segredo" label="A chave" secret={secret} />
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="primary">Já copiei</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await createApiKeyAction({ name, scopes });
                if (result.ok) setSecret(result.data.secret);
                else setError(result.error);
              });
            }}
          >
            <div>
              <Label htmlFor="chave-nome">Nome</Label>
              <Input id="chave-nome" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Integração site" maxLength={60} />
            </div>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-semibold">Permissões</legend>
              {apiKeyScopeSchema.options.map((scope) => (
                <label key={scope} className="flex min-h-11 items-center gap-2.5">
                  <Checkbox checked={scopes.includes(scope)} onChange={(e) => setScopes((s) => toggle(s, scope, e.target.checked))} />
                  {scopeLabels[scope]} <code className="text-xs text-ink-2">{scope}</code>
                </label>
              ))}
            </fieldset>
            {error ? (
              <Alert tone="err" live>
                {error}
              </Alert>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button>Cancelar</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Criando…" : "Criar chave"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysSection({ apiKeys, timeZone }: { apiKeys: ApiKey[]; timeZone: string }) {
  return (
    <Card className="col-span-full flex flex-col gap-3 p-5 max-sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold">Chaves de API</h3>
          <p className="text-[13px] text-ink-2">Para desenvolvedores. Documentação resumida em Ajuda.</p>
        </div>
        <CreateApiKeyDialog />
      </div>
      {apiKeys.length ? (
        <Table minWidth={720}>
          <thead>
            <tr>
              <Th>Nome</Th>
              <Th>Chave</Th>
              <Th>Criada em</Th>
              <Th>Último uso</Th>
              <Th>
                <span className="sr-only">Ações</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((key) => (
              <tr key={key.id} className={cn(key.revokedAt && "opacity-70")}>
                <Td>
                  <strong>{key.name}</strong>
                  <p className="text-xs text-ink-2">{key.scopes.map((s) => scopeLabels[s]).join(", ")}</p>
                </Td>
                <Td>
                  <code className="text-[13px]">
                    {key.prefix}••••••••{key.last4}
                  </code>
                </Td>
                <Td>{formatDate(key.createdAt, dateOnly, timeZone)}</Td>
                <Td>{key.lastUsedAt ? formatDate(key.lastUsedAt, dateTime, timeZone) : "Nunca usada"}</Td>
                <Td className="text-right">
                  {key.revokedAt ? (
                    <Chip>Revogada em {formatDate(key.revokedAt, dateOnly, timeZone)}</Chip>
                  ) : (
                    <ConfirmDialog
                      trigger={
                        <Button size="sm" variant="ghost" className="text-err" aria-label={`Revogar a chave ${key.name}`}>
                          Revogar
                        </Button>
                      }
                      title={`Revogar “${key.name}”?`}
                      description="Sistemas que usam esta chave param de funcionar na hora. Não dá para desfazer."
                      confirmLabel="Revogar chave"
                      danger
                      onConfirm={() => revokeApiKeyAction(key.id)}
                    />
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState icon="key" title="Nenhuma chave criada" description="Crie uma chave para integrar seu site ou sistema ao Duckzap." />
      )}
    </Card>
  );
}

// ---------- Webhooks ----------

function CreateWebhookDialog() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["message.received"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setUrl("");
          setEvents(["message.received"]);
          setSecret(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="primary">
          Novo webhook
        </Button>
      </DialogTrigger>
      <DialogContent title={secret ? "Webhook criado" : "Novo webhook"} size="md">
        {secret ? (
          <>
            <SecretOnce id="webhook-segredo" label="O segredo de assinatura" secret={secret} />
            <p className="text-[13px] text-ink-2">
              Cada entrega vem com o header <code>X-Duckzap-Signature</code> (HMAC-SHA256 do corpo com este segredo). Confira a
              assinatura antes de aceitar o evento.
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="primary">Já copiei</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await createWebhookAction({ url, events });
                if (result.ok) setSecret(result.data.signingSecret);
                else setError(result.error);
              });
            }}
          >
            <div>
              <Label htmlFor="webhook-url">URL que recebe os eventos</Label>
              <Input id="webhook-url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://seusite.com.br/webhooks/duckzap" />
            </div>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-semibold">Eventos</legend>
              {webhookEventSchema.options.map((event) => (
                <label key={event} className="flex min-h-11 items-center gap-2.5">
                  <Checkbox checked={events.includes(event)} onChange={(e) => setEvents((s) => toggle(s, event, e.target.checked))} />
                  {eventLabels[event]} <code className="text-xs text-ink-2">{event}</code>
                </label>
              ))}
            </fieldset>
            {error ? (
              <Alert tone="err" live>
                {error}
              </Alert>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button>Cancelar</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Criando…" : "Criar webhook"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WebhookRow({ webhook, timeZone }: { webhook: Webhook; timeZone: string }) {
  const [pending, startTransition] = useTransition();
  const [testing, startTesting] = useTransition();
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  return (
    <tr className={cn(!webhook.active && "opacity-75")}>
      <Td>
        <code className="break-all text-[13px]">{webhook.url}</code>
        <p className="text-xs text-ink-2">
          {webhook.events.map((e) => eventLabels[e]).join(", ")} · segredo ••••{webhook.secretLast4}
        </p>
        {notice ? (
          <p role="status" className={cn("mt-1 text-xs font-semibold", notice.tone === "ok" ? "text-ok" : "text-err")}>
            {notice.text}
          </p>
        ) : null}
      </Td>
      <Td>
        {webhook.lastDelivery ? (
          <span className="flex flex-col gap-1">
            <Chip tone={webhook.lastDelivery.ok ? "ok" : "err"} className="self-start">
              {webhook.lastDelivery.statusCode}
            </Chip>
            <span className="text-xs text-ink-2">{formatDate(webhook.lastDelivery.at, dateTime, timeZone)}</span>
          </span>
        ) : (
          <span className="text-ink-2">Nenhuma</span>
        )}
      </Td>
      <Td>
        <label className="flex items-center gap-2">
          <Switch
            checked={webhook.active}
            disabled={pending}
            onCheckedChange={(active) =>
              startTransition(async () => {
                const result = await setWebhookActiveAction(webhook.id, active);
                if (!result.ok) setNotice({ tone: "err", text: result.error });
              })
            }
            aria-label={`${webhook.active ? "Desativar" : "Ativar"} webhook ${webhook.url}`}
          />
          <span className="text-[13px]">{webhook.active ? "Ativo" : "Desativado"}</span>
        </label>
      </Td>
      <Td>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button
            size="sm"
            disabled={testing || !webhook.active}
            title={webhook.active ? undefined : "Ative o webhook para testar"}
            onClick={() =>
              startTesting(async () => {
                const result = await testWebhookAction(webhook.id);
                if (!result.ok) setNotice({ tone: "err", text: result.error });
                else
                  setNotice(
                    result.data.ok
                      ? { tone: "ok", text: `Teste entregue: ${result.data.statusCode} em ${result.data.durationMs} ms.` }
                      : { tone: "err", text: `Seu servidor respondeu ${result.data.statusCode}. Confira a URL e os logs.` },
                  );
              })
            }
          >
            {testing ? "Enviando…" : "Testar"}
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" className="text-err" aria-label={`Excluir webhook ${webhook.url}`}>
                Excluir
              </Button>
            }
            title="Excluir este webhook?"
            description="Os eventos deixam de ser enviados para esta URL."
            confirmLabel="Excluir"
            danger
            onConfirm={() => deleteWebhookAction(webhook.id)}
          />
        </div>
      </Td>
    </tr>
  );
}

export function WebhooksSection({ webhooks, timeZone }: { webhooks: Webhook[]; timeZone: string }) {
  return (
    <Card className="col-span-full flex flex-col gap-3 p-5 max-sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold">Webhooks</h3>
          <p className="text-[13px] text-ink-2">Receba eventos do Duckzap no seu sistema. Toda entrega é assinada.</p>
        </div>
        <CreateWebhookDialog />
      </div>
      {webhooks.length ? (
        <Table minWidth={760}>
          <thead>
            <tr>
              <Th>URL e eventos</Th>
              <Th>Última entrega</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Ações</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {webhooks.map((webhook) => (
              <WebhookRow key={webhook.id} webhook={webhook} timeZone={timeZone} />
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState icon="globe" title="Nenhum webhook" description="Cadastre uma URL para receber mensagens, agendamentos e outros eventos." />
      )}
    </Card>
  );
}
