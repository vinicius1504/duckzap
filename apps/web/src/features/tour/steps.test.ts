import { navTourAnchor } from "@duckzap/ui/shell";
import { describe, expect, it } from "vitest";
import { navFor, webNav } from "../../config/nav";
import {
  AGENT_STEPS,
  isWorthShowing,
  MANAGER_STEPS,
  resolveTourSteps,
  shouldStartTour,
  stepsForRole,
  TOUR_ANCHORS,
  tourSeenKey,
} from "./steps";

const ids = (steps: readonly { id: string }[]) => steps.map((s) => s.id);
const all = () => true;

/** Âncoras visíveis no computador (rail) para o papel, mais o cartão Primeiros passos. */
function desktop(role: "owner" | "admin" | "agent", extra: string[] = [TOUR_ANCHORS.checklist]) {
  const anchors = new Set([...navFor(role).items.map((i) => navTourAnchor(i.href)), ...extra]);
  return (anchor: string) => anchors.has(anchor);
}

/** Celular: só a tab bar (itens `mobile: "tab"` + Mais). */
function mobile(extra: string[] = [TOUR_ANCHORS.checklist]) {
  const tabs = webNav.items.filter((i) => "mobile" in i && i.mobile === "tab").map((i) => navTourAnchor(i.href));
  const anchors = new Set([...tabs, navTourAnchor(webNav.moreHref), ...extra]);
  return (anchor: string) => anchors.has(anchor);
}

describe("tour guiado: passos", () => {
  it("as âncoras de menu batem com as rotas do menu (o shell gera nav-<rota>)", () => {
    const navAnchors = new Set([...webNav.items.map((i) => navTourAnchor(i.href)), navTourAnchor(webNav.moreHref)]);
    for (const anchor of Object.values(TOUR_ANCHORS)) {
      if (anchor.startsWith("nav-")) expect(navAnchors.has(anchor)).toBe(true);
    }
    expect(navTourAnchor("/conversas")).toBe("nav-conversas");
    expect(navTourAnchor("/ajustes/conta/")).toBe("nav-ajustes-conta");
  });

  it("dono no computador: 7 passos, na ordem, sem o Mais", () => {
    const steps = resolveTourSteps(stepsForRole("owner"), desktop("owner"));
    expect(ids(steps)).toEqual(["conversations", "agents", "channels", "catalog", "contacts", "checklist", "help"]);
  });

  it("administrador vê o mesmo tour do dono", () => {
    expect(stepsForRole("admin")).toBe(MANAGER_STEPS);
    expect(ids(resolveTourSteps(MANAGER_STEPS, desktop("admin")))).toHaveLength(7);
  });

  it("dono no celular: pula o que está recolhido e mostra o Mais", () => {
    const steps = resolveTourSteps(stepsForRole("owner"), mobile());
    expect(ids(steps)).toEqual(["conversations", "contacts", "more", "checklist"]);
  });

  it("cartão Primeiros passos escondido: o passo some", () => {
    const steps = resolveTourSteps(MANAGER_STEPS, desktop("owner", []));
    expect(ids(steps)).not.toContain("checklist");
  });

  it("atendente: tour menor, com assumir/transferir sem destaque", () => {
    expect(stepsForRole("agent")).toBe(AGENT_STEPS);
    expect(ids(resolveTourSteps(AGENT_STEPS, desktop("agent", [])))).toEqual(["conversations", "take-over", "contacts", "help"]);
    expect(ids(resolveTourSteps(AGENT_STEPS, mobile([])))).toEqual(["conversations", "take-over", "contacts", "more"]);
  });

  it("nunca devolve passo com âncora ausente", () => {
    const steps = resolveTourSteps(MANAGER_STEPS, () => false);
    expect(steps).toEqual([]);
    expect(isWorthShowing(resolveTourSteps(AGENT_STEPS, () => false))).toBe(false);
    expect(isWorthShowing(resolveTourSteps(AGENT_STEPS, all))).toBe(true);
  });

  it("consulta cada âncora uma vez só", () => {
    let calls = 0;
    resolveTourSteps(MANAGER_STEPS, () => {
      calls += 1;
      return true;
    });
    expect(calls).toBe(new Set(MANAGER_STEPS.flatMap((s) => [s.anchor, ...(s.onlyIfMissing ?? [])]).filter(Boolean)).size);
  });

  it("textos curtos e com título", () => {
    for (const step of [...MANAGER_STEPS, ...AGENT_STEPS]) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.description.length).toBeLessThanOrEqual(160);
      expect(step.description).not.toMatch(/[<>&]/); // o driver.js escreve como HTML
    }
  });
});

describe("tour guiado: quando roda", () => {
  const base = { pathname: "/inicio", seen: false, forced: false, blocked: false };

  it("primeira vez no Início", () => {
    expect(shouldStartTour(base)).toBe(true);
    expect(shouldStartTour({ ...base, seen: true })).toBe(false);
  });

  it("rever pelo botão roda mesmo já visto", () => {
    expect(shouldStartTour({ ...base, seen: true, forced: true })).toBe(true);
  });

  it("fora do Início ou com algo bloqueando, não roda", () => {
    expect(shouldStartTour({ ...base, pathname: "/conversas" })).toBe(false);
    expect(shouldStartTour({ ...base, blocked: true, forced: true })).toBe(false);
  });

  it("chave de visto por pessoa", () => {
    expect(tourSeenKey("u1")).toBe("duckchat:tour-seen:v1:u1");
    expect(tourSeenKey("u1")).not.toBe(tourSeenKey("u2"));
  });
});
