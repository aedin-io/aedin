'use strict';
/**
 * build-d1-traits-patch.cjs — one-time SURGICAL patch that publishes the
 * entity_trait_claims table to live D1 WITHOUT a full reload (a full
 * `build:d1` + replace would wipe the ~212K tier2_globi GloBI claims that
 * live only on D1).
 *
 * Emits:
 *   - CREATE TABLE IF NOT EXISTS entity_trait_claims (+ index)   -- new table
 *   - INSERT OR IGNORE INTO entities (...)   -- trait-only entities not yet on D1
 *   - INSERT OR IGNORE INTO sources  (...)   -- sources the traits cite
 *   - INSERT OR REPLACE INTO entity_trait_claims (...)  -- the trait rows
 *
 * Column projection mirrors build-d1.cjs (schema ∩ live source). Re-runnable.
 *
 * PAGE-LESS GUARD: traits whose entity has a NULL slug locally are SKIPPED (an
 * orphan trait row with no /entity/<slug> page to display it). Symmetric with
 * gen-claims-patch.cjs. Serve the entity first (serve-referenced-entities.js).
 *
 * Usage: node web/scripts/build-d1-traits-patch.cjs --out=web/d1/patch-traits.sql
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
const OUT = flag('out', 'web/d1/patch-traits.sql');
// --served-since=<iso>: restrict to traits whose entity was made servable by the
// serve scripts on/after this date — publishes ONLY the traits unblocked by serving,
// not the whole ai_reviewed trait table (avoids shipping unrelated trait backlog).
const SERVED_SINCE = flag('served-since', '');
const SERVE_METHODS = ['serve-referenced-entities', 'serve-grin-claim-subjects'];

const REPO = path.resolve(__dirname, '..', '..');
const SCHEMA_SQL = path.join(REPO, 'web', 'd1', 'schema.sql');
const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
const SRC_DB = CORPUS_DB;

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
// sqlVal mirrors build-d1.cjs (char()-concat for newlines so each INSERT is one line).
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  const escaped = String(v).replace(/'/g, "''");
  if (!/[\r\n]/.test(escaped)) return `'${escaped}'`;
  return escaped.split(/(\r\n|\r|\n)/).filter(p => p !== '').map(p =>
    p === '\r\n' ? 'char(13)||char(10)' : p === '\r' ? 'char(13)' : p === '\n' ? 'char(10)' : `'${p}'`
  ).join('||');
}
function insertsFor(table, rows, mode) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  return rows.map(r => `${mode} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => sqlVal(r[c])).join(',')});`);
}

const db = new Database(SRC_DB, { readonly: true });
const d1Cols = d1ColumnsByTable();

const traitCols = projectedCols(db, 'entity_trait_claims', d1Cols);
// Optionally scope to entities served (slug-set) by the serve scripts since a date.
let servedScope = null;
if (SERVED_SINCE) {
  const ph = SERVE_METHODS.map(() => '?').join(',');
  servedScope = new Set(db.prepare(
    `SELECT DISTINCT target_id AS id FROM revision_log
     WHERE target_type='entity' AND field='slug' AND changed_by IN (${ph}) AND applied_at >= ?`
  ).all(...SERVE_METHODS, SERVED_SINCE).map(r => r.id));
}
const allTraits = db.prepare(`SELECT ${traitCols.join(',')} FROM entity_trait_claims WHERE review_status='ai_reviewed'`)
  .all()
  .filter(t => !servedScope || servedScope.has(t.entity_id));

// PAGE-LESS GUARD: a trait whose entity has a NULL slug locally would publish an
// invisible orphan row — no /entity/<slug> page renders it (entity/[slug].astro is
// slug-keyed). Drop those traits + their entities (the still-held needs_dedup /
// needs_taxonomy_review tail). Symmetric with gen-claims-patch.cjs's guard.
const allEntityIds = [...new Set(allTraits.map(t => t.entity_id).filter(x => x != null))];
const slugById = new Map();
for (let i = 0; i < allEntityIds.length; i += 800) {
  const chunk = allEntityIds.slice(i, i + 800);
  db.prepare(`SELECT id, slug FROM entities WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)
    .forEach(r => slugById.set(r.id, r.slug));
}
const pageless = new Set([...slugById].filter(([, slug]) => slug == null).map(([id]) => id));
const traits = allTraits.filter(t => !pageless.has(t.entity_id));
const heldTraits = allTraits.length - traits.length;

const entityIds = [...new Set(traits.map(t => t.entity_id).filter(x => x != null))];
const entCols = projectedCols(db, 'entities', d1Cols);
const entities = entityIds.length
  ? db.prepare(`SELECT ${entCols.join(',')} FROM entities WHERE id IN (${entityIds.map(() => '?').join(',')})`).all(...entityIds)
  : [];

const sourceIds = [...new Set(traits.map(t => t.source_id).filter(x => x != null))];
const srcCols = projectedCols(db, 'sources', d1Cols);
const sources = sourceIds.length
  ? db.prepare(`SELECT ${srcCols.join(',')} FROM sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
  : [];
db.close();

const out = [];
out.push('-- D1 traits patch (build-d1-traits-patch.cjs) — publishes entity_trait_claims');
out.push(`-- traits=${traits.length}  entities=${entities.length}  sources=${sources.length}  held_pageless_traits=${heldTraits}`);
out.push('CREATE TABLE IF NOT EXISTS entity_trait_claims (');
out.push('  id INTEGER PRIMARY KEY, entity_id INTEGER, trait_name TEXT, value_numeric REAL,');
out.push('  value_text TEXT, value_json TEXT, unit TEXT, source_id INTEGER, staging_id INTEGER,');
out.push('  source_quote TEXT, source_page INTEGER, regional_context TEXT, review_status TEXT);');
out.push('CREATE INDEX IF NOT EXISTS idx_etc_entity ON entity_trait_claims(entity_id);');
// OR REPLACE so a re-run REFRESHES entities whose taxonomy/bio_category was
// corrected by the GBIF backfill (resolve-ingested-taxonomy.js), not just adds
// missing ones. Safe — the D1 entities table is a read-subset mirror.
out.push(...insertsFor('entities', entities, 'INSERT OR REPLACE'));
out.push(...insertsFor('sources', sources, 'INSERT OR IGNORE'));
out.push(...insertsFor('entity_trait_claims', traits, 'INSERT OR REPLACE'));

const outPath = path.resolve(REPO, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join('\n') + '\n');
console.log(`traits patch: ${outPath}`);
console.log(`  ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB — traits=${traits.length} entities=${entities.length} sources=${sources.length} held_pageless=${heldTraits}`);
