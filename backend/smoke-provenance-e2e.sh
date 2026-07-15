#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

DB="${SMOKE_DB:-${TMPDIR:-/tmp}/globi-provenance-e2e.sqlite}"
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

echo "==> apply migration 038"
node migrations/038_extractor_runs_and_lessons.js

echo "==> run backfill-extractor-runs (dry run first)"
node backfill-extractor-runs.js --dry-run

echo "==> run backfill-extractor-runs (real)"
node backfill-extractor-runs.js

echo "==> insert 2 synthetic extractor_corrections rows agreeing on a pattern"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1]);
const claim = db.prepare('SELECT id FROM claims LIMIT 1').get();
if (!claim) { console.error('no claims to attach corrections to'); process.exit(1); }
const sql = 'INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id) VALUES (?, ?, ?, ?, ?)';
db.prepare(sql).run(claim.id, 'effect_direction', 'harmful', 'beneficial', 'smoke-r1');
db.prepare(sql).run(claim.id, 'effect_direction', 'harmful', 'beneficial', 'smoke-r2');
console.log('inserted 2 corrections on claim id =', claim.id);
" "$DB"

echo "==> run aggregate-corrections"
node aggregate-corrections.js

echo "==> verify lesson got auto-approved"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], {readonly:true});
const row = db.prepare(\"SELECT * FROM extractor_lessons WHERE field='effect_direction' AND corrected_pattern='beneficial'\").get();
if (!row) { console.error('FAIL: no lesson row'); process.exit(1); }
if (row.status !== 'approved') { console.error('FAIL: expected status=approved, got ' + row.status); process.exit(1); }
if (row.frequency !== 2) { console.error('FAIL: expected frequency=2, got ' + row.frequency); process.exit(1); }
console.log('lesson auto-approved at frequency 2 ✓');
" "$DB"

echo "==> run reprocess-stale (just to confirm output shape)"
node reprocess-stale.js 2>/dev/null | head -30 || true

echo "==> sanity counts"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], {readonly:true});
const runs = db.prepare('SELECT COUNT(*) c FROM extractor_runs').get().c;
const lessons = db.prepare(\"SELECT COUNT(*) c FROM extractor_lessons WHERE status='approved'\").get().c;
const staging_with_runid = db.prepare('SELECT COUNT(*) c FROM extraction_staging WHERE run_id IS NOT NULL').get().c;
const verdicts_with_sha = db.prepare(\"SELECT COUNT(*) c FROM claim_critic_verdicts WHERE critic_prompt_sha = 'legacy'\").get().c;
console.log('extractor_runs:', runs);
console.log('approved lessons:', lessons);
console.log('staging rows with run_id:', staging_with_runid);
console.log('verdicts with legacy SHA:', verdicts_with_sha);
if (runs < 1) { console.error('FAIL: expected >=1 run'); process.exit(1); }
if (lessons !== 1) { console.error('FAIL: expected 1 approved lesson'); process.exit(1); }
if (staging_with_runid < 1) { console.error('FAIL: backfill did not populate run_id'); process.exit(1); }
console.log('==> SMOKE TEST PASSED');
" "$DB"
