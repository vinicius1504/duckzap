import type { MemberRole } from "@duckzap/contracts/session";

/**
 * Tour guiado do app (primeira entrada depois do cadastro). Só lógica pura: quais passos, para quem, quais existem
 * na tela e a chave de "já vi". Quem desenha é `components/product-tour.tsx` (driver.js, carregado só quando roda).
 *
 * Âncoras: `data-tour="..."`. Os itens de menu ganham `nav-<rota>` no shell (`navTourAnchor`), no rail do computador e
 * na tab bar do celular; o cartão "Primeiros passos" tem `setup-checklist`.
 */

export type TourAudience = "manager" | "agent";

export type TourStep = {
  id: string;
  /** `data-tour` do elemento destacado; `null` = popover no centro da tela (sem destaque). */
  anchor: string | null;
  title: string;
  description: string;
  /** Só entra se faltar alguma destas âncoras (ex.: "Mais" no celular, onde Agentes/Canais/Ajuda não aparecem). */
  onlyIfMissing?: readonly string[];
};

export const TOUR_ANCHORS = {
  conversations: "nav-conversas",
  agents: "nav-agentes",
  channels: "nav-canais",
  catalog: "nav-catalogo",
  contacts: "nav-clientes",
  more: "nav-mais",
  help: "nav-ajuda",
  checklist: "setup-checklist",
} as const;

const A = TOUR_ANCHORS;

const moreStep = (hidden: readonly string[], description: string): TourStep => ({
  id: "more",
  anchor: A.more,
  title: "Mais opções",
  description,
  onlyIfMissing: hidden,
});

const helpStep: TourStep = {
  id: "help",
  anchor: A.help,
  title: "Ajuda",
  description: "Perguntas frequentes, assistente e suporte. Por aqui também dá para fazer este tour de novo.",
};

/** Dono e administrador: o caminho de configurar e acompanhar o atendimento. */
export const MANAGER_STEPS: readonly TourStep[] = [
  {
    id: "conversations",
    anchor: A.conversations,
    title: "Conversas",
    description: "Aqui chegam as mensagens do WhatsApp. Você vê o que a IA respondeu e pode entrar na conversa quando quiser.",
  },
  {
    id: "agents",
    anchor: A.agents,
    title: "Agentes",
    description: "É onde você ensina a IA: o que ela responde, o jeito de falar e quando chamar alguém da equipe.",
  },
  {
    id: "channels",
    anchor: A.channels,
    title: "Canais",
    description: "O seu WhatsApp conectado. Se ele cair, você reconecta por aqui.",
  },
  {
    id: "catalog",
    anchor: A.catalog,
    title: "Catálogo",
    description: "Produtos e serviços com preço. A IA usa essas informações para responder os clientes.",
  },
  {
    id: "contacts",
    anchor: A.contacts,
    title: "Clientes",
    description: "Todo mundo que já falou com você, com o histórico das conversas.",
  },
  moreStep(
    [A.agents, A.channels, A.catalog, A.help],
    "No celular, Agentes, Canais, Catálogo, Ajuda e o resto do menu ficam aqui.",
  ),
  {
    id: "checklist",
    anchor: A.checklist,
    title: "Primeiros passos",
    description: "O que ainda falta para o atendimento funcionar bem. Siga a lista no seu ritmo.",
  },
  helpStep,
];

/** Atendente: responder, assumir e transferir. */
export const AGENT_STEPS: readonly TourStep[] = [
  {
    id: "conversations",
    anchor: A.conversations,
    title: "Conversas",
    description: "Aqui chegam as mensagens do WhatsApp. A IA responde primeiro e chama a equipe quando precisa.",
  },
  {
    // assumir/transferir só existe dentro de uma conversa aberta: explica sem destacar nada
    id: "take-over",
    anchor: null,
    title: "Assumir ou transferir",
    description:
      "Abra uma conversa e toque em “Assumir conversa” para responder você mesmo. Se outra pessoa deve continuar, use “Transferir”.",
  },
  {
    id: "contacts",
    anchor: A.contacts,
    title: "Clientes",
    description: "Todo mundo que já falou com a empresa, com o histórico das conversas.",
  },
  moreStep([A.help], "No celular, a Ajuda e o resto do menu ficam aqui."),
  helpStep,
];

export function tourAudience(role: MemberRole): TourAudience {
  return role === "agent" ? "agent" : "manager";
}

export function stepsForRole(role: MemberRole): readonly TourStep[] {
  return tourAudience(role) === "agent" ? AGENT_STEPS : MANAGER_STEPS;
}

/**
 * Passos que dá para mostrar agora: tira os de âncora ausente/escondida (menu recolhido no celular, cartão escondido,
 * item que o papel não vê) e os condicionais cujas âncoras estão todas na tela. Nunca devolve âncora inexistente.
 */
export function resolveTourSteps(steps: readonly TourStep[], isPresent: (anchor: string) => boolean): TourStep[] {
  const present = new Map<string, boolean>();
  const has = (anchor: string) => {
    if (!present.has(anchor)) present.set(anchor, isPresent(anchor));
    return present.get(anchor) ?? false;
  };
  return steps.filter((step) => {
    if (step.anchor !== null && !has(step.anchor)) return false;
    if (step.onlyIfMissing && step.onlyIfMissing.every(has)) return false;
    return true;
  });
}

/** Tour que só tem o passo sem destaque não ensina nada: não roda. */
export function isWorthShowing(steps: readonly TourStep[]): boolean {
  return steps.some((step) => step.anchor !== null);
}

/** "Já vi o tour", por pessoa (no mesmo navegador várias pessoas podem entrar). */
export function tourSeenKey(userId: string): string {
  return `duckchat:tour-seen:v1:${userId}`;
}

export const TOUR_HOME_PATH = "/inicio";
/** `/inicio?tour=1`: pedido explícito para rever (botão em Ajuda). */
export const TOUR_QUERY = "tour";

export function shouldStartTour(input: { pathname: string; seen: boolean; forced: boolean; blocked: boolean }): boolean {
  if (input.blocked || input.pathname !== TOUR_HOME_PATH) return false;
  return input.forced || !input.seen;
}

/** Contador do driver.js ("2 de 6"). */
export const TOUR_PROGRESS_TEXT = "{{current}} de {{total}}";
