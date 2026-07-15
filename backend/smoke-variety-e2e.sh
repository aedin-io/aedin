#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

DB="${SMOKE_DB:-${TMPDIR:-/tmp}/globi-variety-e2e.sqlite}"
PROD_DB="${PROD_DB:-/home/beef/projects/agroeco/backend/globi.sqlite}"

if [ ! -f "$PROD_DB" ]; then
  echo "ERROR: production DB not found at $PROD_DB"
  exit 1
fi

echo "==> copy production DB → $DB"
cp "$PROD_DB" "$DB"

echo "==> point worktree backend/globi.sqlite at $DB"
ln -sfn "$DB" "$(pwd)/globi.sqlite"
trap 'rm -f "$(pwd)/globi.sqlite"' EXIT

echo "==> apply migration 037"
node migrations/037_variety_dedup_log.js

echo "==> insert a fake near-duplicate variety pair under Solanum lycopersicum"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1]);
// scientific_name has a UNIQUE constraint — variety rows use a compound name
// e.g. \"Solanum lycopersicum 'Variety Name'\" as scientific_name
const tomato = db.prepare(\"SELECT id FROM entities WHERE scientific_name='Solanum lycopersicum' AND variety_name IS NULL LIMIT 1\").get();
if (!tomato) { console.error('no Solanum lycopersicum species row'); process.exit(1); }
console.log('tomato species id =', tomato.id);
// Two rows with distinct scientific_name but near-dup variety_name (case-only diff → dist=0)
db.prepare(\`INSERT INTO entities (scientific_name, variety_name, parent_entity_id, bio_category, primary_role, needs_dedup, source_table, created_at, updated_at)
             VALUES (?, ?, ?, 'plantae', 'crop', 1, 'smoke-test', datetime('now','subsecond'), datetime('now','subsecond'))\`).run(
  \"Solanum lycopersicum 'Smoke Test Solar Fire'\", 'Smoke Test Solar Fire', tomato.id);
db.prepare(\`INSERT INTO entities (scientific_name, variety_name, parent_entity_id, bio_category, primary_role, needs_dedup, source_table, created_at, updated_at)
             VALUES (?, ?, ?, 'plantae', 'crop', 1, 'smoke-test', datetime('now','+1 second'), datetime('now','+1 second'))\`).run(
  \"Solanum lycopersicum 'smoke test solar fire'\", 'smoke test solar fire', tomato.id);
console.log('inserted 2 near-dup variety rows');
" "$DB"

echo "==> run dedup-varieties (dry-run first)"
node dedup-varieties.js --dry-run

echo "==> run dedup-varieties (real)"
node dedup-varieties.js

echo "==> sanity counts"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], {readonly:true});
const merges = db.prepare(\"SELECT COUNT(*) c FROM variety_dedup_log\").get().c;
const remaining = db.prepare(\"SELECT COUNT(*) c FROM entities WHERE variety_name LIKE '%moke%est%olar%' AND parent_entity_id IS NOT NULL\").get().c;
console.log('variety_dedup_log rows:', merges);
console.log('remaining smoke-test variety rows:', remaining);
if (merges < 1) { console.error('FAIL: expected at least 1 merge'); process.exit(1); }
if (remaining !== 1) { console.error('FAIL: expected 1 row remaining, got', remaining); process.exit(1); }
console.log('==> SMOKE TEST PASSED');
" "$DB"
