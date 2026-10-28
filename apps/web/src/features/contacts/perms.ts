import { can } from "@duckzap/contracts/permissions";
import type { MemberRole } from "@duckzap/contracts/session";

/** O que o papel pode fazer em Clientes. Só esconde/desabilita: quem autoriza é a Server Action. */
export function contactPerms(role: MemberRole) {
  return {
    edit: can(role, "contact.edit"),
    import: can(role, "contact.import"),
    export: can(role, "contact.export"),
    delete: can(role, "contact.delete"),
    bulk: can(role, "contact.bulk"),
    /** Etiquetas, listas e segmentos: a matriz não tem permissão própria; usa contact.bulk. */
    organize: can(role, "contact.bulk"),
    invite: can(role, "campaign.send"),
  };
}

export type ContactPerms = ReturnType<typeof contactPerms>;

export const NO_PERMISSION_HINT = "Seu papel não permite. Fale com um administrador.";
