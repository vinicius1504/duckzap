import { businessHoursSchema, serviceSettingsSchema } from "@duckzap/contracts/settings";
import { describe, expect, it } from "vitest";
import { defaultBusinessHours, defaultServiceSettings, isValidTimeZone } from "./defaults";
import { overLimitMessage } from "./service";

const essencial = { name: "Essencial", limits: { channels: 2, users: 2, agents: 1 } };
const escala = { name: "Escala", limits: { channels: 15, users: 20, agents: null } };

describe("troca de plano (regra de uso x limite)", () => {
  it("aceita quando o uso cabe", () => {
    expect(overLimitMessage({ channels: 2, users: 2, agents: 1 }, essencial)).toBeNull();
    expect(overLimitMessage({ channels: 9, users: 9, agents: 99 }, escala)).toBeNull();
  });

  it("recusa downgrade acima do uso e diz o que reduzir", () => {
    const message = overLimitMessage({ channels: 3, users: 4, agents: 3 }, essencial);
    expect(message).toContain("Essencial");
    expect(message).toContain("3 canais (limite 2)");
    expect(message).toContain("4 usuários (limite 2)");
    expect(message).toContain("3 agentes (limite 1)");
  });

  it("limite nulo é ilimitado", () => {
    expect(overLimitMessage({ channels: 0, users: 0, agents: 500 }, escala)).toBeNull();
  });
});

describe("padrões de Ajustes", () => {
  it("horário e atendimento padrão passam nos schemas do contrato", () => {
    expect(businessHoursSchema.safeParse(defaultBusinessHours()).success).toBe(true);
    expect(serviceSettingsSchema.safeParse(defaultServiceSettings()).success).toBe(true);
  });

  it("valida fuso horário", () => {
    expect(isValidTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimeZone("Marte/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
