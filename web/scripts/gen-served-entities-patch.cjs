'use strict';
/**
 * gen-served-entities-patch.cjs — surgical D1 patch that pushes the just-served
 * literature-ingested entities (serve-referenced-entities.js) onto live D1.
 *
 * Why a dedicated patch: gen-claims-patch.cjs emits entities with INSERT OR IGNORE
 * and ONLY for entities not already live. But most of these entities are ALREADY on
 * live D1 as NULL-slug rows (included by a prior full build-d1), so IGNORE would
 * leave them page-less even after their claims publish. This emits INSERT OR REPLACE
 * so already-live rows get their corrected slug + scope_tier, and not-yet-live ones
 * are inserted.
 *
 * A full build-d1 rebuild is NOT an option (it would wipe the ~212K live-only
 * tier2_globi GloBI claims). Surgical only. Read-only on the corpus DB; emits SQL.
 *
 * The served id set comes from EITHER:
 *   --served=<backup.json>      a serve-referenced-entities backup (served[].id), OR
 *   --revlog-since=<iso-date>   all entities slug-set by the serve scripts on/after a
 *                               date (captures both serve paths in one patch).
 * Either way, only rows that currently have BOTH slug AND scope_tier set are emitted
 * (the per-id guard drops any reverted/no-longer-servable id).
 *
 * Usage:
 *   node web/scripts/gen-served-entities-patch.cjs \
 *     --revlog-since=2026-06-29 --out=web/d1/patch-served-entities.sql
 *
 * Spec: docs/superpowers/specs/2026-06-29-serve-referenced-entities-design.md
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
const SERVED = flag('served', '');
const REVLOG_SINCE = flag('revlog-since', '');
const OUT = flag('out', 'web/d1/patch-served-entities.sql');
if (!SERVED && !REVLOG_SINCE) { console.error('Usage: node gen-served-entities-patch.cjs (--served=<backup.json> | --revlog-since=<iso>) --out=<path>'); process.exit(1); }
const SERVE_METHODS = ['serve-referenced-entities', 'serve-grin-claim-subjects'];

const REPO = path.resolve(__dirname, '..', '..');
const SCHEMA_SQL = path.join(REPO, 'web', 'd1', 'schema.sql');
const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');

// D1 column discovery (mirror build-d1.cjs): emit only columns present in BOTH the
// committed D1 schema and the live source table.
function d1ColumnsByTable() {
  const mem = new Database(':memory:');
  mem.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));
  const tables = mem.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name);
  const out = {};
  for (const t of tables) out[t] = mem.prepare('SELECT name FROM pragma_table_info(?)').all(t).map(r => r.name);
  mem.close();
  return out;
}
function projectedCols(db, table, d1Cols) {
  const src = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r => r.name));
  const shared = (d1Cols[table] || []).filter(c => src.has(c));
  if (!shared.length) throw new Error(`no shared columns for "${table}"`);
  return shared;
}
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v);
  if (!/[\r\n\t']/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  const parts = []; let buf = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x0a || c === 0x0d || c === 0x09) { if (buf) { parts.push(`'${buf.replace(/'/g, "''")}'`); buf = ''; } parts.push(`char(${c})`); }
    else buf += ch;
  }
  if (buf) parts.push(`'${buf.replace(/'/g, "''")}'`);
  return parts.length === 1 ? parts[0] : parts.join('||');
}
function insertsFor(table, rows, mode) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  return rows.map(r => `${mode} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => sqlVal(r[c])).join(',')});`);
}

const db = new Database(CORPUS_DB, { readonly: true });

let ids;
if (REVLOG_SINCE) {
  const ph = SERVE_METHODS.map(() => '?').join(',');
  ids = [...new Set(db.prepare(
    `SELECT DISTINCT target_id AS id FROM revision_log
     WHERE target_type='entity' AND field='slug' AND changed_by IN (${ph}) AND applied_at >= ?`
  ).all(...SERVE_METHODS, REVLOG_SINCE).map(r => r.id).filter(Number.isInteger))];
} else {
  const backup = JSON.parse(fs.readFileSync(path.resolve(REPO, SERVED), 'utf8'));
  ids = [...new Set((backup.served || []).map(s => s.id).filter(Number.isInteger))];
}
if (!ids.length) { console.error('No served ids found — nothing to patch.'); process.exit(1); }
const d1Cols = d1ColumnsByTable();
const entCols = projectedCols(db, 'entities', d1Cols);

// Safety: only emit rows that are actually servable now (slug set, scope_tier set).
const rows = [];
const sel = db.prepare(`SELECT ${entCols.join(',')} FROM entities WHERE id = ?`);
const verify = db.prepare('SELECT slug, scope_tier FROM entities WHERE id = ?');
let skipped = 0;
for (const id of ids) {
  const v = verify.get(id);
  if (!v || v.slug == null || v.scope_tier == null) { skipped++; continue; }
  rows.push(sel.get(id));
}
db.close();

const lines = [];
lines.push('-- D1 surgical patch (gen-served-entities-patch.cjs) — newly-served literature entities');
lines.push(`-- entities=${rows.length}  (INSERT OR REPLACE: fixes slug/scope_tier on already-live NULL-slug rows + inserts new)`);
if (skipped) lines.push(`-- skipped=${skipped} (no longer slug+scope_tier — not servable)`);
lines.push('');
lines.push(...insertsFor('entities', rows, 'INSERT OR REPLACE'));

const outPath = path.resolve(REPO, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`served-entities patch: ${outPath}  (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
console.log(`  entities=${rows.length}  skipped=${skipped}`);
