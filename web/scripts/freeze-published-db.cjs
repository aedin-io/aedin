'use strict';
/**
 * freeze-published-db — produce backend/aedin-published.sqlite, the frozen
 * snapshot the web build reads when AEDIN_USE_PUBLISHED=1 (i.e. on
 * `npm run deploy`). Run this AFTER an intentional D1 data publish so a later
 * code deploy renders static pages from a stable snapshot rather than the live
 * curated DB (which a concurrent ingestion session may be mid-editing).
 *
 * Source is `backend/aedin.sqlite` — the curated DB (entities/claims/sources/…,
 * ~700 MB), NOT the 44 GB raw `globi.sqlite` GloBI download (the web build never
 * reads that). Mechanism: copy the live DB (plus any -wal/-shm so un-checkpointed
 * writes are included), then VACUUM into a clean single-file snapshot.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..'); // web/scripts -> repo root
const LIVE = process.env.AEDIN_DB_PATH || path.join(ROOT, 'backend', 'aedin.sqlite');
const SNAP = path.join(ROOT, 'backend', 'aedin-published.sqlite');
const TMP = SNAP + '.tmp';

// aedin.sqlite is already the lean curated DB (no raw `interactions` table),
// so there's nothing to drop; VACUUM alone yields a clean compact snapshot.
const DROP_TABLES = [];

const gb = (bytes) => (bytes / 1e9).toFixed(2) + ' GB';

function main() {
  if (!fs.existsSync(LIVE)) {
    console.error(`[freeze-db] live DB not found: ${LIVE}`);
    process.exit(1);
  }
  console.log(`[freeze-db] source ${LIVE} (${gb(fs.statSync(LIVE).size)})`);

  for (const p of [TMP, TMP + '-wal', TMP + '-shm']) fs.rmSync(p, { force: true });

  console.log('[freeze-db] copying live DB → temp snapshot…');
  fs.copyFileSync(LIVE, TMP);
  // Carry any WAL/SHM so un-checkpointed writes are applied when we open it.
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(LIVE + ext)) fs.copyFileSync(LIVE + ext, TMP + ext);
  }

  const db = new Database(TMP);
  db.pragma('journal_mode = DELETE'); // checkpoint WAL into the file; leave no -wal on the snapshot
  for (const t of DROP_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${t};`);
    console.log(`[freeze-db] dropped ${t}`);
  }
  console.log('[freeze-db] VACUUM…');
  db.exec('VACUUM;');
  db.close();

  for (const ext of ['-wal', '-shm']) fs.rmSync(TMP + ext, { force: true });
  fs.rmSync(SNAP, { force: true });
  fs.renameSync(TMP, SNAP);
  console.log(`[freeze-db] wrote ${SNAP} (${gb(fs.statSync(SNAP).size)})`);
}

main();
