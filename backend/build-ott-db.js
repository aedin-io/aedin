#!/usr/bin/env node
'use strict';
/**
 * build-ott-db.js — stream the OTT dump into backend/ott.sqlite.
 *
 * Rebuildable and disposable: never edited by hand, never backed up, gitignored
 * via *.sqlite. Kept OUT of aedin.sqlite deliberately — the corpus has no backup
 * and must not grow by a gigabyte of third-party data.
 *
 * Loads BOTH files. synonyms.tsv is not optional: the accepted name of the fig
 * is "Ficus variegata Blume, 1825", while the bare string "Ficus variegata" in
 * taxonomy.tsv is a MOLLUSC. Resolving against taxonomy.tsv alone would link our
 * fig to the mollusc with a single confident candidate and no ambiguity signal.
 *
 *   node build-ott-db.js          # build (drops and recreates)
 */
const fs = require('fs');
const readline = require('readline');
const Database = require('better-sqlite3');
const { OTT_DB } = require('./lib/db-paths.cjs');
const { OTT_RELEASE } = require('./lib/ott-release.js');
const { parseTaxonomyLine, parseSynonymLine } = require('./lib/ott-tsv.js');

async function loadFile(filePath, onRow, label) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath), crlfDelay: Infinity,
  });
  let n = 0;
  for await (const line of rl) {
    if (onRow(line)) n++;
    if (n % 500000 === 0 && n) console.log(`  ${label}: ${n} rows`);
  }
  return n;
}

(async () => {
  for (const p of [OTT_RELEASE.taxonomyPath, OTT_RELEASE.synonymsPath]) {
    if (!fs.existsSync(p)) {
      console.error(`missing ${p} — run: node fetch-ott-dump.js`);
      process.exit(1);
    }
  }

  const db = new Database(OTT_DB);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`
    DROP TABLE IF EXISTS ott_taxa;
    DROP TABLE IF EXISTS ott_synonyms;
    DROP TABLE IF EXISTS ott_meta;
    CREATE TABLE ott_taxa (
      ott_id        INTEGER PRIMARY KEY,
      parent_ott_id INTEGER,
      name          TEXT NOT NULL,
      rank          TEXT,
      source_info   TEXT,
      uniqname      TEXT,
      flags         TEXT
    );
    CREATE TABLE ott_synonyms (
      name   TEXT NOT NULL,
      ott_id INTEGER NOT NULL,
      type   TEXT
    );
    CREATE TABLE ott_meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  const insTax = db.prepare(`INSERT OR IGNORE INTO ott_taxa
    (ott_id, parent_ott_id, name, rank, source_info, uniqname, flags)
    VALUES (@ott_id, @parent_ott_id, @name, @rank, @source_info, @uniqname, @flags)`);
  const insSyn = db.prepare(`INSERT INTO ott_synonyms (name, ott_id, type)
    VALUES (@name, @ott_id, @type)`);

  console.log(`Loading OTT ${OTT_RELEASE.version} into ${OTT_DB}`);
  db.exec('BEGIN');
  const taxa = await loadFile(OTT_RELEASE.taxonomyPath, (line) => {
    const r = parseTaxonomyLine(line);
    if (!r) return false;
    insTax.run(r); return true;
  }, 'taxa');
  const syns = await loadFile(OTT_RELEASE.synonymsPath, (line) => {
    const r = parseSynonymLine(line);
    if (!r) return false;
    insSyn.run(r); return true;
  }, 'synonyms');
  db.exec('COMMIT');

  // Verify completeness: check that persisted counts match what was attempted.
  // With journal_mode=OFF, an interrupted load leaves the DB truncated, not rolled back.
  // This check catches both incomplete loads and silent deduplication via INSERT OR IGNORE.
  const persistedTaxa = db.prepare('SELECT COUNT(*) as n FROM ott_taxa').get().n;
  const persistedSyns = db.prepare('SELECT COUNT(*) as n FROM ott_synonyms').get().n;

  if (persistedTaxa === 0 || persistedSyns === 0) {
    console.error(`FATAL: empty table after load — database incomplete or corrupted`);
    console.error(`  taxa: attempted ${taxa}, persisted ${persistedTaxa}`);
    console.error(`  synonyms: attempted ${syns}, persisted ${persistedSyns}`);
    db.close();
    process.exit(1);
  }

  if (persistedTaxa !== taxa) {
    console.error(`FATAL: taxa count mismatch — possible duplicate keys or incomplete load`);
    console.error(`  attempted: ${taxa}, persisted: ${persistedTaxa} (delta: ${taxa - persistedTaxa})`);
    db.close();
    process.exit(1);
  }

  if (persistedSyns !== syns) {
    console.error(`FATAL: synonyms count mismatch — possible incomplete load`);
    console.error(`  attempted: ${syns}, persisted: ${persistedSyns} (delta: ${syns - persistedSyns})`);
    db.close();
    process.exit(1);
  }

  // Write version LAST, deliberately AFTER COMMIT (not inside the load
  // transaction) and after all data validation — its presence is meant to
  // imply the bulk load already succeeded and was durably committed, not
  // merely staged inside a transaction that could still roll back.
  // Consumers MUST treat the absence of ott_meta.version as a signal of incomplete load.
  db.prepare('INSERT INTO ott_meta (key, value) VALUES (?, ?)')
    .run('version', OTT_RELEASE.version);

  console.log('Indexing…');
  db.exec(`
    CREATE INDEX idx_ott_taxa_name    ON ott_taxa(name);
    CREATE INDEX idx_ott_taxa_parent  ON ott_taxa(parent_ott_id);
    CREATE INDEX idx_ott_syn_name     ON ott_synonyms(name);
  `);
  db.close();
  console.log(`Done. taxa=${taxa} synonyms=${syns}`);
})().catch(e => { console.error(e); process.exit(1); });
