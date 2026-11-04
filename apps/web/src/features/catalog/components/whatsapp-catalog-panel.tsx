"use client";

import { formatPriceBRL, type WhatsappCatalog, type WhatsappCatalogProduct, type WhatsappImportResult } from "@duckzap/contracts/catalog";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { ConfirmDialog } from "@duckzap/ui/components/confirm-dialog";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Select } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Label } from "@duckzap/ui/components/input";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatPlural } from "@/lib/format";
import { importWhatsappAction, loadWhatsappCatalogAction } from "../actions";

/** Quantos motivos de "não importado" aparecem de uma vez (o resto vira "e mais N"). */
const SKIPPED_SHOWN = 5;

const NOTICE =
  "Estes produtos vêm do catálogo do WhatsApp Business. Para cadastrar ou editar, use o app WhatsApp Business no celular (Ferramentas → Catálogo) e depois clique em Atualizar aqui. O que você importar passa a ser oferecido pela IA.";

/** Aba "WhatsApp Business": lê o catálogo do número conectado e importa para o sistema. Só monta (e só busca) quando a aba está aberta. */
export function WhatsappCatalogPanel() {
  const [catalog, setCatalog] = useState<WhatsappCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** `externalId` do item em importação, ou "all". */
  const [importing, setImporting] = useState<string | null>(null);
  const [result, setResult] = useState<WhatsappImportResult | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  /** Só a resposta da última busca vale (trocar de número ou clicar duas vezes não mistura listas). */
  const lastRequest = useRef(0);

  const load = useCallback(async (channelId?: string) => {
    const request = ++lastRequest.current;
    setLoading(true);
    setError(null);
    const response = await loadWhatsappCatalogAction(channelId);
    if (request !== lastRequest.current) return;
    setLoading(false);
    if ("error" in response) return setError(response.error);
    setCatalog(response.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const channelId = catalog?.channelId ?? null;
  const busy = loading || importing !== null;

  function changeChannel(next: string) {
    setResult(null);
    setCatalog((current) => (current ? { ...current, products: [] } : current));
    void load(next);
  }

  async function runImport(input: { externalIds: string[] } | { all: true }, key: string) {
    if (!channelId) return { error: "Escolha um número do WhatsApp." };
    setImporting(key);
    setError(null);
    setResult(null);
    const response = await importWhatsappAction({ channelId, ...input });
    setImporting(null);
    if ("error" in response) {
      // em "Importar todos" o erro aparece dentro da confirmação; aqui só nos itens
      if (key !== "all") setError(response.error);
      return { error: response.error };
    }
    setResult(response.data);
    void load(channelId);
    return { ok: true } as const;
  }

  const importable = catalog?.state === "ok" && catalog.products.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{NOTICE}</Alert>

      {catalog && catalog.channels.length > 1 ? (
        <div className="max-w-md">
          <Label htmlFor="wa-numero">Número do WhatsApp</Label>
          <Select id="wa-numero" value={channelId ?? ""} onChange={(e) => changeChannel(e.target.value)} disabled={busy}>
            {catalog.channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.address ? `${channel.name} · ${channel.address}` : channel.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {catalog ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void load(channelId ?? undefined)} disabled={busy} aria-label="Atualizar lista do catálogo do WhatsApp">
            <Icon name="refresh" size={16} />
            {loading ? "Atualizando…" : "Atualizar"}
          </Button>
          {importable ? (
            <Button variant="primary" onClick={() => setConfirmAll(true)} disabled={busy}>
              <Icon name="download" size={16} />
              {importing === "all" ? "Importando…" : "Importar todos"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Alert
          tone="err"
          live
          action={
            catalog ? undefined : (
              <Button size="sm" onClick={() => void load()} disabled={loading}>
                {loading ? "Atualizando…" : "Tentar de novo"}
              </Button>
            )
          }
        >
          {error}
        </Alert>
      ) : null}

      {result ? <ImportFeedback result={result} /> : null}

      {!catalog ? (
        loading ? (
          <p className="text-ink-2" role="status">
            Atualizando…
          </p>
        ) : null
      ) : (
        <CatalogBody
          catalog={catalog}
          loading={loading}
          busy={busy}
          importing={importing}
          onRetry={() => void load(channelId ?? undefined)}
          onImport={(product) => void runImport({ externalIds: [product.externalId] }, product.externalId)}
        />
      )}

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Importar todos os produtos?"
        description="Os produtos que já foram importados serão atualizados com o que está no WhatsApp Business, e os que saíram do catálogo do WhatsApp serão desligados aqui (a IA deixa de oferecê-los)."
        confirmLabel="Importar todos"
        pendingLabel="Importando…"
        onConfirm={() => runImport({ all: true }, "all")}
      />
    </div>
  );
}

function CatalogBody({
  catalog,
  loading,
  busy,
  importing,
  onRetry,
  onImport,
}: {
  catalog: WhatsappCatalog;
  loading: boolean;
  busy: boolean;
  importing: string | null;
  onRetry: () => void;
  onImport: (product: WhatsappCatalogProduct) => void;
}) {
  if (catalog.state === "no_channel") {
    return (
      <Card>
        <EmptyState
          compact
          icon="qr"
          title="Nenhum WhatsApp conectado"
          description="Conecte um WhatsApp por QR Code em Canais para ver o catálogo."
          action={
            <Link href="/canais" className={buttonVariants({ variant: "primary" })}>
              Ir para Canais
            </Link>
          }
        />
      </Card>
    );
  }
  if (catalog.state === "channel_disconnected") {
    return (
      <Card>
        <EmptyState
          compact
          icon="alert"
          title="WhatsApp desconectado"
          description="Este WhatsApp está desconectado. Reconecte em Canais e atualize."
          action={
            <Link href="/canais" className={buttonVariants()}>
              Ir para Canais
            </Link>
          }
        />
      </Card>
    );
  }
  if (catalog.state === "not_business") {
    return (
      <Card>
        <EmptyState
          compact
          icon="info"
          title="Este número não tem catálogo"
          description="Este número não é do WhatsApp Business, então não tem catálogo. Para usar, instale o app WhatsApp Business e conecte esse número."
        />
      </Card>
    );
  }
  if (catalog.state === "unavailable") {
    return (
      <Card>
        <EmptyState
          compact
          icon="alert"
          title="Catálogo indisponível"
          description="Não conseguimos ler o catálogo agora. Tente de novo em instantes."
          action={
            <Button onClick={onRetry} disabled={busy}>
              {loading ? "Atualizando…" : "Tentar de novo"}
            </Button>
          }
        />
      </Card>
    );
  }
  if (catalog.products.length === 0) {
    return loading ? (
      <p className="text-ink-2" role="status">
        Atualizando…
      </p>
    ) : (
      <Card>
        <EmptyState compact icon="tag" title="Catálogo vazio" description="Nenhum produto no catálogo do WhatsApp Business ainda." />
      </Card>
    );
  }
  return (
    <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]" aria-busy={loading || undefined}>
      {catalog.products.map((product) => (
        <li key={product.externalId} className="min-w-0">
          <WhatsappProductCard product={product} busy={busy} importing={importing === product.externalId} onImport={() => onImport(product)} />
        </li>
      ))}
    </ul>
  );
}

function WhatsappProductCard({
  product,
  busy,
  importing,
  onImport,
}: {
  product: WhatsappCatalogProduct;
  busy: boolean;
  importing: boolean;
  onImport: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const imported = product.productId !== null;
  const showImage = product.imageUrl !== null && !imageFailed;
  return (
    <Card padding="sm" className="flex h-full flex-col gap-3">
      <div className="flex min-w-0 gap-3">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line bg-surface-2">
          {showImage ? (
            // URL assinada do WhatsApp (expira): <img> simples; se não carregar, volta ao ícone
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.imageUrl ?? undefined}
              alt={`Foto de ${product.name}`}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setImageFailed(true)}
              className="size-full object-cover"
            />
          ) : (
            <Icon name="image" size={24} className="text-ink-2" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-bold" title={product.name}>
            {product.name}
          </h2>
          <p className="font-semibold">{product.priceCents === null ? <span className="text-ink-2">Sob consulta</span> : formatPriceBRL(product.priceCents)}</p>
          {product.imageCount > 1 ? <p className="text-xs text-ink-2">{product.imageCount} fotos</p> : null}
        </div>
      </div>
      {product.description ? <p className="line-clamp-3 text-[13px] text-ink-2">{product.description}</p> : <p className="text-[13px] italic text-ink-2">Sem descrição.</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {imported ? (
          <Chip tone="ok">
            <Icon name="check" size={14} />
            Importado
          </Chip>
        ) : null}
        {!product.available ? <Chip tone="neutral">Indisponível</Chip> : null}
        <Button className="ml-auto" onClick={onImport} disabled={busy} aria-label={imported ? `Atualizar ${product.name} no sistema` : `Importar ${product.name}`}>
          {importing ? "Importando…" : imported ? "Atualizar" : "Importar"}
        </Button>
      </div>
    </Card>
  );
}

function ImportFeedback({ result }: { result: WhatsappImportResult }) {
  const parts = [
    result.created > 0 ? `${formatPlural(result.created, "produto novo", "produtos novos")}` : null,
    result.updated > 0 ? `${formatPlural(result.updated, "atualizado", "atualizados")}` : null,
    result.turnedOff > 0 ? `${formatPlural(result.turnedOff, "desligado", "desligados")} (saíram do catálogo do WhatsApp)` : null,
  ].filter((part): part is string => part !== null);
  const summary = parts.length > 0 ? `Pronto: ${parts.join(", ")}.` : result.skipped.length > 0 ? "Nada foi importado." : "Tudo já estava em dia.";
  const extra = result.skipped.length - SKIPPED_SHOWN;
  return (
    <div className="flex flex-col gap-2" role="status">
      <Alert tone={parts.length > 0 ? "ok" : "info"}>{summary}</Alert>
      {result.skipped.slice(0, SKIPPED_SHOWN).map((item) => (
        <Alert key={item.externalId} tone="warn">
          “{item.name}” não foi importado: {item.reason}
        </Alert>
      ))}
      {extra > 0 ? <p className="text-[13px] text-ink-2">e mais {formatPlural(extra, "produto não importado", "produtos não importados")}.</p> : null}
    </div>
  );
}
