#!/usr/bin/env node
'use strict';

/**
 * backfill-extractor-runs.js — one-shot.
 *
 * For every existing source that has at least one extraction_staging row
 * but no associated extractor_runs row, INSERTs a synthetic extractor_runs
 * row with extractor_md_sha='legacy' and prompt_bundle_sha='legacy'. All
 * staging rows for that source get run_id = the synthetic run's id.
 * All claim_critic_verdicts rows for those staging rows get
 * critic_prompt_sha='legacy'.
 *
 * The 'legacy' sentinel SHAs sort lower than any real SHA, so the entire
 * backfilled corpus classifies as re_extract_needed in reprocess-stale.js.
 * Admin can choose what (if anything) to re-extract.
 *
 * Idempotent: skips sources that already have an extractor_runs row.
 *
 * Usage:
 *   node backfill-extractor-runs.js              # production run
 *   node backfill-extractor-runs.js --dry-run    # preview without writing
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  const DB_PATH = CORPUS_DB;
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout = 30000');

  const candidates = await db.all(`
    SELECT s.id AS source_id, s.title, s.extraction_model,
           COUNT(es.id) AS staging_count
    FROM sources s
    JOIN extraction_staging es ON es.source_id = s.id
    LEFT JOIN extractor_runs r ON r.source_id = s.id
    WHERE r.id IS NULL
    GROUP BY s.id
    ORDER BY s.id
  `);
  console.log(`[backfill] candidates: ${candidates.length} sources need synthetic extractor_runs rows`);

  if (DRY_RUN) {
    for (const c of candidates) {
      console.log(`  - source ${c.source_id} "${c.title || ''}" (${c.staging_count} staging rows, model=${c.extraction_model || '?'})`);
    }
    console.log('[backfill] dry-run complete — no writes performed');
    await db.close();
    return;
  }

  let inserted = 0;
  let stagingUpdated = 0;
  let verdictsUpdated = 0;
  for (const c of candidates) {
    const r = await db.run(
      `INSERT INTO extractor_runs
       (source_id, extractor_md_sha, prompt_bundle_sha, extraction_model,
        started_at, completed_at, status, rows_staged, notes)
       VALUES (?, 'legacy', 'legacy', ?, datetime('now'), datetime('now'),
               'complete', ?, 'backfilled pre-Phase-Provenance')`,
      [c.source_id, c.extraction_model || 'unknown', c.staging_count]
    );
    const runId = r.lastID;
    const u1 = await db.run(
      `UPDATE extraction_staging SET run_id = ? WHERE source_id = ? AND run_id IS NULL`,
      [runId, c.source_id]
    );
    const u2 = await db.run(
      `UPDATE claim_critic_verdicts SET critic_prompt_sha = 'legacy'
       WHERE staging_id IN (SELECT id FROM extraction_staging WHERE source_id = ?)
         AND critic_prompt_sha IS NULL`,
      [c.source_id]
    );
    inserted++;
    stagingUpdated += u1.changes || 0;
    verdictsUpdated += u2.changes || 0;
  }
  console.log(`[backfill] inserted ${inserted} extractor_runs rows; updated ${stagingUpdated} staging rows, ${verdictsUpdated} verdict rows`);
  await db.close();
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
