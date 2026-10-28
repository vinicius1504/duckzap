"use client";

// Último recurso (erro no layout raiz): substitui o <html>, então não há CSS global nem tokens; estilo mínimo inline.
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <main
          role="alert"
          style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16, textAlign: "center" }}
        >
          <div>
            <h1 style={{ fontSize: 22 }}>Serviço indisponível</h1>
            <p>Algo deu errado ao carregar o DuckChat. Seus dados estão seguros.</p>
            <button
              type="button"
              onClick={() => retry()}
              style={{ minHeight: 44, padding: "0 20px", borderRadius: 10, border: "1px solid #888", cursor: "pointer" }}
            >
              Tentar de novo
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
