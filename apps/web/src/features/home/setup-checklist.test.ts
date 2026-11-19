import type { HomeSetup } from "@duckzap/contracts/home";
import { describe, expect, it } from "vitest";
import { buildSetupChecklist, canDismissChecklist, SETUP_ITEMS, shouldShowChecklist } from "./setup-checklist";

const none: HomeSetup = {
  whatsappConnected: false,
  activeAgent: false,
  businessHours: false,
  hasProduct: false,
  teamInvited: false,
  hasConversation: false,
  twoFactorEnabled: false,
};
const required: HomeSetup = { ...none, whatsappConnected: true, activeAgent: true, businessHours: true, hasConversation: true };
const all: HomeSetup = { whatsappConnected: true, activeAgent: true, businessHours: true, hasProduct: true, teamInvited: true, hasConversation: true, twoFactorEnabled: true };

describe("checklist Primeiros passos", () => {
  it("cobre cada fato da API uma vez, com link interno", () => {
    expect(SETUP_ITEMS.map((i) => i.id).sort()).toEqual(Object.keys(none).sort());
    for (const item of SETUP_ITEMS) expect(item.href.startsWith("/")).toBe(true);
  });

  it("proprietário e administrador veem os 7 itens; nada feito = 0%", () => {
    for (const role of ["owner", "admin"] as const) {
      const list = buildSetupChecklist(none, role);
      expect(list.total).toBe(7);
      expect(list).toMatchObject({ doneCount: 0, percent: 0, requiredDone: false, allDone: false });
    }
  });

  it("atendente só vê a verificação em duas etapas (nada de administração)", () => {
    const list = buildSetupChecklist(none, "agent");
    expect(list.items.map((i) => i.id)).toEqual(["twoFactorEnabled"]);
    // sem obrigatórios visíveis: pode esconder desde já
    expect(list.requiredDone).toBe(true);
    expect(canDismissChecklist(list)).toBe(true);
    expect(shouldShowChecklist(list, false)).toBe(true);
    expect(shouldShowChecklist(list, true)).toBe(false);
    expect(shouldShowChecklist(buildSetupChecklist(all, "agent"), false)).toBe(false);
  });

  it("marca feitos, calcula o progresso e mantém a ordem sugerida", () => {
    const list = buildSetupChecklist({ ...none, whatsappConnected: true, twoFactorEnabled: true }, "owner");
    expect(list.doneCount).toBe(2);
    expect(list.percent).toBe(29);
    expect(list.items[0]).toMatchObject({ id: "whatsappConnected", done: true });
    expect(list.items.find((i) => i.id === "activeAgent")?.done).toBe(false);
  });

  it("com obrigatório pendente, o cartão não pode ser escondido", () => {
    const list = buildSetupChecklist({ ...required, hasConversation: false }, "owner");
    expect(list.requiredDone).toBe(false);
    expect(canDismissChecklist(list)).toBe(false);
    // mesmo que o navegador lembre um "Esconder" antigo
    expect(shouldShowChecklist(list, true)).toBe(true);
  });

  it("obrigatórios feitos: aparece até esconder; tudo feito: some sozinho", () => {
    const partial = buildSetupChecklist(required, "owner");
    expect(partial).toMatchObject({ requiredDone: true, allDone: false, doneCount: 4 });
    expect(canDismissChecklist(partial)).toBe(true);
    expect(shouldShowChecklist(partial, false)).toBe(true);
    expect(shouldShowChecklist(partial, true)).toBe(false);

    const done = buildSetupChecklist(all, "owner");
    expect(done).toMatchObject({ allDone: true, percent: 100 });
    expect(canDismissChecklist(done)).toBe(false);
    expect(shouldShowChecklist(done, false)).toBe(false);
  });
});
