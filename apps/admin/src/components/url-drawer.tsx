"use client";

import { Dialog, DialogContent } from "@duckzap/ui/components/dialog";
import { parseAsString, useQueryState } from "nuqs";
import type { ReactNode } from "react";

/**
 * Gaveta lateral aberta por um parâmetro da URL (?empresa=org_x). Fechar remove o parâmetro;
 * o link da linha da tabela abre de novo. Assim dá para compartilhar o link da ficha.
 */
export function UrlDrawer({
  paramKey,
  value,
  title,
  description,
  children,
}: {
  paramKey: string;
  value: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const [current, setCurrent] = useQueryState(
    paramKey,
    parseAsString.withOptions({ scroll: false }),
  );
  return (
    <Dialog
      open={current === value}
      onOpenChange={(open) => {
        if (!open) void setCurrent(null);
      }}
    >
      <DialogContent side="right" title={title} description={description} className="gap-5">
        {children}
      </DialogContent>
    </Dialog>
  );
}
