'use strict';
/**
 * gen-traits-patch.cjs — surgical D1 delta patch for NEW ai_reviewed
 * entity_trait_claims that exist locally but are not yet on live D1
 * (trait promotions outrunning the last publish). The trait-table sibling
 * of gen-claims-patch.cjs: CLAIM-ID-scoped, insert/upsert-only, NO DELETE.
 *
 * Unlike build-d1-traits-patch.cjs (which republishes the WHOLE ai_reviewed
 * trait table with INSERT OR REPLACE across every referenced entity — unsafe
 * in a multi-chat corpus because it would leak concurrently-held entity edits
 * such as the dedup chat's un-published merged_into_entity_id state), this
 * computes the delta against live D1 and only:
 *   - INSERT OR IGNORE  INTO entities  (...)  -- entities NOT already live only
 *   - INSERT OR REPLACE INTO sources   (...)  -- refresh the cited sources
 *   - INSERT OR REPLACE INTO entity_trait_claims (...)  -- the new trait rows
 *   - INSERT OR IGNORE  INTO claim_critic_verdicts (...) -- their verdicts
 * It never REPLACEs an already-live entity, so held entity work stays held.
 *
 * Live real trait rows have id < 1e9; the 1e9+ ids are build-time synthesized
 * variety-inheritance rows (D1-only) — excluded from the live-id compare.
 *
 * PAGE-LESS GUARD: a trait whose entity is not already live AND has a NULL slug
 * locally would serve an orphan row (no /entity/<slug> page). Hold + report it.
 *
 * Usage: node web/scripts/gen-traits-patch.cjs --out=web/d1/patch-traits-delta.sql
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
const OUT = flag('out', '');
if (!OUT) { console.error('Usage: node gen-traits-patch.cjs --out=<path>'); process.exit(1); }

const REPO       = path.resolve(__dirname, '..', '..');
const SCHEMA_SQL = path.join(REPO, 'web', 'd1', 'schema.sql');
const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
const { assertNoLiveIdCollision } = require('./id-collision-guard.cjs');

// --- D1 column discovery (mirror gen-claims-patch.cjs) -------------------------
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
  const jsonStart = out.indexOf('[');
  const parsed = JSON.parse(out.slice(jsonStart));
  const results = (parsed[0] && parsed[0].results) || [];
  return results.map(r => r.id);
}

// --- compute delta ------------------------------------------------------------
// Live real trait rows only (id < 1e9); 1e9+ are build-time inherited rows.
const liveTraitIds = new Set(liveQueryIds("SELECT id FROM entity_trait_claims WHERE review_status='ai_reviewed' AND id < 1000000000"));

const db = new Database(CORPUS_DB, { readonly: true });
const d1Cols = d1ColumnsByTable();
const traitCols = projectedCols(db, 'entity_trait_claims', d1Cols);

const allLocal = db.prepare(`SELECT ${traitCols.join(',')} FROM entity_trait_claims WHERE review_status='ai_reviewed'`).all();
let newTraits = allLocal.filter(t => !liveTraitIds.has(t.id));

// HARDENING (fail-loud, symmetric with gen-claims-patch.cjs): a new-trait id already live
// (real row, id < 1e9, under a non-ai_reviewed status) would be silently overwritten by
// INSERT OR REPLACE — abort. See id-collision-guard.cjs (unit-tested).
assertNoLiveIdCollision(
  newTraits.map(t => t.id),
  (ids) => liveQueryIds(`SELECT id FROM entity_trait_claims WHERE id < 1000000000 AND id IN (${ids.join(',')})`),
  'new-trait',
);

// Which referenced entities are already live (already have a page)?
const refEntityIds0 = [...new Set(newTraits.map(t => t.entity_id).filter(x => x != null))];
const existing = new Set();
for (let i = 0; i < refEntityIds0.length; i += 400) {
  liveQueryIds(`SELECT id FROM entities WHERE id IN (${refEntityIds0.slice(i, i + 400).join(',')})`).forEach(id => existing.add(id));
}

// PAGE-LESS GUARD — hold traits whose entity is new AND slug-less locally.
const slugById = refEntityIds0.length
  ? new Map(db.prepare(`SELECT id, slug FROM entities WHERE id IN (${refEntityIds0.map(() => '?').join(',')})`).all(...refEntityIds0).map(r => [r.id, r.slug]))
  : new Map();
const pagelessNew = new Set(refEntityIds0.filter(id => !existing.has(id) && slugById.get(id) == null));
const heldTraits = [];
newTraits = newTraits.filter(t => {
  if (pagelessNew.has(t.entity_id)) { heldTraits.push(t.id); return false; }
  return true;
});

// New entities to publish = referenced by KEPT traits and not already live.
const refEntityIds = [...new Set(newTraits.map(t => t.entity_id).filter(x => x != null))];
const newEntityIds = refEntityIds.filter(id => !existing.has(id));
const entCols  = projectedCols(db, 'entities', d1Cols);
const entities = newEntityIds.length
  ? db.prepare(`SELECT ${entCols.join(',')} FROM entities WHERE id IN (${newEntityIds.map(() => '?').join(',')})`).all(...newEntityIds)
  : [];

// sources + verdicts for the new traits
const sourceIds = [...new Set(newTraits.map(t => t.source_id).filter(x => x != null))];
const srcCols = projectedCols(db, 'sources', d1Cols);
const sources = sourceIds.length
  ? db.prepare(`SELECT ${srcCols.join(',')} FROM sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
  : [];
const stagingIds = [...new Set(newTraits.map(t => t.staging_id).filter(x => x != null))];
const vCols = projectedCols(db, 'claim_critic_verdicts', d1Cols);
const verdicts = stagingIds.length
  ? db.prepare(`SELECT ${vCols.join(',')} FROM claim_critic_verdicts WHERE staging_id IN (${stagingIds.map(() => '?').join(',')})`).all(...stagingIds)
  : [];
db.close();

// --- emit ---------------------------------------------------------------------
const lines = [];
lines.push('-- D1 surgical patch (gen-traits-patch.cjs) — NEW ai_reviewed entity_trait_claims');
lines.push(`-- new: traits=${newTraits.length}  entities=${entities.length}  sources=${sources.length}  verdicts=${verdicts.length}`);
lines.push(`-- distinct source_ids=${sourceIds.length}  (no DELETE — purely additive; entities are IGNORE-only)`);
lines.push('CREATE TABLE IF NOT EXISTS entity_trait_claims (');
lines.push('  id INTEGER PRIMARY KEY, entity_id INTEGER, trait_name TEXT, value_numeric REAL,');
lines.push('  value_text TEXT, value_json TEXT, unit TEXT, source_id INTEGER, staging_id INTEGER,');
lines.push('  source_quote TEXT, source_page INTEGER, regional_context TEXT, review_status TEXT);');
lines.push('CREATE INDEX IF NOT EXISTS idx_etc_entity ON entity_trait_claims(entity_id);');
lines.push('');
lines.push(...insertsFor('entities',              entities, 'INSERT OR IGNORE'));
lines.push(...insertsFor('sources',               sources,  'INSERT OR REPLACE'));
lines.push(...insertsFor('entity_trait_claims',   newTraits, 'INSERT OR REPLACE'));
lines.push(...insertsFor('claim_critic_verdicts', verdicts, 'INSERT OR IGNORE'));
const outPath = path.resolve(REPO, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n');

console.log(`patch written: ${outPath}  (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
console.log(`  traits=${newTraits.length}  new_entities=${entities.length}  sources=${sources.length}  verdicts=${verdicts.length}`);
console.log(`  distinct source_ids=${sourceIds.length}: ${sourceIds.slice(0, 20).join(',')}${sourceIds.length > 20 ? '…' : ''}`);
console.log(`  referenced_entities=${refEntityIds.length}  already_live=${refEntityIds.length - newEntityIds.length}  new=${newEntityIds.length}`);
console.log(`  HELD (page-less referenced entity): traits=${heldTraits.length}  page-less_entities=${pagelessNew.size}${pagelessNew.size ? ` [${[...pagelessNew].join(',')}]` : ''}`);
if (heldTraits.length) console.log(`  held_trait_ids=${heldTraits.slice(0, 50).join(',')}${heldTraits.length > 50 ? '…' : ''}`);
