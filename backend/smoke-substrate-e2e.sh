#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

DB="${SMOKE_DB:-/tmp/globi-substrate-e2e.sqlite}"
PROD_DB=/home/beef/projects/agroeco/backend/globi.sqlite

if [ ! -f "$PROD_DB" ]; then
  echo "ERROR: production DB not found at $PROD_DB"
  exit 1
fi

echo "==> copy production DB → $DB"
cp "$PROD_DB" "$DB"
export DB_PATH="$DB"

echo "==> point worktree's backend/globi.sqlite at $DB"
ln -sfn "$DB" "$(pwd)/globi.sqlite"
trap 'rm -f "$(pwd)/globi.sqlite"' EXIT

echo "==> apply migrations 032-036"
node migrations/032_entity_trait_claims.js
node migrations/033_traits_vocabulary.js
node migrations/034_attractor_interaction_categories.js
node migrations/035_rename_severity_to_impact.js
node migrations/036_critic_verdict_confidence.js

echo "==> backfill"
node backfill-trefle-traits.js
node backfill-existing-staging-crop-enrichment.js
node backfill-other-syncs.js

echo "==> rebuild cache"
node rebuild-entity-cache.js

echo "==> sanity counts"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], {readonly:true});
const rows = [
  ['entity_trait_claims total',      db.prepare('SELECT COUNT(*) c FROM entity_trait_claims').get().c],
  ['  human_verified',               db.prepare(\"SELECT COUNT(*) c FROM entity_trait_claims WHERE review_status='human_verified'\").get().c],
  ['  ai_consensus_verified',        db.prepare(\"SELECT COUNT(*) c FROM entity_trait_claims WHERE review_status='ai_consensus_verified'\").get().c],
  ['  unreviewed',                   db.prepare(\"SELECT COUNT(*) c FROM entity_trait_claims WHERE review_status='unreviewed'\").get().c],
  ['Plutella thermal_min readings',  db.prepare(\"SELECT COUNT(*) c FROM entity_trait_claims etc JOIN entities e ON e.id=etc.entity_id WHERE e.scientific_name='Plutella xylostella' AND etc.trait_name='thermal_min'\").get().c],
  ['v_review_priority rows',         db.prepare('SELECT COUNT(*) c FROM v_review_priority').get().c],
];
for (const [k,v] of rows) console.log(k.padEnd(40,' '),'|',v);
" "$DB"

echo "==> cache fidelity (Trefle ph_min counts)"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], {readonly:true});
const before = db.prepare('SELECT COUNT(*) c FROM entities WHERE ph_min IS NOT NULL').get().c;
const after  = db.prepare(\"SELECT COUNT(*) c FROM entity_trait_claims WHERE trait_name='ph_min'\").get().c;
console.log('before (entities.ph_min non-NULL)         |', before);
console.log('after  (entity_trait_claims ph_min rows)  |', after);
if (before !== after) { console.error('CACHE FIDELITY MISMATCH:', before, '!=', after); process.exit(1); }
" "$DB"

echo "==> SMOKE TEST PASSED"
