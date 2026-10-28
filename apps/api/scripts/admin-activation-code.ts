// Gera o código de ativação do 1º acesso de um admin do painel (cadastro do 2FA). Imprime UMA vez; não fica guardado em lugar nenhum.
// Uso: pnpm --filter @duckzap/api exec tsx --env-file-if-exists=.env scripts/admin-activation-code.ts admin@empresa.com
// Precisa de ADMIN_DATABASE_URL (ou DATABASE_ADMIN_URL) e de ENCRYPTION_KEY no ambiente. Ver docs/runbooks/primeiro-admin.md.
import { createDb, schema } from "@duckzap/db";
import { sql } from "drizzle-orm";
import { activationCodeFor } from "../src/modules/admin/activation";

const email = process.argv[2]?.trim().toLowerCase();
const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!email) throw new Error("Informe o e-mail do admin: ... admin-activation-code.ts admin@empresa.com");
if (!url) throw new Error("Defina ADMIN_DATABASE_URL (ou DATABASE_ADMIN_URL).");

const { db, close } = createDb(url, { max: 1 });
try {
  const [admin] = await db
    .select({ id: schema.platformAdmins.id, totp: schema.platformAdmins.totpSecretEnc, active: schema.platformAdmins.active })
    .from(schema.platformAdmins)
    .where(sql`lower(${schema.platformAdmins.email}) = ${email}`)
    .limit(1);
  if (!admin) throw new Error("Admin não encontrado.");
  if (admin.totp) throw new Error("Este admin já cadastrou o 2FA: não precisa de código de ativação.");
  console.log(`Código de ativação (anote agora e entregue por outro canal; só vale até o 2FA ser cadastrado):\n\n  ${activationCodeFor(admin.id)}\n`);
} finally {
  await close();
}
