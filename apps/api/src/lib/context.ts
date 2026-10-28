import type { LLMProvider } from "@duckzap/ai";
import type { Database } from "@duckzap/db";
import type { Auth } from "../auth";
import type { Env } from "../env";

/** Dependências injetadas nas rotas (facilita teste e evita singletons). */
export type Deps = { env: Env; db: Database; auth: Auth; llm: LLMProvider };

export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

export type AppBindings = { Variables: { requestId: string; authSession: AuthSession } };
