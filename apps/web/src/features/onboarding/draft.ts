import "server-only";
import type { OnboardingDraft } from "@duckzap/contracts/onboarding";
import { getDraft } from "./api";

/**
 * LEGADO: o cadastro já guardou o id da pessoa neste cookie (path /comecar, 1 dia). Hoje a fonte é só a SESSÃO
 * (GET /v1/onboarding), então cookie vencido ou navegador limpo não perdem o passo. Só é apagado ("Criar outra conta").
 */
export const LEGACY_ONBOARDING_COOKIE = "dz_onboarding";

/** Cadastro da pessoa logada (null = sem sessão: mostra o formulário de criar conta). */
export async function getCurrentDraft(): Promise<OnboardingDraft | null> {
  return getDraft();
}
