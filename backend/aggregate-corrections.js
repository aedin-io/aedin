#!/usr/bin/env node
'use strict';

/**
 * aggregate-corrections.js — nightly cron.
 *
 * Reads new rows from extractor_corrections (rows whose id is greater
 * than the max id we've already processed — tracked via a marker row
 * in extractor_lessons with field='_aggregator_state' that holds the
 * highest processed correction id in its notes field).
 *
 * For each new correction, clusters by (field, original, corrected) and
 * upserts a row in extractor_lessons. Increments frequency on existing
 * rows. Auto-approves rows that reach frequency >= AUTO_APPROVE_THRESHOLD
 * (default 2). Never touches rows in status='rejected' (kill-switch
 * stickiness) or status='graduated' (manual graduation is final unless
 * admin reverts it manually).
 *
 * Idempotent: re-running on the same corrections does not double-count
 * because we only process corrections with id > last_processed_id.
 */
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const AUTO_APPROVE_THRESHOLD = 2;

async function aggregate(db) {
  // Read last-processed id from a dedicated key-value table (not extractor_lessons,
  // so that SELECT * FROM extractor_lessons returns only real lesson rows).
  await db.exec(`CREATE TABLE IF NOT EXISTS _agg_state (key TEXT PRIMARY KEY, val TEXT)`);
  const markerRow = await db.get(`SELECT val FROM _agg_state WHERE key='last_correction_id'`);
  const lastId = markerRow ? parseInt(markerRow.val || '0', 10) || 0 : 0;

  const newRows = await db.all(
    `SELECT id, field, original, corrected, created_at
     FROM extractor_corrections
     WHERE id > ?
     ORDER BY id`,
    [lastId]
  );
  if (newRows.length === 0) {
    console.log(`[aggregate] no new corrections (last_processed_id=${lastId})`);
    return { processed: 0 };
  }

  let maxId = lastId;
  let approvedCount = 0;
  let createdCount = 0;
  let incrementedCount = 0;

  for (const r of newRows) {
    maxId = Math.max(maxId, r.id);
    // Find existing lesson row for this triple
    const existing = await db.get(
      `SELECT id, frequency, status FROM extractor_lessons
       WHERE field = ? AND
             COALESCE(original_pattern, '') = COALESCE(?, '') AND
             corrected_pattern = ?`,
      [r.field, r.original, r.corrected]
    );
    if (existing) {
      // Increment frequency + refresh last_seen_at.
      // Status-promotion happens for pending → approved when threshold reached.
      // rejected and graduated rows are NEVER auto-promoted.
      const newFreq = existing.frequency + 1;
      const shouldPromote = existing.status === 'pending' && newFreq >= AUTO_APPROVE_THRESHOLD;
      if (shouldPromote) {
        await db.run(
          `UPDATE extractor_lessons
           SET frequency = ?, last_seen_at = ?,
               status = 'approved', auto_approved_at = datetime('now')
           WHERE id = ?`,
          [newFreq, r.created_at, existing.id]
        );
        approvedCount++;
      } else {
        await db.run(
          `UPDATE extractor_lessons
           SET frequency = ?, last_seen_at = ?
           WHERE id = ?`,
          [newFreq, r.created_at, existing.id]
        );
        incrementedCount++;
      }
    } else {
      await db.run(
        `INSERT INTO extractor_lessons
         (field, original_pattern, corrected_pattern, frequency, last_seen_at, status)
         VALUES (?, ?, ?, 1, ?, 'pending')`,
        [r.field, r.original, r.corrected, r.created_at]
      );
      createdCount++;
    }
  }

  // Persist last-processed id in the dedicated state table
  await db.run(
    `INSERT INTO _agg_state (key, val) VALUES ('last_correction_id', ?)
     ON CONFLICT(key) DO UPDATE SET val=excluded.val`,
    [String(maxId)]
  );

  console.log(
    `[aggregate] processed ${newRows.length} corrections; created=${createdCount}, ` +
    `incremented=${incrementedCount}, auto-approved=${approvedCount}; ` +
    `last_processed_id=${maxId}`
  );
  return { processed: newRows.length, created: createdCount, incremented: incrementedCount, approved: approvedCount };
}

module.exports = { aggregate, AUTO_APPROVE_THRESHOLD }; // STATE_FIELD removed — marker lives in _agg_state table

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const DB_PATH = CORPUS_DB;
  (async () => {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.run('PRAGMA busy_timeout = 30000');
    await aggregate(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
