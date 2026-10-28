# SQL do módulo Agentes que o Drizzle não gera

Para o orquestrador juntar na migration única. Nada disto foi executado.

## 1. Extensões (ANTES de criar as tabelas do módulo)

`knowledge_chunks` usa índice trigram (`gin_trgm_ops`) e a coluna `vector(1536)` + índice HNSW (`vector_cosine_ops`).
Sem as extensões, o `CREATE TABLE`/`CREATE INDEX` falha. Coloque no topo da migration (ou rode como dono do banco):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;   -- imagem pgvector/pgvector:0.8.7-pg17 (docker-compose.local.yml já usa)
```

Criar extensão exige o papel dono/superusuário (`DATABASE_ADMIN_URL`), nunca o `duckzap_app`.
Em produção (VPS), usar a mesma imagem com pgvector; se não houver pgvector, remova `embedding` e o índice
`knowledge_chunks_embedding_idx` do schema (a busca funciona sem eles).

## 2. Coluna `search_vector` (gerada)

O Drizzle declara `search_vector tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED`.
Confira no SQL gerado que a expressão ficou `to_tsvector('portuguese', content)` (config literal = imutável, permitida em coluna gerada).
Se o `drizzle-kit` emitir a expressão com aspas diferentes e falhar, use:

```sql
ALTER TABLE knowledge_chunks DROP COLUMN search_vector;
ALTER TABLE knowledge_chunks
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED;
CREATE INDEX knowledge_chunks_search_vector_idx ON knowledge_chunks USING gin (search_vector);
```

Acentos: o dicionário `portuguese` faz stemming mas não remove acentos. A busca do módulo combina full-text com
`similarity()` (trigram), que cobre variações de acento. Opcional (melhora recall): `CREATE EXTENSION unaccent` e
indexar `to_tsvector('portuguese', unaccent(content))` (exige wrapper IMMUTABLE).

## 3. Índices que dependem das extensões (já declarados no Drizzle; listados para conferência)

```sql
CREATE INDEX knowledge_chunks_content_trgm_idx ON knowledge_chunks USING gin (content gin_trgm_ops);
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
```

## 4. Permissões / RLS

Nada extra: `pnpm db:roles` concede `select/insert/update/delete` ao `duckzap_app` nas tabelas novas (default privileges)
e todas as tabelas do módulo têm `ENABLE ROW LEVEL SECURITY` + policy `*_tenant_isolation`
(coberto por `packages/db/test/rls-coverage.test.ts`).

## 5. Observação sobre FKs (integração)

FKs fechadas na integração: `copilot_feedback.agent_id/message_id`, `ai_usage_log.agent_id`, `conversation_ai_events.agent_id`
e `conversation_suggestions.agent_id` apontam para `agents`/`messages` com `ON DELETE SET NULL`. `agents.channel_ids` foi REMOVIDA:
o vínculo agente↔canal vive só em `channels.agent_id` (idem `teams.channel_ids`/`teams.agent_id` → `channels.team_id`).
`agents.teams` (nomes, texto) segue como rótulo livre. `conversation_id` das tabelas de log/feedback continua texto sem FK
de propósito: o gancho de exclusão de contato (`conversations/erasure.ts`) as apaga (LGPD).
