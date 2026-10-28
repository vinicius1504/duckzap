// Arquivos de empresas que já não existem (runbook: docs/runbooks/midia.md). Apagar a empresa leva `media_files` junto (cascata),
// mas os OBJETOS ficam no bucket sob `org/<id>/`. Este script os acha e apaga por prefixo.
//
//   pnpm --filter @duckzap/api media:orphans                        lista empresas com arquivos no bucket que não existem mais
//   pnpm --filter @duckzap/api media:orphans --purge org_abc        mostra quantos objetos/bytes seriam apagados (nada é apagado)
//   pnpm --filter @duckzap/api media:orphans --purge org_abc --yes  apaga de verdade (recusa empresa que ainda existe)
//
// Usa MEDIA_STORAGE_* e DATABASE_URL do .env. Imprime só ids de empresa e contagens: nunca chaves de objeto, nomes de arquivo ou URLs.
import { createDb, schema } from "@duckzap/db";
import { inArray } from "drizzle-orm";
import { createS3Storage, loadStorageConfig } from "../src/lib/storage";
import { orgPrefix } from "../src/modules/media/logic";

const config = loadStorageConfig();
if (!config) throw new Error("Defina MEDIA_STORAGE_ENDPOINT, MEDIA_STORAGE_BUCKET, MEDIA_STORAGE_ACCESS_KEY_ID e MEDIA_STORAGE_SECRET_ACCESS_KEY no .env.");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Defina DATABASE_URL no .env.");

const storage = createS3Storage(config);
const { db, close } = createDb(databaseUrl, { max: 1 });
const args = process.argv.slice(2);
const purgeIndex = args.indexOf("--purge");
const target = purgeIndex >= 0 ? args[purgeIndex + 1] : undefined;
const yes = args.includes("--yes");
const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

async function existing(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: schema.organization.id }).from(schema.organization).where(inArray(schema.organization.id, ids));
  return new Set(rows.map((r) => r.id));
}

try {
  if (purgeIndex >= 0) {
    if (!target || !/^[A-Za-z0-9_-]{3,64}$/.test(target)) throw new Error("Informe o id da empresa: --purge <id>.");
    if ((await existing([target])).has(target)) throw new Error("Essa empresa ainda existe: apague os arquivos pelo app (exclusão de contato) ou apague a empresa antes.");
    const prefix = orgPrefix(target);
    const found = await storage.countPrefix(prefix);
    console.log(`${target}: ${found.objects} objeto(s), ${mb(found.bytes)}.`);
    if (!yes) console.log("Nada foi apagado. Rode de novo com --yes para apagar.");
    else console.log(`Apagados: ${await storage.deletePrefix(prefix)} objeto(s).`);
  } else {
    const prefixes = await storage.listPrefixes("org/");
    const ids = prefixes.map((p) => p.slice("org/".length, -1));
    const alive = await existing(ids);
    const orphans = ids.filter((id) => !alive.has(id));
    console.log(`Empresas com arquivos no bucket: ${ids.length} (sem empresa correspondente: ${orphans.length}).`);
    for (const id of orphans) {
      const found = await storage.countPrefix(orgPrefix(id));
      console.log(`  ${id}: ${found.objects} objeto(s), ${mb(found.bytes)}`);
    }
    if (orphans.length > 0) console.log("Para apagar: pnpm --filter @duckzap/api media:orphans --purge <id> --yes");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Falhou.");
  process.exitCode = 1;
} finally {
  await close();
}
