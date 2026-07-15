'use strict';
/**
 * build-d1-revisions-patch.cjs — one-time SURGICAL patch publishing revision_log
 * (modification provenance) to live D1 without a full reload (which would wipe
 * the GloBI claims that live only on D1).
 *
 * DENORMALIZATION (why this isn't a simple column-projection): the D1 `claims`
 * table is the served-subset mirror and does NOT contain quarantined/removed
 * claims. The entity-claim modification rollup must surface exactly those removed
 * claims, so a runtime JOIN to D1.claims would drop them. Instead, this script —
 * which reads the FULL local DB — bakes the claim's subject/object entity ids +
 * names + served-flag onto each claim-target revision row. getClaimRevisionsForEntity
 * then reads those columns directly (no JOIN).
 *
 * Scope: entity revisions for served entities + claim revisions whose subject OR
 * object entity is served (even if the claim itself was removed). revision_log is
 * a pure mirror, so the patch DROPs + recreates it (cheap; ~5k rows). Re-runnable.
 *
 * Usage: node web/scripts/build-d1-revisions-patch.cjs --out=web/d1/patch-revisions.sql
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
const OUT = flag('out', 'web/d1/patch-revisions.sql');
const REPO = path.resolve(__dirname, '..', '..');
const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
const SRC_DB = CORPUS_DB;

function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  const escaped = String(v).replace(/'/g, "''");
  if (!/[\r\n]/.test(escaped)) return `'${escaped}'`;
  return escaped.split(/(\r\n|\r|\n)/).filter(p => p !== '').map(p =>
    p === '\r\n' ? 'char(13)||char(10)' : p === '\r' ? 'char(13)' : p === '\n' ? 'char(10)' : `'${p}'`).join('||');
}

// served entity id set (mirrors build-d1.cjs)
const ENTITY_IDS_SQL = `
  SELECT DISTINCT id FROM (
    SELECT id FROM entities WHERE scope_tier IS NOT NULL
    UNION SELECT subject_entity_id FROM claims WHERE review_status='ai_reviewed'
    UNION SELECT object_entity_id  FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL
    UNION SELECT entity_id FROM entity_trait_claims WHERE review_status='ai_reviewed'
  ) WHERE id IS NOT NULL`;

const COLS = ['id', 'target_type', 'target_id', 'field', 'before_value', 'after_value', 'changed_by',
  'method', 'reason', 'applied_at', 'subject_entity_id', 'object_entity_id', 'subject_name', 'object_name', 'served'];

// Entity revisions (served entity) + claim revisions (claim touches a served
// entity) with the entity association denormalized from local claims+entities.
const ROWS_SQL = `
  SELECT r.id, r.target_type, r.target_id, r.field, r.before_value, r.after_value, r.changed_by,
         r.method, r.reason, r.applied_at,
         NULL AS subject_entity_id, NULL AS object_entity_id, NULL AS subject_name, NULL AS object_name, NULL AS served
  FROM revision_log r
  WHERE r.target_type='entity' AND r.target_id IN (${ENTITY_IDS_SQL})
  UNION ALL
  SELECT r.id, r.target_type, r.target_id, r.field, r.before_value, r.after_value, r.changed_by,
         r.method, r.reason, r.applied_at,
         c.subject_entity_id, c.object_entity_id, es.scientific_name, eo.scientific_name,
         (CASE WHEN c.review_status='ai_reviewed' OR (c.data_tier='tier2_globi' AND c.chain_role IS NOT NULL) THEN 1 ELSE 0 END)
  FROM revision_log r
  JOIN claims c ON c.id = r.target_id
  LEFT JOIN entities es ON es.id = c.subject_entity_id
  LEFT JOIN entities eo ON eo.id = c.object_entity_id
  WHERE r.target_type='claim'
    AND (c.subject_entity_id IN (${ENTITY_IDS_SQL}) OR c.object_entity_id IN (${ENTITY_IDS_SQL}))`;

const db = new Database(SRC_DB, { readonly: true });
const rows = db.prepare(ROWS_SQL).all();
db.close();

const out = [];
out.push('-- D1 revisions patch (build-d1-revisions-patch.cjs) — denormalized');
out.push(`-- rows=${rows.length} (entity + claim revisions, removed claims included)`);
// revision_log is a pure mirror: rebuild it so the denormalized columns exist.
out.push('DROP TABLE IF EXISTS revision_log;');
out.push(`CREATE TABLE revision_log (
  id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
  before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT,
  subject_entity_id INTEGER, object_entity_id INTEGER, subject_name TEXT, object_name TEXT, served INTEGER);`);
out.push('CREATE INDEX idx_revlog_target ON revision_log(target_type, target_id);');
out.push('CREATE INDEX idx_revlog_subject ON revision_log(subject_entity_id);');
out.push('CREATE INDEX idx_revlog_object ON revision_log(object_entity_id);');
for (const r of rows) {
  out.push(`INSERT INTO revision_log (${COLS.join(',')}) VALUES (${COLS.map(c => sqlVal(r[c])).join(',')});`);
}
const outPath = path.resolve(REPO, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join('\n') + '\n');
const claimRows = rows.filter(r => r.target_type === 'claim');
const removed = new Set(claimRows.filter(r => r.served === 0).map(r => r.target_id));
console.log(`revisions patch: ${outPath}  (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB, ${rows.length} rows; ${claimRows.length} claim-rows, ${removed.size} removed-claim ids)`);
