import { can } from "@duckzap/contracts/permissions";
import { Page } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import { requireSession } from "@/features/auth/session";
import { listProducts } from "@/features/catalog/api";
import { CatalogBoard } from "@/features/catalog/components/catalog-board";

export const metadata: Metadata = { title: "Catálogo" };

export default async function CatalogPage() {
  const session = await requireSession();
  const { products, limit } = await listProducts();

  return (
    <Page>
      <CatalogBoard products={products} limit={limit} canManage={can(session.user.role, "catalog.manage")} />
    </Page>
  );
}
