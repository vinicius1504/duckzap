import { buttonVariants } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { hrefWith, type SearchParams } from "@/lib/url";

/** Paginação por link (?pagina=N): funciona sem JS e mantém os filtros. */
export function Pagination({
  path,
  params,
  page,
  pageCount,
  total,
  noun,
}: {
  path: string;
  params: SearchParams;
  page: number;
  pageCount: number;
  total: number;
  noun: [one: string, many: string];
}) {
  if (total === 0) return null;
  const prev =
    page > 1 ? hrefWith(path, params, { pagina: page - 1 === 1 ? null : page - 1 }) : null;
  const next = page < pageCount ? hrefWith(path, params, { pagina: page + 1 }) : null;
  const disabled = "pointer-events-none opacity-50";

  return (
    <nav
      aria-label="Paginação"
      className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-2"
    >
      <p>
        {total} {total === 1 ? noun[0] : noun[1]} · página {page} de {pageCount}
      </p>
      <div className="flex gap-2">
        {prev ? (
          <Link href={prev} className={buttonVariants({ size: "sm" })}>
            <Icon name="chevronLeft" size={16} /> Anterior
          </Link>
        ) : (
          <span aria-disabled="true" className={cn(buttonVariants({ size: "sm" }), disabled)}>
            <Icon name="chevronLeft" size={16} /> Anterior
          </span>
        )}
        {next ? (
          <Link href={next} className={buttonVariants({ size: "sm" })}>
            Próxima <Icon name="chevronRight" size={16} />
          </Link>
        ) : (
          <span aria-disabled="true" className={cn(buttonVariants({ size: "sm" }), disabled)}>
            Próxima <Icon name="chevronRight" size={16} />
          </span>
        )}
      </div>
    </nav>
  );
}
