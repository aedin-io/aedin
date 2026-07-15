/**
 * rebuild-db.js
 *
 * Rebuilds the corpus DB (aedin.sqlite) by copying all data to a fresh database file.
 * Fixes page-level corruption that prevents VACUUM and large bulk writes.
 *
 * Usage:
 *   node rebuild-db.js
 *
 * Creates globi-rebuilt.sqlite alongside aedin.sqlite, then swaps it in.
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const OLD_DB = CORPUS_DB;
const NEW_DB = path.join(__dirname, 'globi-rebuilt.sqlite');

async function rebuild() {
  // Clean up any previous attempt
  try { fs.unlinkSync(NEW_DB); } catch (_) {}
  try { fs.unlinkSync(NEW_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(NEW_DB + '-shm'); } catch (_) {}

  console.log('Opening old database...');
  const oldDb = await open({ filename: OLD_DB, driver: sqlite3.Database });

  // Get all table schemas
  const tables = await oldDb.all(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name"
  );
  const indexes = await oldDb.all(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
  );

  console.log(`Found ${tables.length} tables, ${indexes.length} indexes.\n`);

  console.log('Creating new database...');
  const newDb = await open({ filename: NEW_DB, driver: sqlite3.Database });
  await newDb.exec('PRAGMA journal_mode = WAL;');
  await newDb.exec('PRAGMA synchronous = NORMAL;');
  await newDb.exec('PRAGMA cache_size = -65536;');

  // Create tables
  for (const t of tables) {
    await newDb.exec(t.sql);
    console.log(`  Created table: ${t.name}`);
  }

  // Copy data table by table
  for (const t of tables) {
    const count = await oldDb.get(`SELECT COUNT(*) AS n FROM "${t.name}"`);
    if (count.n === 0) {
      console.log(`  ${t.name}: empty, skipping`);
      continue;
    }

    console.log(`  ${t.name}: copying ${count.n} rows...`);

    // Get column names
    const cols = await oldDb.all(`PRAGMA table_info("${t.name}")`);
    const colNames = cols.map(c => `"${c.name}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');

    // Read and insert in batches
    const BATCH = 10000;
    let offset = 0;
    let copied = 0;

    while (offset < count.n) {
      const rows = await oldDb.all(
        `SELECT ${colNames} FROM "${t.name}" LIMIT ${BATCH} OFFSET ${offset}`
      );
      if (rows.length === 0) break;

      await newDb.exec('BEGIN');
      const stmt = await newDb.prepare(
        `INSERT INTO "${t.name}" (${colNames}) VALUES (${placeholders})`
      );
      for (const row of rows) {
        await stmt.run(...Object.values(row));
      }
      await stmt.finalize();
      await newDb.exec('COMMIT');

      copied += rows.length;
      offset += BATCH;

      if (copied % 100000 === 0 || copied === count.n) {
        console.log(`    ${copied} / ${count.n}`);
      }
    }
    console.log(`    ${copied} rows copied.`);
  }

  // Create indexes
  console.log('\nCreating indexes...');
  for (const idx of indexes) {
    try {
      await newDb.exec(idx.sql);
      console.log(`  Created index: ${idx.name}`);
    } catch (e) {
      console.warn(`  ⚠ Index ${idx.name}: ${e.message}`);
    }
  }

  await oldDb.close();
  await newDb.close();

  // Verify new db
  console.log('\nVerifying new database...');
  const verifyDb = await open({ filename: NEW_DB, driver: sqlite3.Database });
  const intCheck = await verifyDb.get('PRAGMA integrity_check');
  console.log('Integrity check:', intCheck.integrity_check);

  for (const t of tables) {
    const cnt = await verifyDb.get(`SELECT COUNT(*) AS n FROM "${t.name}"`);
    console.log(`  ${t.name}: ${cnt.n} rows`);
  }
  await verifyDb.close();

  if (intCheck.integrity_check !== 'ok') {
    console.error('\n❌ New database failed integrity check! Not replacing old db.');
    process.exit(1);
  }

  // Swap files
  console.log('\nSwapping databases...');
  const BACKUP = OLD_DB + '.corrupt-backup';
  fs.renameSync(OLD_DB, BACKUP);
  try { fs.unlinkSync(OLD_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(OLD_DB + '-shm'); } catch (_) {}
  fs.renameSync(NEW_DB, OLD_DB);
  try { fs.unlinkSync(NEW_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(NEW_DB + '-shm'); } catch (_) {}

  console.log(`\n✓ Done! Old db backed up to ${path.basename(BACKUP)}`);
  console.log('  You can delete the backup after verifying everything works.');
}

rebuild().catch(err => { console.error('Fatal:', err); process.exit(1); });
