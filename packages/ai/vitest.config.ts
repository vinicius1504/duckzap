import { defineConfig } from "vitest/config";

// Alguns testes importam o pacote inteiro (SDKs dos provedores) de forma dinâmica; sob carga, com vários arquivos em
// paralelo, esse primeiro import passava dos 5 s padrão e o teste falhava sem ter nada de errado na lógica.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
