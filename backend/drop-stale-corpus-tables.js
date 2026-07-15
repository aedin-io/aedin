'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB, RAW_DB, RAW_TABLES } = require('./lib/db-paths.cjs');

function userTables(db) {
  return db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map(r => r.name);
}

function corpusTablesToDrop(rawDb) {
  return userTables(rawDb).filter(t => !RAW_TABLES.has(t)).sort();
}

function rowCount(db, table) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  if (!row) return null;                       // table absent
  return db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n;
}

// Every table to drop must exist in corpus with count >= raw's stale count.
function guardOk(corpusDb, rawDb, tables) {
  const blockers = [];
  for (const t of tables) {
    const corpusN = rowCount(corpusDb, t);
    const rawN = rowCount(rawDb, t);
    if (corpusN === null) { blockers.push(`${t}: missing from corpus (aedin.sqlite)`); continue; }
    if (corpusN < rawN)   { blockers.push(`${t}: corpus ${corpusN} < raw ${rawN} (corpus behind)`); }
  }
  return { ok: blockers.length === 0, blockers };
}

// Drop the given tables inside one transaction. better-sqlite3 enables
// foreign_keys by default; dropping the full corpus set in arbitrary order
// would trip SQLITE_CONSTRAINT_FOREIGNKEY (a child still referencing a
// just-dropped parent). We remove every corpus table, so referential integrity
// during teardown is moot — disable enforcement. PRAGMA foreign_keys must be
// set OUTSIDE the transaction (it is a no-op inside one).
function dropStaleTables(rawDb, tables) {
  rawDb.pragma('foreign_keys = OFF');
  const drop = rawDb.transaction(() => {
    for (const t of tables) rawDb.exec(`DROP TABLE "${t}"`);
  });
  drop();
}

function main() {
  const apply = process.argv.includes('--apply');
  const corpusDb = new Database(CORPUS_DB, { readonly: true });
  const rawDb = new Database(RAW_DB, apply ? undefined : { readonly: true });
  const tables = corpusTablesToDrop(rawDb);
  console.log(`Stale corpus tables in ${RAW_DB}: ${tables.length}`);
  console.log(tables.join(', ') || '(none)');
  const guard = guardOk(corpusDb, rawDb, tables);
  if (!guard.ok) {
    console.error('GUARD FAILED — refusing to drop:');
    guard.blockers.forEach(b => console.error('  - ' + b));
    process.exit(1);
  }
  if (!apply) {
    console.log('\nDRY RUN — guard passed. Re-run with --apply to DROP the above from globi.sqlite (no VACUUM).');
    corpusDb.close(); rawDb.close();
    return;
  }
  dropStaleTables(rawDb, tables);
  console.log(`\nDropped ${tables.length} stale corpus tables. Raw tables retained: ${[...RAW_TABLES].join(', ')}.`);
  console.log('NOTE: no VACUUM run — file size unchanged, ~715MB now reusable free pages.');
  corpusDb.close(); rawDb.close();
}

if (require.main === module) main();
module.exports = { corpusTablesToDrop, guardOk, dropStaleTables };
