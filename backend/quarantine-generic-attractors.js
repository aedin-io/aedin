'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log');

const CHANGED_BY = 'attractor-guild-sweep';
const METHOD = 'quarantine-generic-attractors';

// 19 served attractor claims whose object is a clear generic guild / class / phylum / pseudo-taxon.
const AUTO_IDS = [
  6496213, 6496020, 6496416, 6496417, 6496418, 6496439, 6496440, 6496441, 6496443,
  6496444, 6495971, 6495973, 6496461, 6495969, 6495991, 6495992, 6495993, 6495994, 7282964,
];
// 3 order-level boundary claims — quarantined ONLY if the agroecologist gate (Task 3) confirms.
const BOUNDARY_IDS = [6495972 /*Araneae*/, 6495990 /*Coleoptera*/, 6495979 /*Hymenoptera*/];

function quarantineClaim(db, claimId) {
  const c = db.prepare('SELECT review_status FROM claims WHERE id=?').get(claimId);
  if (!c) return { changed: false, reason: 'claim absent' };
  if (c.review_status === 'quarantined_generic') return { changed: false, reason: 'already quarantined' };
  db.prepare("UPDATE claims SET review_status='quarantined_generic' WHERE id=?").run(claimId);
  logRevisions(db, { targetType: 'claim', targetId: claimId, changedBy: CHANGED_BY, method: METHOD,
    changes: [{ field: 'review_status', before: c.review_status, after: 'quarantined_generic' }] });
  return { changed: true };
}

// CONFIRMED_BOUNDARY set by Task 3 from the agroecologist verdict (2026-06-20):
// KEEP Araneae #6495972 (monophyletically predatory — actionable guild); QUARANTINE
// Coleoptera #6495990 (mixed order + a mis-categorized pollination claim) + Hymenoptera
// #6495979 (mixed: bees/parasitoids/sawfly-pests).
const CONFIRMED_BOUNDARY = [6495990, 6495979];

function main() {
  const apply = process.argv.includes('--apply');
  const ids = [...AUTO_IDS, ...CONFIRMED_BOUNDARY];
  const db = new Database(CORPUS_DB);
  if (!apply) {
    db.close();
    console.log(`DRY RUN — would quarantine ${ids.length} attractor claims (${AUTO_IDS.length} auto + ${CONFIRMED_BOUNDARY.length} confirmed boundary).`);
    console.log('auto:', AUTO_IDS.join(','));
    console.log('confirmed boundary:', CONFIRMED_BOUNDARY.join(',') || '(none — run agroecologist gate first)');
    console.log('pending boundary:', BOUNDARY_IDS.join(','));
    console.log('Re-run with --apply.');
    return;
  }
  const results = [];
  const run = db.transaction(() => { for (const id of ids) results.push({ id, r: quarantineClaim(db, id) }); });
  run();
  db.close();
  const changed = results.filter(x => x.r.changed).length;
  console.log(`Applied. ${changed}/${ids.length} claims quarantined.`);
  results.forEach(x => console.log('  ', x.r.changed ? 'CHANGED' : 'skip', x.id, x.r.reason || ''));
}

if (require.main === module) main();
module.exports = { quarantineClaim, AUTO_IDS, BOUNDARY_IDS };
