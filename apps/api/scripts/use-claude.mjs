// Liga o Claude como IA principal e passa a IA que estava como principal (ex.: Groq) para RESERVA.
// Só mantém a troca se o teste real (llm:smoke) passar; se falhar, devolve o .env como estava.
// Nunca imprime chaves.
//
// Uso (na pasta do projeto), com a chave só nesta execução:
//   PowerShell:  $env:CLAUDE_KEY = "sk-ant-..."; node apps/api/scripts/use-claude.mjs
//   Git Bash:    CLAUDE_KEY="sk-ant-..." node apps/api/scripts/use-claude.mjs
//
// Modelos: LLM_MODEL_FAST e LLM_MODEL_SMART viram claude-haiku-5-5 (o mais barato). Para melhorar a qualidade das
// respostas depois, troque só LLM_MODEL_SMART para claude-sonnet-5-5 no apps/api/.env.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, "..");
const envFile = join(apiDir, ".env");
const key = (process.env.CLAUDE_KEY ?? "").trim();

if (!key.startsWith("sk-ant-")) {
  console.error('Defina CLAUDE_KEY com a chave da Anthropic (começa com "sk-ant-"). Exemplo no cabeçalho deste arquivo.');
  process.exit(1);
}
if (!existsSync(envFile)) {
  console.error("apps/api/.env não existe.");
  process.exit(1);
}

const original = readFileSync(envFile, "utf8");
const lines = original.split(/\r?\n/);
const get = (name) => {
  const line = lines.find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : "";
};
const set = (name, value) => {
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
};

const current = { provider: get("LLM_PROVIDER"), key: get("LLM_API_KEY"), smart: get("LLM_MODEL_SMART"), fast: get("LLM_MODEL_FAST") };

// o que era principal vira reserva (a não ser que o principal já fosse o Claude: aí a reserva atual fica como está)
if (current.provider && current.provider !== "anthropic" && current.provider !== "fake" && current.key) {
  set("LLM_FALLBACK_PROVIDER", current.provider);
  set("LLM_FALLBACK_API_KEY", current.key);
  set("LLM_FALLBACK_MODEL_SMART", current.smart);
  set("LLM_FALLBACK_MODEL_FAST", current.fast);
}
set("LLM_PROVIDER", "anthropic");
set("LLM_API_KEY", key);
set("LLM_MODEL_SMART", "claude-haiku-5-5");
set("LLM_MODEL_FAST", "claude-haiku-5-5");
writeFileSync(envFile, lines.join("\n"));

console.log("Configuração gravada. Testando de verdade (3 chamadas curtas ao Claude)...");
const smoke = spawnSync("pnpm", ["--filter", "@duckzap/api", "llm:smoke"], { cwd: join(apiDir, "..", ".."), shell: true, encoding: "utf8" });
const out = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`;
const ok = smoke.status === 0 && out.includes("stop=tool_use");

if (!ok) {
  writeFileSync(envFile, original);
  // sem eco da chave: só as linhas relevantes do resultado
  const hint = out.split(/\r?\n/).filter((l) => /Provedor|\[fast\]|\[smart\]|\[tool\]|code:|Error|invalid|auth|credit|balance/i.test(l)).slice(0, 8).join("\n");
  console.error("O teste falhou; o .env foi restaurado como estava.\n" + hint);
  process.exit(1);
}

const hint = out.split(/\r?\n/).filter((l) => /Provedor|\[fast\]|\[smart\]|\[tool\]/.test(l)).join("\n");
console.log(hint);
console.log("\nPronto: Claude (Haiku 5.5) é o principal e a IA anterior ficou como reserva. Reinicie a API (pnpm dev).");
