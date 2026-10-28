import { z } from "zod";
import { LlmError, type GenerateRequest, type GenerateResult, type LLMProvider, type ModelNames } from "./llm";

/**
 * Configuração de IA por ambiente. Troca de provedor = mudar `LLM_PROVIDER` e os modelos.
 * Padrão do produto: Claude (`claude-sonnet-5-5` nos agentes, `claude-haiku-5-5` no que é rápido).
 */
export const llmEnvSchema = z.object({
  LLM_PROVIDER: z.enum(["anthropic", "openai", "gemini", "groq", "fake"]).default("fake"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL_SMART: z.string().default("claude-sonnet-5-5"),
  LLM_MODEL_FAST: z.string().default("claude-haiku-5-5"),
  /** Modelo das tarefas raras de qualidade (gerador de perfil do agente). Vazio = usa LLM_MODEL_SMART. */
  LLM_MODEL_BEST: z.string().optional(),
  /** Modelo de reserva (outro provedor ou outro modelo) usado quando o principal falha de forma repetível. */
  LLM_FALLBACK_PROVIDER: z.enum(["anthropic", "openai", "gemini", "groq", "fake"]).optional(),
  /** Chave e modelos da reserva (outro provedor tem outra chave e outros nomes de modelo). Sem eles, usa os do principal. */
  LLM_FALLBACK_API_KEY: z.string().optional(),
  LLM_FALLBACK_MODEL_SMART: z.string().optional(),
  LLM_FALLBACK_MODEL_FAST: z.string().optional(),
  LLM_FALLBACK_MODEL_BEST: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Esforço de raciocínio (provedor Claude): baixo = mais barato. Padrão: roteador `low`, resposta `medium`. */
  LLM_EFFORT_FAST: z.enum(["low", "medium", "high"]).optional(),
  LLM_EFFORT_SMART: z.enum(["low", "medium", "high"]).optional(),
  LLM_EFFORT_BEST: z.enum(["low", "medium", "high"]).optional(),
});
export type LlmEnv = z.infer<typeof llmEnvSchema>;

export type ProviderFactory = (config: {
  apiKey?: string;
  models: ModelNames;
  timeoutMs: number;
  effort?: { fast?: "low" | "medium" | "high"; smart?: "low" | "medium" | "high"; best?: "low" | "medium" | "high" };
}) => LLMProvider;

const factories = new Map<string, ProviderFactory>();

/** Cada adaptador se registra aqui (ver `providers/`). Código do produto nunca importa o adaptador. */
export function registerProvider(name: string, factory: ProviderFactory) {
  factories.set(name, factory);
}

export function createLlm(env: LlmEnv): LLMProvider {
  const build = (name: string, own?: { apiKey?: string; smart?: string; fast?: string; best?: string }) => {
    const factory = factories.get(name);
    if (!factory) throw new Error(`Provedor de IA "${name}" não está registrado.`);
    return factory({
      apiKey: own?.apiKey ?? env.LLM_API_KEY,
      models: {
        smart: own?.smart ?? env.LLM_MODEL_SMART,
        fast: own?.fast ?? env.LLM_MODEL_FAST,
        best: own ? (own.best ?? own.smart) : env.LLM_MODEL_BEST,
      },
      timeoutMs: env.LLM_TIMEOUT_MS,
      effort: { fast: env.LLM_EFFORT_FAST, smart: env.LLM_EFFORT_SMART, best: env.LLM_EFFORT_BEST },
    });
  };
  const primary = build(env.LLM_PROVIDER);
  if (!env.LLM_FALLBACK_PROVIDER || env.LLM_FALLBACK_PROVIDER === env.LLM_PROVIDER) return primary;
  return withFallback(primary, build(env.LLM_FALLBACK_PROVIDER, { apiKey: env.LLM_FALLBACK_API_KEY, smart: env.LLM_FALLBACK_MODEL_SMART, fast: env.LLM_FALLBACK_MODEL_FAST, best: env.LLM_FALLBACK_MODEL_BEST }));
}

/** Erro repetível (timeout, sobrecarga, limite) → tenta o provedor de reserva (§4.3). */
export function withFallback(primary: LLMProvider, backup: LLMProvider): LLMProvider {
  return {
    name: `${primary.name}+${backup.name}`,
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      try {
        return await primary.generate(request);
      } catch (error) {
        if (error instanceof LlmError && error.retryable) return backup.generate(request);
        throw error;
      }
    },
  };
}

/**
 * Chamar no boot (apps/api/src/index.ts). Em produção o provedor `fake`/demo é proibido (responderia aos
 * clientes com texto roteirizado), assim como o fallback `fake`; provedor real exige chave.
 */
export function assertLlmConfigForEnv(env: { NODE_ENV?: string; LLM_PROVIDER?: string; LLM_FALLBACK_PROVIDER?: string; LLM_API_KEY?: string }) {
  if (env.NODE_ENV !== "production") return;
  const provider = env.LLM_PROVIDER ?? "fake";
  if (provider === "fake") {
    throw new Error('LLM_PROVIDER=fake não pode ser usado em produção. Configure "anthropic", "openai" ou "gemini" e LLM_API_KEY.');
  }
  if (env.LLM_FALLBACK_PROVIDER === "fake") {
    throw new Error("LLM_FALLBACK_PROVIDER=fake não pode ser usado em produção.");
  }
  if (!env.LLM_API_KEY) {
    throw new Error(`LLM_API_KEY é obrigatória em produção (provedor ${provider}).`);
  }
}
