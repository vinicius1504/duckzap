// Só para o CLI do Better Auth gerar o schema Drizzle (`pnpm auth:schema`). Não conecta no banco.
import { createDb } from "@duckzap/db";
import { createAuth } from "../src/auth";
import { loadEnv } from "../src/env";

const env = loadEnv({
  DATABASE_URL: "postgres://cli@localhost:5432/cli",
  BETTER_AUTH_SECRET: "cli-only-secret-cli-only-secret-cli-only",
});

export const auth = createAuth({ env, db: createDb(env.DATABASE_URL).db, sendMail: async () => {} });
