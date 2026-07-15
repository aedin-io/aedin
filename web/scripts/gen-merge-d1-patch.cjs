'use strict';
/**
 * gen-merge-d1-patch.cjs — emit a surgical, idempotent SQL patch that reconciles
 * dedup merges to live D1: tombstone each served loser (merged_into_entity_id) and
 * re-point its claim/trait FKs to the canonical. Driven by the flattened
 * `entities.merged_into_entity_id` pointer (corpus truth); reconciles every served +
 * active merge. The `entity_dedup_log` remains the reversal/audit authority.
 *
 * Re-points by stable ENTITY id. UPDATE-only → GloBI's 212K rows untouched.
 *
 * Usage: node web/scripts/gen-merge-d1-patch.cjs --out=web/d1/patch-merge-dedup.sql
 */
const path = require('path');
const fs = require('fs');

// Served (loser has a slug → a D1 page), active (merged_into set) tombstones,
// sourced from the FLATTENED corpus pointer — one row per loser, canon = terminal.
// Reusable for future needs_review merges (every merge sets merged_into); the
// entity_dedup_log remains the reversal/audit authority.
function selectServedMerges(db) {
  return db.prepare(`
    SELECT id AS loser, merged_into_entity_id AS canon
    FROM entities
    WHERE merged_into_entity_id IS NOT NULL AND slug IS NOT NULL
    ORDER BY id
  `).all();
}

// Fail loud if any canonical is itself a tombstone — the corpus must be flattened
// (backend/flatten-merge-chains.js) BEFORE generating, or redirects would 404.
function assertNoTombstoneCanon(db, rows) {
  if (!rows.length) return rows;
  const canons = [...new Set(rows.map(r => r.canon))].join(',');
  const bad = db.prepare(`
    SELECT id FROM entities WHERE id IN (${canons}) AND merged_into_entity_id IS NOT NULL
  `).all();
  if (bad.length) {
    throw new Error(`tombstone canonical(s) — corpus not flattened: ${bad.map(b => b.id).join(', ')}`);
  }
  return rows;
}

function mergePatchSql(rows) {
  const out = [
    '-- D1 merge reconciliation patch (gen-merge-d1-patch.cjs)',
    `-- served merges reconciled: ${rows.length}`,
  ];
  for (const { loser, canon } of rows) {
    out.push(`UPDATE entities SET merged_into_entity_id=${canon} WHERE id=${loser};`);
    out.push(`UPDATE claims SET subject_entity_id=${canon} WHERE subject_entity_id=${loser};`);
    out.push(`UPDATE claims SET object_entity_id=${canon} WHERE object_entity_id=${loser};`);
    out.push(`UPDATE entity_trait_claims SET entity_id=${canon} WHERE entity_id=${loser};`);
  }
  return out.join('\n') + '\n';
}

module.exports = { selectServedMerges, mergePatchSql, assertNoTombstoneCanon };

if (require.main === module) {
  const Database = require('better-sqlite3');
  const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
  const out = flag('out', 'web/d1/patch-merge-dedup.sql');
  const db = new Database(CORPUS_DB, { readonly: true });
  const rows = selectServedMerges(db);
  assertNoTombstoneCanon(db, rows);
  db.close();
  const outPath = path.resolve(__dirname, '..', '..', out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, mergePatchSql(rows));
  console.log(`[merge-patch] ${rows.length} served merges → ${outPath}`);
}
