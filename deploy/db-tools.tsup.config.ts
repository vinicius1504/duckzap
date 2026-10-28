// Empacota os scripts de banco (migrations e papéis) em JS puro para viajar dentro da imagem da API:
// `node db/scripts/migrate.js` e `node db/scripts/setup-roles.js`, sem tsx nem devDependencies em produção.
// Usado só pelo apps/api/Dockerfile (rodando a partir de apps/api). Sem import de `tsup` de propósito: este arquivo
// fica fora de qualquer pacote e não enxergaria o módulo.
export default {
  entry: ["../../packages/db/scripts/migrate.ts", "../../packages/db/scripts/setup-roles.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "/out/db/scripts",
  clean: false,
  sourcemap: false,
  splitting: false,
  // tudo embutido (postgres, drizzle-orm): a imagem não precisa de node_modules para estes dois scripts
  noExternal: [/./],
};
