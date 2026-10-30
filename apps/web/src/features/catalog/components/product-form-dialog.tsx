"use client";

import { CATALOG_LIMITS, PRODUCT_NAME_TAKEN, parsePriceToCents, type Product, type ProductImage } from "@duckzap/contracts/catalog";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Textarea } from "@duckzap/ui/components/form-controls";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { attachImageAction, removeImageAction, saveProductAction } from "../actions";
import { usePhotoUploads } from "../use-photo-uploads";
import { ProductPhotos } from "./product-photos";

const PRICE_ERROR = "Valor inválido. Use reais e centavos, ex.: 59,90.";

type Form = { name: string; price: string; description: string; available: boolean };

function fromProduct(p: Product | null): Form {
  return {
    name: p?.name ?? "",
    price: p?.priceCents == null ? "" : (p.priceCents / 100).toFixed(2).replace(".", ","),
    description: p?.description ?? "",
    available: p?.available ?? true,
  };
}

/** Novo produto / editar produto. As fotos novas sobem na hora; viram parte do produto ao salvar. */
export function ProductFormDialog({ open, onOpenChange, product }: { open: boolean; onOpenChange: (open: boolean) => void; product: Product | null }) {
  const router = useRouter();
  const uploads = usePhotoUploads();
  const [form, setForm] = useState<Form>(() => fromProduct(product));
  const [images, setImages] = useState<ProductImage[]>(() => product?.images ?? []);
  /** Id do produto criado nesta abertura: se a anexação das fotos falhar pela metade, salvar de novo EDITA em vez de duplicar. */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const productId = product?.id ?? createdId;

  useEffect(() => {
    if (open) {
      setForm(fromProduct(product));
      setImages(product?.images ?? []);
      setCreatedId(null);
      setError(null);
      setSubmitted(false);
      setRemovingId(null);
    }
    uploads.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const name = form.name.trim();
  const priceCents = form.price.trim() === "" ? null : parsePriceToCents(form.price);
  const priceInvalid = form.price.trim() !== "" && priceCents === null;
  const nameTaken = error === PRODUCT_NAME_TAKEN;

  function removeSaved(image: ProductImage) {
    if (!productId) return;
    setRemovingId(image.id);
    startTransition(async () => {
      const result = await removeImageAction(productId, image.id);
      setRemovingId(null);
      if ("error" in result) return setError(result.error);
      setImages(result.data.images);
      setError(null);
      router.refresh();
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!name || priceInvalid) return setError("Corrija os campos destacados.");
    if (uploads.busy) return setError("Aguarde as fotos terminarem de enviar.");
    if (uploads.failed) return setError("Há foto com erro. Tente enviar de novo ou remova a foto.");
    setError(null);
    startTransition(async () => {
      const saved = await saveProductAction(productId, { name, description: form.description, priceCents, available: form.available });
      if ("error" in saved) return setError(saved.error);
      const id = saved.data.id;
      setCreatedId(id);

      let current = saved.data.images;
      let lost = 0;
      let lastProblem = "";
      for (const photo of uploads.photos) {
        if (!photo.mediaId) continue;
        const attached = await attachImageAction(id, photo.mediaId);
        if ("error" in attached) {
          lost += 1;
          lastProblem = attached.error;
          continue;
        }
        current = attached.data.images;
        uploads.drop(photo.key);
      }
      setImages(current);
      router.refresh();
      if (lost > 0) {
        return setError(`O produto foi salvo, mas ${lost === 1 ? "1 foto não foi adicionada" : `${lost} fotos não foram adicionadas`}: ${lastProblem} Ajuste e salve de novo.`);
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={product ? `Editar ${product.name}` : "Novo produto"} description="A IA usa estes dados para responder, mandar a foto e deixar o interesse de compra para a equipe.">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div>
            <Label htmlFor="pd-nome">Nome</Label>
            <Input
              id="pd-nome"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              maxLength={CATALOG_LIMITS.nameMax}
              required
              autoComplete="off"
              placeholder="Ex.: Camiseta preta M"
              invalid={(submitted && !name) || nameTaken}
              aria-describedby={submitted && !name ? "pd-nome-erro pd-nome-dica" : "pd-nome-dica"}
            />
            {submitted && !name ? <FieldError id="pd-nome-erro" message="Dê um nome ao produto." /> : null}
            <p id="pd-nome-dica" className="mt-1 text-xs text-ink-2">
              Modelos diferentes (tamanho, cor) são produtos separados: cadastre um para cada.
            </p>
          </div>

          <div>
            <Label htmlFor="pd-valor">Valor (R$)</Label>
            <Input
              id="pd-valor"
              inputMode="decimal"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              placeholder="59,90"
              autoComplete="off"
              invalid={priceInvalid && (submitted || form.price.length > 0)}
              aria-describedby={priceInvalid ? "pd-valor-erro pd-valor-dica" : "pd-valor-dica"}
              className="max-w-48"
            />
            {priceInvalid ? <FieldError id="pd-valor-erro" message={PRICE_ERROR} /> : null}
            <p id="pd-valor-dica" className="mt-1 text-xs text-ink-2">
              Deixe vazio para “sob consulta”: a IA não fala valor e chama a equipe.
            </p>
          </div>

          <div>
            <Label htmlFor="pd-desc">Descrição</Label>
            <Textarea
              id="pd-desc"
              rows={4}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              maxLength={CATALOG_LIMITS.descriptionMax}
              placeholder="Material, medidas, cor, o que vem junto… A IA responde dúvidas com isto."
              aria-describedby="pd-desc-conta"
            />
            <p id="pd-desc-conta" className="mt-1 text-right text-xs text-ink-2" aria-live="polite">
              {form.description.length}/{CATALOG_LIMITS.descriptionMax}
            </p>
          </div>

          <ProductPhotos saved={images} uploads={uploads} removingId={removingId} onRemoveSaved={removeSaved} disabled={pending} />

          <label className="flex min-h-11 cursor-pointer items-center gap-2.5">
            <Checkbox checked={form.available} onChange={(e) => set("available", e.target.checked)} />
            Disponível (a IA só oferece produtos disponíveis)
          </label>

          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{createdId ? "Fechar" : "Cancelar"}</Button>
            <Button type="submit" variant="primary" disabled={pending || uploads.busy}>
              {pending ? "Salvando…" : uploads.busy ? "Enviando fotos…" : productId ? "Salvar" : "Criar produto"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
