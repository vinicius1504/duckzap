"use client";

import { CATALOG_LIMITS, formatPriceBRL, type Product } from "@duckzap/contracts/catalog";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { ConfirmDialog } from "@duckzap/ui/components/confirm-dialog";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Input } from "@duckzap/ui/components/input";
import { PageHeader } from "@duckzap/ui/components/layout";
import { Switch } from "@duckzap/ui/components/switch";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { formatPlural } from "@/lib/format";
import { deleteProductAction, setAvailabilityAction } from "../actions";
import { ProductFormDialog } from "./product-form-dialog";

/** Acima disto a busca por nome aparece (lista curta não precisa dela). */
const SEARCH_FROM = 8;

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function CatalogBoard({ products, limit, canManage }: { products: Product[]; limit: number; canManage: boolean }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Interruptor otimista: vale até a lista nova chegar do servidor (ou voltar atrás se a ação falhar). */
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [, startTransition] = useTransition();

  useEffect(() => setAvailability({}), [products]);

  const full = products.length >= limit;
  const shown = useMemo(() => {
    const q = normalize(query.trim());
    return q ? products.filter((p) => normalize(p.name).includes(q)) : products;
  }, [products, query]);

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(product: Product) {
    setEditing(product);
    setFormOpen(true);
  }

  function toggle(product: Product, available: boolean) {
    setError(null);
    setAvailability((a) => ({ ...a, [product.id]: available }));
    startTransition(async () => {
      const result = await setAvailabilityAction(product.id, available);
      if ("error" in result) {
        setAvailability((a) => {
          const { [product.id]: _undo, ...rest } = a;
          return rest;
        });
        setError(result.error);
      }
    });
  }

  async function confirmDelete() {
    if (!deleting) return { error: "Produto não encontrado." };
    const result = await deleteProductAction(deleting.id);
    if ("error" in result) return { error: result.error };
    router.refresh();
    return { ok: true } as const;
  }

  return (
    <>
      <PageHeader
        title="Catálogo"
        description="A IA usa estes produtos para responder, mandar foto e deixar o interesse de compra para a equipe."
        actions={
          canManage ? (
            <Button variant="primary" onClick={openNew} disabled={full} title={full ? `Limite de ${limit} produtos` : undefined}>
              <Icon name="plus" size={16} />
              Novo produto
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Chip tone={full ? "warn" : "neutral"} aria-live="polite">
          {products.length} de {formatPlural(limit, "produto", "produtos")}
        </Chip>
        {full ? <span className="text-[13px] text-ink-2">Limite atingido: exclua um produto para cadastrar outro.</span> : null}
        {products.length >= SEARCH_FROM ? (
          <div className="ml-auto w-full sm:w-72">
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nome" aria-label="Buscar produto por nome" autoComplete="off" />
          </div>
        ) : null}
      </div>

      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}

      {products.length === 0 ? (
        <Card>
          <EmptyState
            icon="tag"
            title="Nenhum produto cadastrado"
            description={
              canManage
                ? `Cadastre o que você vende (até ${CATALOG_LIMITS.maxProducts} produtos, com até ${CATALOG_LIMITS.maxImages} fotos cada). Modelos diferentes são produtos separados.`
                : "Quem administra a conta pode cadastrar os produtos aqui."
            }
            action={
              canManage ? (
                <Button variant="primary" onClick={openNew}>
                  <Icon name="plus" size={16} />
                  Cadastrar o primeiro produto
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon="search" title="Nenhum produto com esse nome" description="Confira a grafia ou limpe a busca." />
        </Card>
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]">
          {shown.map((product) => {
            const available = availability[product.id] ?? product.available;
            const cover = product.images[0];
            const coverUrl = cover?.thumbnailUrl ?? cover?.url ?? null;
            return (
              <li key={product.id} className="min-w-0">
                <Card padding="sm" className="flex h-full flex-col gap-3">
                  <div className="flex min-w-0 gap-3">
                    <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line bg-surface-2">
                      {coverUrl ? (
                        // URL assinada de outro domínio: <img> simples (next/image não serve)
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={coverUrl} alt={`Foto de ${product.name}`} loading="lazy" decoding="async" className="size-full object-cover" />
                      ) : (
                        <Icon name="image" size={24} className="text-ink-2" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-bold" title={product.name}>
                        {product.name}
                      </h2>
                      <p className="font-semibold">{product.priceCents === null ? <span className="text-ink-2">Sob consulta</span> : formatPriceBRL(product.priceCents)}</p>
                      {product.images.length > 1 ? <p className="text-xs text-ink-2">{product.images.length} fotos</p> : null}
                    </div>
                  </div>
                  {product.description ? <p className="line-clamp-3 text-[13px] text-ink-2">{product.description}</p> : <p className="text-[13px] italic text-ink-2">Sem descrição.</p>}
                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    {canManage ? (
                      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-[13px] font-semibold">
                        <Switch checked={available} onCheckedChange={(next) => toggle(product, next)} aria-label={`${product.name}: disponível`} />
                        {available ? "Disponível" : "Indisponível"}
                      </label>
                    ) : (
                      <Chip tone={available ? "ok" : "neutral"}>{available ? "Disponível" : "Indisponível"}</Chip>
                    )}
                    {canManage ? (
                      <div className="ml-auto flex gap-1.5">
                        <Button size="icon" variant="ghost" className="size-9" onClick={() => openEdit(product)} aria-label={`Editar ${product.name}`}>
                          <Icon name="edit" size={16} />
                        </Button>
                        <Button size="icon" variant="danger-ghost" className="size-9" onClick={() => setDeleting(product)} aria-label={`Excluir ${product.name}`}>
                          <Icon name="trash" size={16} />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? <ProductFormDialog open={formOpen} onOpenChange={setFormOpen} product={editing} /> : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Excluir produto?"
        description={deleting ? `“${deleting.name}” e as fotos dele serão apagados. A IA deixa de oferecê-lo.` : undefined}
        confirmLabel="Excluir"
        pendingLabel="Excluindo…"
        danger
        onConfirm={confirmDelete}
      />
    </>
  );
}
