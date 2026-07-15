'use strict';
/**
 * gen-roles-patch.cjs — surgical, idempotent D1 patch that syncs served entities'
 * primary_role to the corpus (after the family-floor role reclassification).
 *
 * READ-ONLY on corpus DB. Does NOT touch D1 / wrangler / prod.
 * Emits `UPDATE entities SET primary_role='<role>' WHERE id=<id>;` for every
 * SERVED entity (build-d1's ENTITY_IDS_SQL set). UPDATE-only + keyed by stable
 * entity id → idempotent, and a no-op for any id not present on D1. GloBI's raw
 * rows are untouched (only the served entities table is patched).
 *
 * Usage: node web/scripts/gen-roles-patch.cjs --out=web/d1/patch-roles-family-floor.sql
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..', '..');               // publish-main worktree root
const CORPUS_DB_PATH = path.join(REPO_ROOT, '..', '..', 'backend', 'aedin.sqlite'); // shared corpus
const argv = process.argv.slice(2);
const outArg = (argv.find(a => a.startsWith('--out=')) || '').split('=')[1];
const OUT = outArg || path.join(__dirname, '..', 'd1', 'patch-roles-family-floor.sql');

// Same served-set definition as build-d1.cjs ENTITY_IDS_SQL.
const ENTITY_IDS_SQL = `
  SELECT DISTINCT id FROM (
    SELECT id FROM entities WHERE scope_tier IS NOT NULL
    UNION SELECT subject_entity_id AS id FROM claims WHERE review_status='ai_reviewed'
    UNION SELECT object_entity_id  AS id FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL
    UNION SELECT entity_id AS id FROM entity_trait_claims WHERE review_status='ai_reviewed'
    UNION SELECT id FROM entities WHERE merged_into_entity_id IS NOT NULL AND slug IS NOT NULL
  ) WHERE id IS NOT NULL`;

const db = new Database(CORPUS_DB_PATH, { readonly: true });
const rows = db.prepare(
  `SELECT e.id, e.primary_role FROM entities e
   WHERE e.id IN (${ENTITY_IDS_SQL}) AND e.primary_role IS NOT NULL
   ORDER BY e.id`
).all();

const byRole = {};
const lines = [
  '-- D1 role patch (gen-roles-patch.cjs) — family-floor reclassification',
  `-- served entities synced: ${rows.length}`,
];
for (const { id, primary_role } of rows) {
  byRole[primary_role] = (byRole[primary_role] || 0) + 1;
  lines.push(`UPDATE entities SET primary_role='${String(primary_role).replace(/'/g, "''")}' WHERE id=${id};`);
}
fs.writeFileSync(OUT, lines.join('\n') + '\n');
db.close();

console.log(`Wrote ${rows.length} UPDATE statements to ${OUT}`);
console.log('Served-entity role distribution in patch:');
for (const [r, n] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${r}`);
