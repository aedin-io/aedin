'use strict';
/**
 * build-d1-patch.cjs — emit a SURGICAL D1 patch for one or more source_ids,
 * preserving everything else already on D1 (in particular the ~238K tier2_globi
 * GloBI claims that are NOT in the local DB right now).
 *
 * Why: the standard build:d1 + `wrangler d1 execute --remote --file=data.sql`
 * pattern is a full replace and would wipe the live GloBI corpus on each
 * literature refresh. This script instead emits:
 *
 *   - DELETE FROM claim_critic_verdicts WHERE staging_id IN (<old IDs from backup>)
 *   - DELETE FROM claims WHERE source_id IN (<args>)
 *   - INSERT OR REPLACE INTO sources (...)             -- in case metadata changed
 *   - INSERT OR IGNORE INTO entities (...)             -- new subjects/objects
 *   - INSERT INTO claims (...)                          -- fresh rows
 *   - INSERT OR IGNORE INTO claim_critic_verdicts (...) -- new verdicts
 *
 * Old-staging-ID list is read from the reset-sources-for-reingest.js backup
 * JSON (`backend/backups/reset-sources-<ids>-<ts>.json`) so we can target the
 * exact verdicts that became orphaned when the source's staging rows were wiped
 * pre-reingest.
 *
 * Column projection mirrors build-d1.cjs: only columns present in BOTH the D1
 * schema (web/d1/schema.sql) and the live source table get emitted.
 *
 * Usage:
 *   node web/scripts/build-d1-patch.cjs --source-ids=68,69 \
 *        --backup=backend/backups/reset-sources-68_69-2026-05-29T13-44-40-654Z.json \
 *        --out=web/d1/patch-pass12.sql
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
function flag(name, def) {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=', 2)[1] : def;
}
const SRC_IDS = (flag('source-ids', '') || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
const BACKUP  = flag('backup', '');
const OUT     = flag('out', '');
if (!SRC_IDS.length || !BACKUP || !OUT) {
  console.error('Usage: node build-d1-patch.cjs --source-ids=68,69 --backup=<path> --out=<path>');
  process.exit(1);
}

const REPO       = path.resolve(__dirname, '..', '..');
const SCHEMA_SQL = path.join(REPO, 'web', 'd1', 'schema.sql');
const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
const SRC_DB     = CORPUS_DB;

// Learn D1 column lists from the committed schema.sql (loaded into in-memory DB).
function d1ColumnsByTable() {
  const mem = new Database(':memory:');
  mem.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));
  const tables = mem.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map(r => r.name);
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

// Encode SQLite values for D1 execute. Newlines inside text break the
// line-per-statement importer; use char()-concat to keep each INSERT on one line.
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v);
  if (!/[\r\n\t']/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  const parts = [];
  let buf = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x0a || c === 0x0d || c === 0x09) {
      if (buf) { parts.push(`'${buf.replace(/'/g, "''")}'`); buf = ''; }
      parts.push(`char(${c})`);
    } else { buf += ch; }
  }
  if (buf) parts.push(`'${buf.replace(/'/g, "''")}'`);
  return parts.length === 1 ? parts[0] : parts.join('||');
}

function insertsFor(table, rows, mode = 'INSERT') {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  return rows.map(r => `${mode} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => sqlVal(r[c])).join(',')});`);
}

const ph = SRC_IDS.map(() => '?').join(',');
const db = new Database(SRC_DB, { readonly: true });
const d1Cols = d1ColumnsByTable();

// 1. Pull NEW claim rows for these sources (post-Pass-12 state).
const claimCols = projectedCols(db, 'claims', d1Cols);
const claims = db.prepare(`SELECT ${claimCols.join(',')} FROM claims WHERE source_id IN (${ph})`).all(...SRC_IDS);

// 2. Pull NEW source-metadata rows.
const srcCols  = projectedCols(db, 'sources', d1Cols);
const sources  = db.prepare(`SELECT ${srcCols.join(',')} FROM sources WHERE id IN (${ph})`).all(...SRC_IDS);

// 3. Pull NEW entity rows referenced by the new claims (subject + object).
const entityIds = [...new Set(claims.flatMap(c => [c.subject_entity_id, c.object_entity_id]).filter(x => x != null))];
const entCols   = projectedCols(db, 'entities', d1Cols);
const entities  = entityIds.length
  ? db.prepare(`SELECT ${entCols.join(',')} FROM entities WHERE id IN (${entityIds.map(() => '?').join(',')})`).all(...entityIds)
  : [];

// 4. Pull NEW verdicts (verdicts whose staging_id is referenced by the new claims).
const newStagingIds = [...new Set(claims.map(c => c.staging_id).filter(x => x != null))];
const vCols = projectedCols(db, 'claim_critic_verdicts', d1Cols);
const verdicts = newStagingIds.length
  ? db.prepare(`SELECT ${vCols.join(',')} FROM claim_critic_verdicts WHERE staging_id IN (${newStagingIds.map(() => '?').join(',')})`).all(...newStagingIds)
  : [];

db.close();

// 5. Read OLD staging IDs from the reset-sources backup (verdicts to wipe on D1).
const backup = JSON.parse(fs.readFileSync(path.resolve(REPO, BACKUP), 'utf8'));
const oldStagingIds = (backup.extraction_staging || []).map(r => r.id).filter(Number.isInteger);

// 6. Emit the patch SQL (transactional).
const out = [];
out.push('-- D1 surgical patch (build-d1-patch.cjs)');
out.push(`-- sources=${SRC_IDS.join(',')}  generated_from=backend/aedin.sqlite`);
out.push(`-- new: entities=${entities.length}  claims=${claims.length}  sources=${sources.length}  verdicts=${verdicts.length}`);
out.push(`-- old_staging_ids_to_purge=${oldStagingIds.length}`);
out.push('');
// D1 manages transactions internally and rejects BEGIN/COMMIT in --file inputs.
// Each statement runs independently; we use OR REPLACE/IGNORE to make the
// patch re-runnable if any single statement fails mid-stream.
if (oldStagingIds.length) {
  out.push(`DELETE FROM claim_critic_verdicts WHERE staging_id IN (${oldStagingIds.join(',')});`);
}
out.push(`DELETE FROM claims WHERE source_id IN (${SRC_IDS.join(',')});`);
out.push(...insertsFor('entities',              entities, 'INSERT OR IGNORE'));
out.push(...insertsFor('sources',               sources,  'INSERT OR REPLACE'));
out.push(...insertsFor('claims',                claims,   'INSERT OR REPLACE'));
out.push(...insertsFor('claim_critic_verdicts', verdicts, 'INSERT OR IGNORE'));

const outPath = path.resolve(REPO, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join('\n') + '\n');

const bytes = fs.statSync(outPath).size;
console.log(`patch written: ${outPath}`);
console.log(`  size: ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  entities=${entities.length} sources=${sources.length} claims=${claims.length} verdicts=${verdicts.length}`);
console.log(`  delete old_verdicts: ${oldStagingIds.length}`);
