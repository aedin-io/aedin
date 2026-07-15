'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB, RAW_DB, RAW_TABLES } = require('./lib/db-paths.cjs');

// Copy every non-raw table (DDL + rows + indexes) from src to dest. Uses the source's
// own CREATE statements so indexes/constraints are preserved (NOT CREATE TABLE AS SELECT).
function copyCorpus(src, dest, rawTables = RAW_TABLES) {
  const tables = src.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().filter(t => !rawTables.has(t.name));

  dest.exec('PRAGMA foreign_keys=OFF;');
  for (const t of tables) {
    if (!t.sql) continue;
    dest.exec(t.sql);                              // recreate table DDL
    const cols = src.prepare(`PRAGMA table_info("${t.name}")`).all().map(c => `"${c.name}"`).join(',');
    const rows = src.prepare(`SELECT ${cols} FROM "${t.name}"`).all();
    if (rows.length) {
      const ph = src.prepare(`PRAGMA table_info("${t.name}")`).all().map(() => '?').join(',');
      const ins = dest.prepare(`INSERT INTO "${t.name}" (${cols}) VALUES (${ph})`);
      const tx = dest.transaction(() => { for (const r of rows) ins.run(Object.values(r)); });
      tx();
    }
    // copy this table's indexes (skip auto-indexes, which have NULL sql)
    const idxs = src.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
    ).all(t.name);
    for (const ix of idxs) dest.exec(ix.sql);
  }
}

async function main() {
  console.log(`copying corpus from ${RAW_DB} -> ${CORPUS_DB}`);
  const src = new Database(RAW_DB, { readonly: true });
  const dest = new Database(CORPUS_DB);
  copyCorpus(src, dest);
  const nT = dest.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
  console.log(`done: ${nT} corpus tables copied into ${CORPUS_DB}`);
  src.close(); dest.close();
}
if (require.main === module) main();
module.exports = { copyCorpus, RAW_TABLES };
