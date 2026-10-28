import { defineConfig } from "drizzle-kit";

// migrations rodam com o papel dono do banco (DATABASE_ADMIN_URL); o app usa outro papel, sem BYPASSRLS
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? "" },
  casing: "snake_case",
  strict: true,
});
