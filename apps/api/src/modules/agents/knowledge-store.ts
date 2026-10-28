import type { EmbeddingProvider, KnowledgeHit, KnowledgePort, Scope } from "@duckzap/ai";
import { keywords } from "@duckzap/ai";
import { withOrg, type Database, type Transaction } from "@duckzap/db";
import { sql } from "drizzle-orm";

/**
 * Busca de conhecimento no Postgres (RLS via withOrg): full-text 'portuguese' (OU entre as palavras, com prefixo)
 * + similaridade trigram como reserva + (opcional) distância de embedding. Funciona sem embeddings.
 * Depende da migration (tabelas e extensões pg_trgm/vector): testes de integração só rodam depois dela.
 */

type Row = { id: string; document_name: string | null; content: string; score: number };

/** Monta a consulta `to_tsquery` só com [a-z0-9] — nada do usuário vira operador. */
export function buildTsQuery(query: string) {
  return keywords(query)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 3)
    .map((w) => `${w}:*`)
    .join(" | ");
}

export async function searchKnowledgeTx(
  tx: Transaction,
  agentId: string,
  query: string,
  limit: number,
  embedding?: number[],
): Promise<KnowledgeHit[]> {
  const tsQuery = buildTsQuery(query);
  const vec = embedding ? `[${embedding.join(",")}]` : null;
  const rows = await tx.execute<Row>(sql`
    select c.id::text as id, d.name as document_name, c.content,
      (
        case when ${tsQuery} <> '' then ts_rank(c.search_vector, to_tsquery('portuguese', ${tsQuery})) else 0 end
        + similarity(c.content, ${query}) * 0.5
        ${vec ? sql`+ (1 - (c.embedding <=> ${vec}::vector))` : sql``}
      )::float8 as score
    from knowledge_chunks c
    left join agent_documents d on d.id = c.document_id
    where c.agent_id = ${agentId}::uuid
      and (
        (${tsQuery} <> '' and c.search_vector @@ to_tsquery('portuguese', ${tsQuery}))
        or similarity(c.content, ${query}) > 0.12
        ${vec ? sql`or c.embedding is not null` : sql``}
      )
    order by score desc
    limit ${limit}
  `);
  return rows.filter((r) => r.score > 0.02).map((r) => ({ id: r.id, documentName: r.document_name, text: r.content, score: r.score }));
}

export function createDbKnowledgePort(db: Database, embedder?: EmbeddingProvider): KnowledgePort {
  return {
    async search(scope: Scope, query: string, limit: number) {
      let embedding: number[] | undefined;
      if (embedder) {
        try {
          embedding = (await embedder.embed([query]))[0];
        } catch {
          embedding = undefined; // sem embedding, segue com texto
        }
      }
      return withOrg(db, scope.organizationId, (tx) => searchKnowledgeTx(tx, scope.agentId, query, limit, embedding));
    },
  };
}
