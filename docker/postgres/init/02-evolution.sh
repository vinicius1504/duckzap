#!/bin/sh
# Banco e usuário separados para a Evolution: ela não enxerga o banco do app.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pwd="$EVOLUTION_DB_PASSWORD" <<'SQL'
CREATE ROLE evolution LOGIN PASSWORD :'pwd';
CREATE DATABASE evolution OWNER evolution;
REVOKE ALL ON DATABASE duckzap FROM PUBLIC;
SQL
