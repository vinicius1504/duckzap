import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/** Rota atual (o proxy grava `x-pathname`). Vazio se não houver. */
export async function currentPathname() {
  return (await headers()).get("x-pathname") ?? "";
}

export function isSettingsPath(pathname: string) {
  return pathname === "/ajustes" || pathname.startsWith("/ajustes/");
}

/**
 * A API devolve 403 com um destes códigos quando o portão de acesso barra a conta:
 * - `account_suspended`: assinatura vencida (depois da tolerância). O layout mostra a tela de suspensão.
 * - `two_factor_required`: dono/administrador precisa ativar o 2FA. Só Ajustes → Minha conta fica liberado.
 * Chamar isto antes de tratar qualquer outro 403. Dentro de Ajustes não redireciona (evita laço).
 */
export async function handleAccessGate(code: string) {
  if (code === "account_suspended") {
    if (!isSettingsPath(await currentPathname())) redirect("/inicio");
    return;
  }
  if (code === "two_factor_required") {
    if (!isSettingsPath(await currentPathname())) redirect("/ajustes?aba=conta");
  }
}
