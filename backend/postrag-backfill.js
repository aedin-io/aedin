'use strict';

/**
 * classify a promoted claim's entity-grounding quality:
 *   - unverified: a null entity id, OR an entity already tombstoned (merged away)
 *   - fuzzy_verified: an entity sitting in a pending dedup candidate (will move)
 *   - verified: both ids present, neither pending-merge nor tombstoned
 */
function classifyClaim(claim, pendingMergeIds, tombstonedIds) {
  const ids = [claim.subject_entity_id, claim.object_entity_id];
  if (ids.some(id => id == null)) return 'unverified';
  if (ids.some(id => tombstonedIds.has(id))) return 'unverified';
  if (ids.some(id => pendingMergeIds.has(id))) return 'fuzzy_verified';
  return 'verified';
}

/**
 * Write claims.entity_resolution_status for every promoted (ai_reviewed) claim
 * that lacks one. dryRun computes the histogram without writing. Returns
 * { histogram, updated }.
 */
async function backfillClaims(db, { dryRun = false } = {}) {
  const pending = new Set(
    (await db.all(`SELECT entity_a_id, entity_b_id FROM entity_dedup_candidates WHERE status='pending'`))
      .flatMap(r => [r.entity_a_id, r.entity_b_id])
  );
  const tombstoned = new Set(
    (await db.all(`SELECT id FROM entities WHERE merged_into_entity_id IS NOT NULL`)).map(r => r.id)
  );
  const claims = await db.all(
    `SELECT id, subject_entity_id, object_entity_id FROM claims
     WHERE review_status='ai_reviewed' AND entity_resolution_status IS NULL`
  );
  const histogram = { verified: 0, fuzzy_verified: 0, unverified: 0 };
  let updated = 0;
  for (const claim of claims) {
    const status = classifyClaim(claim, pending, tombstoned);
    histogram[status]++;
    if (!dryRun) {
      await db.run(`UPDATE claims SET entity_resolution_status = ? WHERE id = ?`, status, claim.id);
      updated++;
    }
  }
  return { histogram, updated };
}

module.exports = { backfillClaims, classifyClaim };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const dryRun = process.argv.includes('--dry-run');
  const DB_PATH = CORPUS_DB;
  (async () => {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    const { histogram, updated } = await backfillClaims(db, { dryRun });
    console.log(`[postrag-backfill]${dryRun ? ' DRY-RUN' : ''} histogram:`, JSON.stringify(histogram), `updated=${updated}`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
