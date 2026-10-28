# SQL cru da Agenda e de Clientes (para o orquestrador juntar na migration)

O Drizzle não expressa extensões nem restrições de exclusão. Acrescente à migration **depois** de criar as tabelas.

## Extensões

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- já criada em docker/postgres/init; os índices gin_trgm_ops de contacts dependem dela
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- NOVA: necessária para a restrição de exclusão abaixo (text com "=" dentro de GiST)
```

`btree_gist` vem no pacote contrib da imagem `pgvector/pgvector:0.8.7-pg17`; basta o `CREATE EXTENSION`
(papel dono/superuser; o `duckzap_app` não precisa). Se o provedor de produção não oferecer a extensão, a restrição
pode ser omitida: o service já faz a checagem transacional (com `pg_advisory_xact_lock` por empresa+responsável).

## Restrição de exclusão (conflito de horário no banco)

```sql
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    owner_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status <> 'canceled' AND NOT allow_conflict);
```

Por que o `allow_conflict` no filtro: o produto deixa a pessoa salvar mesmo com aviso de conflito
(`allowConflict: true` no formulário). Linhas gravadas assim ficam fora da restrição; todas as demais
(o caminho normal) nunca se sobrepõem no mesmo responsável, mesmo sob concorrência.
O service trata o erro `23P01` (exclusion_violation) como conflito (409) e devolve os agendamentos que batem.
Cancelados não ocupam horário; concluídos ocupam (mesma regra de `blocksTime` no contrato).

## Índices de busca (já declarados no schema Drizzle)

`contacts_{name,phone,email}_trgm_idx` usam `gin (... gin_trgm_ops)`. O `drizzle-kit generate` já os emite com
`gin_trgm_ops`; só confira que `pg_trgm` existe antes da migration.

## Pendências de integração (FKs entre módulos)

- `consents.channel_id` → tabela de canais (módulo Canais), quando existir.
- Conversas/mensagens que referenciam `contacts.id` devem usar `ON DELETE CASCADE` (exclusão LGPD do titular)
  ou registrar um gancho com `registerContactErasureHook` (`apps/api/src/modules/contacts/service.ts`).
