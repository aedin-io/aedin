'use strict';
/**
 * gen-claims-patch.cjs — surgical D1 patch for NEW ai_reviewed literature claims
 * that exist locally but are not yet on live D1 (promotions outrunning the last
 * publish). Unlike build-d1-patch.cjs (source-scoped, delete-then-reinsert for
 * re-ingestion), this is CLAIM-ID-scoped and insert/upsert-only — no DELETE —
 * because we are ADDING new promotions, not re-ingesting a source.
 *
 * It computes the delta itself: pulls the live `ai_reviewed` claim-id set via
 * wrangler, diffs against the local set, and emits only the missing claims plus
 * their not-yet-live served entities, their sources, and their critic verdicts.
 * Literature region lives in claims.regional_context (a projected column), so
 * NO claim_localities are needed (that table is GloBI-only).
 *
 * Emits (re-runnable):
 *   INSERT OR IGNORE  INTO entities  (...)   -- new subjects/objects only
 *   INSERT OR REPLACE INTO sources   (...)   -- refresh metadata
 *   INSERT OR REPLACE INTO claims    (...)   -- the new claims
 *   INSERT OR IGNORE  INTO claim_critic_verdicts (...)
 *
 * Usage:
 *   node web/scripts/gen-claims-patch.cjs --out=web/d1/patch-litclaims.sql
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
const OUT = flag('out', '');
if (!OUT) { console.error('Usage: node gen-claims-patch.cjs --out=<path>'); process.exit(1); }

const REPO       = path.resolve(__dirname, '..', '..');
const SCHEMA_SQL = path.join(REPO, 'web', 'd1', 'schema.sql');
const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
const { assertNoLiveIdCollision } = require('./id-collision-guard.cjs');

// --- D1 column discovery (mirror build-d1-patch.cjs) ---------------------------
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

// --- live-D1 helpers (read-only) ----------------------------------------------
function liveQueryIds(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'agroeco', '--remote', '--json', '--command', sql],
    { cwd: path.join(REPO, 'web'), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  // wrangler --json prints an array of {results:[...]} (plus log lines); grab the JSON array.
  const jsonStart = out.indexOf('[');
  const parsed = JSON.parse(out.slice(jsonStart));
  const results = (parsed[0] && parsed[0].results) || [];
  return results.map(r => r.id);
}

// --- compute delta ------------------------------------------------------------
const liveClaimIds = new Set(liveQueryIds("SELECT id FROM claims WHERE review_status='ai_reviewed'"));

const db = new Database(CORPUS_DB, { readonly: true });
const d1Cols = d1ColumnsByTable();
const claimCols = projectedCols(db, 'claims', d1Cols);

const allLocal = db.prepare(`SELECT ${claimCols.join(',')} FROM claims WHERE review_status='ai_reviewed'`).all();
let newClaims = allLocal.filter(c => !liveClaimIds.has(c.id));

// HARDENING (fail-loud): the live diff above only knows the ai_reviewed id set, so a
// new-claim id that collides with a live NON-ai_reviewed row (a GloBI tier2_globi claim
// or an ai_vouched row) would be silently overwritten by INSERT OR REPLACE. Any new-claim
// id already live is such a collision — abort. See id-collision-guard.cjs (unit-tested).
assertNoLiveIdCollision(
  newClaims.map(c => c.id),
  (ids) => liveQueryIds(`SELECT id FROM claims WHERE id IN (${ids.join(',')})`),
  'new-claim',
);

// Which referenced entities are already live (i.e. already have a page)?
const refEntityIds0 = [...new Set(newClaims.flatMap(c => [c.subject_entity_id, c.object_entity_id]).filter(x => x != null))];
const existing = new Set();
for (let i = 0; i < refEntityIds0.length; i += 400) {
  liveQueryIds(`SELECT id FROM entities WHERE id IN (${refEntityIds0.slice(i, i + 400).join(',')})`).forEach(id => existing.add(id));
}

// SAFETY GUARD: never publish a claim whose subject/object would be page-less.
// A referenced entity that is NOT already live AND has a NULL slug locally would
// serve a broken reference (no /entity/<slug> page) — typically a needs_dedup
// duplicate awaiting variety-intake. Hold those claims and report them rather
// than ship a dangling subject/object.
const slugById = refEntityIds0.length
  ? new Map(
      db.prepare(`SELECT id, slug FROM entities WHERE id IN (${refEntityIds0.map(() => '?').join(',')})`).all(...refEntityIds0).map(r => [r.id, r.slug])
    )
  : new Map();
const pagelessNew = new Set(refEntityIds0.filter(id => !existing.has(id) && slugById.get(id) == null));
const heldClaims = [];
newClaims = newClaims.filter(c => {
  if (pagelessNew.has(c.subject_entity_id) || pagelessNew.has(c.object_entity_id)) { heldClaims.push(c.id); return false; }
  return true;
});

// New entities to publish = those referenced by the KEPT claims and not already
// live (all of which now have slugs, the guard above having dropped the rest).
const refEntityIds = [...new Set(newClaims.flatMap(c => [c.subject_entity_id, c.object_entity_id]).filter(x => x != null))];
const newEntityIds = refEntityIds.filter(id => !existing.has(id));
const entCols  = projectedCols(db, 'entities', d1Cols);
const entities = newEntityIds.length
  ? db.prepare(`SELECT ${entCols.join(',')} FROM entities WHERE id IN (${newEntityIds.map(() => '?').join(',')})`).all(...newEntityIds)
  : [];

// sources + verdicts for the new claims
const sourceIds = [...new Set(newClaims.map(c => c.source_id).filter(x => x != null))];
const srcCols = projectedCols(db, 'sources', d1Cols);
const sources = sourceIds.length
  ? db.prepare(`SELECT ${srcCols.join(',')} FROM sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
  : [];
const stagingIds = [...new Set(newClaims.map(c => c.staging_id).filter(x => x != null))];
const vCols = projectedCols(db, 'claim_critic_verdicts', d1Cols);
const verdicts = stagingIds.length
  ? db.prepare(`SELECT ${vCols.join(',')} FROM claim_critic_verdicts WHERE staging_id IN (${stagingIds.map(() => '?').join(',')})`).all(...stagingIds)
  : [];
db.close();

// --- emit ---------------------------------------------------------------------
const lines = [];
lines.push('-- D1 surgical patch (gen-claims-patch.cjs) — NEW ai_reviewed literature claims');
lines.push(`-- new: claims=${newClaims.length}  entities=${entities.length}  sources=${sources.length}  verdicts=${verdicts.length}`);
lines.push(`-- distinct source_ids=${sourceIds.length}  (no DELETE — purely additive)`);
lines.push('');
lines.push(...insertsFor('entities',              entities, 'INSERT OR IGNORE'));
lines.push(...insertsFor('sources',               sources,  'INSERT OR REPLACE'));
lines.push(...insertsFor('claims',                newClaims, 'INSERT OR REPLACE'));
lines.push(...insertsFor('claim_critic_verdicts', verdicts, 'INSERT OR IGNORE'));
const outPath = path.resolve(REPO, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n');

console.log(`patch written: ${outPath}  (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
console.log(`  claims=${newClaims.length}  new_entities=${entities.length}  sources=${sources.length}  verdicts=${verdicts.length}`);
console.log(`  distinct source_ids=${sourceIds.length}: ${sourceIds.slice(0, 20).join(',')}${sourceIds.length > 20 ? '…' : ''}`);
console.log(`  referenced_entities=${refEntityIds.length}  already_live=${refEntityIds.length - newEntityIds.length}  new=${newEntityIds.length}`);
console.log(`  HELD (page-less referenced entity): claims=${heldClaims.length}  page-less_entities=${pagelessNew.size}${pagelessNew.size ? ` [${[...pagelessNew].join(',')}]` : ''}`);
if (heldClaims.length) console.log(`  held_claim_ids=${heldClaims.join(',')}`);
