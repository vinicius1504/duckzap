import type { HomeSetup } from "@duckzap/contracts/home";
import { can, type Permission } from "@duckzap/contracts/permissions";
import type { MemberRole } from "@duckzap/contracts/session";
import type { IconName } from "@duckzap/ui/components/icon";

// Regras puras do cartão "Primeiros passos" do Início (sem React, sem servidor): quais itens cada papel vê,
// o que já está feito e quando o cartão pode sumir.

/** `required` = sem isso o atendimento não funciona; `recommended` = segurança; `optional` = ajuda, mas não trava. */
export type SetupKind = "required" | "recommended" | "optional";

export type SetupItem = {
  id: keyof HomeSetup;
  title: string;
  /** O que fazer, em uma linha (aparece enquanto está pendente). */
  hint: string;
  href: string;
  /** Texto do link para a tela. */
  action: string;
  icon: IconName;
  kind: SetupKind;
  /** Sem esta permissão o item não aparece (a pessoa não conseguiria fazer). `null` = todo mundo. */
  permission: Permission | null;
  done: boolean;
};

type ItemDef = Omit<SetupItem, "done">;

/** Ordem = ordem sugerida para fazer. */
export const SETUP_ITEMS: readonly ItemDef[] = [
  {
    id: "whatsappConnected",
    title: "Conectar o WhatsApp",
    hint: "Leia o QR Code com o celular do negócio.",
    href: "/canais",
    action: "Ir para Canais",
    icon: "qr",
    kind: "required",
    permission: "channel.manage",
  },
  {
    id: "activeAgent",
    title: "Ativar um agente de IA",
    hint: "É ele quem responde seus clientes.",
    href: "/agentes",
    action: "Ir para Agentes",
    icon: "bot",
    kind: "required",
    permission: "agent.manage",
  },
  {
    id: "businessHours",
    title: "Definir o horário de atendimento",
    hint: "Os dias e horas em que a empresa atende.",
    href: "/ajustes?aba=empresa",
    action: "Ir para Ajustes",
    icon: "clock",
    kind: "required",
    permission: "settings.manage",
  },
  {
    id: "hasConversation",
    title: "Receber a primeira conversa",
    hint: "Mande um “oi” de outro celular para o seu WhatsApp e veja a resposta.",
    href: "/conversas",
    action: "Ver conversas",
    icon: "chat",
    kind: "required",
    permission: "channel.manage",
  },
  {
    id: "twoFactorEnabled",
    title: "Ativar a verificação em duas etapas",
    hint: "Protege sua conta mesmo se alguém descobrir a senha. Pelo app autenticador ou por código no e-mail.",
    href: "/ajustes?aba=conta",
    action: "Ir para Minha conta",
    icon: "shield",
    kind: "recommended",
    permission: null,
  },
  {
    id: "hasProduct",
    title: "Cadastrar um produto ou serviço",
    hint: "A IA usa o catálogo para tirar dúvidas e passar preços.",
    href: "/catalogo",
    action: "Ir para Catálogo",
    icon: "tag",
    kind: "optional",
    permission: "catalog.manage",
  },
  {
    id: "teamInvited",
    title: "Convidar sua equipe",
    hint: "Quem vai atender junto com você.",
    href: "/equipe",
    action: "Ir para Equipe",
    icon: "users",
    kind: "optional",
    permission: "team.manage",
  },
];

export const setupKindLabel: Record<SetupKind, string | null> = {
  required: null,
  recommended: "Recomendado",
  optional: "Opcional",
};

export type SetupChecklist = {
  items: SetupItem[];
  doneCount: number;
  total: number;
  /** 0 a 100, inteiro. */
  percent: number;
  /** Todos os itens obrigatórios QUE A PESSOA VÊ estão feitos (vale "sim" se ela não vê nenhum). */
  requiredDone: boolean;
  /** Tudo o que a pessoa vê está feito. */
  allDone: boolean;
};

/** Monta o checklist do papel: só os itens que ele pode fazer, cada um marcado com o dado da API. */
export function buildSetupChecklist(setup: HomeSetup, role: MemberRole): SetupChecklist {
  const items = SETUP_ITEMS.filter((item) => item.permission === null || can(role, item.permission)).map((item) => ({
    ...item,
    done: setup[item.id],
  }));
  const doneCount = items.filter((i) => i.done).length;
  const total = items.length;
  return {
    items,
    doneCount,
    total,
    percent: total === 0 ? 100 : Math.round((doneCount / total) * 100),
    requiredDone: items.every((i) => i.kind !== "required" || i.done),
    allDone: doneCount === total,
  };
}

/**
 * O cartão aparece? Some quando não há nada para a pessoa fazer, ou quando ela dispensou depois de concluir os
 * obrigatórios. Antes disso não dá para dispensar: sem eles o sistema não atende.
 */
export function shouldShowChecklist(list: SetupChecklist, dismissed: boolean): boolean {
  if (list.total === 0 || list.allDone) return false;
  return !(list.requiredDone && dismissed);
}

/** Pode mostrar o botão "Esconder"? */
export const canDismissChecklist = (list: SetupChecklist) => list.requiredDone && !list.allDone;
