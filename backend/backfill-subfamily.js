#!/usr/bin/env node
'use strict';
/**
 * backfill-subfamily.js — populate entities.subfamily from the OTT backbone.
 *
 * Several ecological facts AEDIN needs are true at subfamily rank and FALSE at
 * family rank, so a family-keyed rule asserts the opposite of the truth for the
 * subfamily (Miletinae larvae are aphid predators inside a herbivorous family;
 * Lymantriinae adults are aphagous inside a nectar-feeding family). This column
 * is what lets those rules be keyed correctly.
 *
 * Most rows are a straight copy of OTT's subfamily. The exception is a
 * classification-vintage mismatch, handled by lib/subfamily-source.js — see
 * that module for why a raw copy silently returns nothing for tussock moths.
 *
 * NULL means UNKNOWN, never "has no subfamily". Consumers must treat a NULL as
 * an abstention, not as a negative.
 *
 * WRITES ONE COLUMN: entities.subfamily.
 *
 *   node backfill-subfamily.js               # dry-run
 *   node backfill-subfamily.js --apply
 *   node backfill-subfamily.js --undo --apply
 */
const Database = require('better-sqlite3');
const { CORPUS_DB, OTT_DB } = require('./lib/db-paths.cjs');
const { lineageRanks } = require('./lib/ott-lineage.js');
const { subfamilyFor } = require('./lib/subfamily-source.js');
const { checkOttDbVersion } = require('./lib/ott-release.js');
const { logRevisions } = require('./lib/revision-log.js');

const METHOD = 'backfill_subfamily_ott';
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');

const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB, apply ? {} : { readonly: true });

if (argv.includes('--undo')) {
  const rows = db.prepare(
    `SELECT target_id, before_value FROM revision_log
     WHERE target_type='entity' AND field='subfamily' AND method=? ORDER BY id DESC`).all(METHOD);
  console.log(`=== backfill-subfamily UNDO (${apply ? 'APPLY' : 'DRY-RUN'}) — ${rows.length} rows ===`);
  if (apply) {
    const seen = new Set();
    db.transaction(() => {
      for (const r of rows) {
        if (seen.has(r.target_id)) continue;            // newest wins
        seen.add(r.target_id);
        db.prepare('UPDATE entities SET subfamily = ? WHERE id = ?').run(r.before_value, r.target_id);
      }
      db.prepare(`DELETE FROM revision_log WHERE target_type='entity' AND field='subfamily' AND method=?`).run(METHOD);
    })();
    console.log(`Restored ${seen.size} rows.`);
  } else console.log('Dry run. Re-run with --apply.');
  process.exit(0);
}

const ottDb = new Database(OTT_DB, { readonly: true });
checkOttDbVersion(ottDb);

const cols = new Set(db.prepare('PRAGMA table_info(entities)').all().map(c => c.name));
if (!cols.has('subfamily')) {
  console.error('entities.subfamily missing — run migrations/078_entities_subfamily.js first.');
  process.exit(1);
}

const entities = db.prepare(
  `SELECT id, scientific_name, family, subfamily, ott_id FROM entities
   WHERE ott_id IS NOT NULL AND merged_into_entity_id IS NULL`).all();

const upd = db.prepare('UPDATE entities SET subfamily = ? WHERE id = ?');
const tally = { set: 0, unchanged: 0, no_subfamily: 0, bridged: 0 };
const bySubfamily = {};

db.transaction(() => {
  for (const e of entities) {
    const lineage = lineageRanks(ottDb, e.ott_id);
    const sub = subfamilyFor(lineage, e.family);
    if (!sub) { tally.no_subfamily++; continue; }
    if (!lineage.subfamily) tally.bridged++;          // came from the vintage bridge
    if (e.subfamily === sub) { tally.unchanged++; continue; }

    tally.set++;
    bySubfamily[sub] = (bySubfamily[sub] || 0) + 1;
    if (!apply) continue;
    upd.run(sub, e.id);
    logRevisions(db, {
      targetType: 'entity', targetId: e.id, changedBy: 'ott-subfamily-backfill', method: METHOD,
      reason: lineage.subfamily
        ? `OTT places ${e.scientific_name} in subfamily ${sub}`
        : `OTT carries the older family-rank concept ${lineage.family}; modern equivalent is subfamily ${sub}`,
      changes: [{ field: 'subfamily', before: e.subfamily, after: sub }],
    });
  }
})();

console.log(`=== backfill-subfamily (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`resolved entities      : ${entities.length}`);
console.log(`  subfamily written    : ${tally.set}`);
console.log(`    of which bridged   : ${tally.bridged}  (OTT's older family-rank concept)`);
console.log(`  already correct      : ${tally.unchanged}`);
console.log(`  OTT has no subfamily : ${tally.no_subfamily}  (left NULL = unknown)`);
console.log(`  distinct subfamilies : ${Object.keys(bySubfamily).length}`);
console.log('\ntop subfamilies written:');
for (const [s, n] of Object.entries(bySubfamily).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(6)}  ${s}`);
}
for (const s of ['Miletinae', 'Lymantriinae']) {
  console.log(`  ${String(bySubfamily[s] || 0).padStart(6)}  ${s}   <- drives a lifecycle-role correction`);
}
if (!apply) console.log('\nDry run. Re-run with --apply.');
db.close(); ottDb.close();
