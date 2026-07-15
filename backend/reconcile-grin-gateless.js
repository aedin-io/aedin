'use strict';
// reconcile-grin-gateless.js — CLI. Dry-run by default; --apply to mutate.
// Backs up all gate-less GRIN rows to backups/ BEFORE the transactional delete.
// Spec: docs/superpowers/specs/2026-06-22-variety-4-grin-gateless-reconciliation-design.md
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB, BACKEND_DIR } = require('./lib/db-paths.cjs');
const { selectGateless, summary, reconcile } = require('./lib/grin-reconcile');

const CHANGED_BY = 'reconcile-grin-gateless';

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  db.pragma('foreign_keys = ON');   // belt-and-suspenders; the guard already pre-checks

  const s = summary(db);
  console.log(`Gate-less GRIN rows: ${s.total} (crop ${s.crop} / non-crop ${s.nonCrop}); crop parents to re-sync: ${s.cropParents.length}`);
  if (s.references.length) console.log('REFERENCES FOUND (apply will abort):', JSON.stringify(s.references));

  if (!apply) {
    db.close();
    console.log(`DRY RUN — re-run with --apply to back up + delete ${s.total} rows.`);
    return;
  }

  // Backup BEFORE any mutation.
  const rows = selectGateless(db);
  const backupsDir = path.join(BACKEND_DIR, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupsDir, `grin-gateless-reconcile-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
  console.log(`Backed up ${rows.length} rows -> ${backupPath}`);

  let result;
  try {
    db.transaction(() => { result = reconcile(db, { changedBy: CHANGED_BY }); })();
  } catch (err) {
    db.close();
    console.error(err.message);
    process.exit(1);
  }
  db.close();
  console.log(`Applied: deleted ${result.deleted}, cleared grin_synced_at on ${result.cropParentsCleared} crop parents.`);
}

if (require.main === module) main();
module.exports = { main };
