import { defineConfig } from "vitest/config";

// Os testes de integração falam com o Postgres de teste e criam empresas próprias. Rodar 50+ arquivos ao mesmo tempo
// (um worker por arquivo) esgotava os 5 s padrão por pura carga. Mais tempo por teste e menos arquivos em paralelo
// deixam a suíte estável sem esconder lentidão real (o relatório mostra a duração de cada arquivo).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 6,
  },
});
