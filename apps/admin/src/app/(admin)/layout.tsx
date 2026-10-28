import type { ReactNode } from "react";
import { AdminShellFrame } from "@/components/shell-frame";
import { requireAdminSession } from "@/features/auth/session";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await requireAdminSession();
  return <AdminShellFrame session={session}>{children}</AdminShellFrame>;
}
