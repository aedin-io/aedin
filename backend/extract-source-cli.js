#!/usr/bin/env node
/**
 * extract-source-cli.js — Phase 3 batch ingestion driver.
 *
 * Wraps `extractSource()` so corpus PDFs/text files on disk can be
 * ingested without going through the admin HTTP endpoint. Inserts a
 * row into `extraction_queue`, runs the LLM extractor, and updates
 * the queue row's status / source_id.
 *
 * Usage:
 *   node extract-source-cli.js path/to/file.pdf [path/to/file2.pdf ...]
 *   node extract-source-cli.js --source-type=book path/to/book.pdf
 *
 * Idempotent: if a queue row already exists for the same file_path,
 * the script reuses it. If the source already has staging rows, the
 * extractor itself dedupes by source_id + file_path.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { extractSource } = require('./extract-source');
const { parseFlags: parseGuardFlags, preflightConfirm, createBudgetGuard, isFatalGuardError } = require('./lib/cost-guard');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

const argv = process.argv.slice(2);
const files = [];
let sourceType = 'paper';
let maxChunks = 1;
for (const a of argv) {
  if (a.startsWith('--source-type=')) sourceType = a.split('=', 2)[1];
  else if (a.startsWith('--max-chunks=')) maxChunks = parseInt(a.split('=', 2)[1], 10) || 1;
  else if (a.startsWith('--')) {} // unknown flag, ignore
  else files.push(a);
}

// Cost-guard flags: --max-spend, --max-consecutive-failures, --yes, --est-per-row-tokens.
// Extraction uses ~90K tokens/chunk (80K input + 10K output) — much higher than
// vouch/critic — so override the default 4000 if the user didn't pass it explicitly.
const GUARD_FLAGS = parseGuardFlags(argv);
if (!argv.some(a => a.startsWith('--est-per-row-tokens='))) {
  GUARD_FLAGS.estPerRowTokens = 90000;
}

if (files.length === 0) {
  console.error('Usage: node extract-source-cli.js [--source-type=book|paper|extension_bulletin] [--max-chunks=N] file1 [file2 ...]');
  console.error('  --max-chunks=N  How many 80K-char slices to send to Claude. Default 1 (papers).');
  console.error('                  Use 6-10 for books to capture body content past front-matter.');
  process.exit(1);
}

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Pre-flight: estimate spend across all files × all chunks. Model comes from
  // .claude/agents/extractor.md frontmatter; we read it lazily here to avoid
  // re-implementing the parser, by spawning a sample extractSource call below
  // is too late. Use a model fallback (Sonnet pricing) which over-estimates
  // (safer) if the real model is Haiku.
  const totalChunks = files.length * maxChunks;
  await preflightConfirm({
    rowCount: totalChunks,
    model: 'claude-sonnet-4-6', // assume Sonnet for over-estimation; override via --max-spend if needed
    flags: GUARD_FLAGS,
  });
  const guard = createBudgetGuard({ ...GUARD_FLAGS, mode: 'api' });

  let totalStaged = 0;
  for (const rel of files) {
    const file_path = path.resolve(rel);
    if (!fs.existsSync(file_path)) {
      console.error(`[skip] not found: ${file_path}`);
      continue;
    }
    let row = await db.get('SELECT * FROM extraction_queue WHERE file_path = ?', file_path);
    if (!row) {
      const r = await db.run(
        `INSERT INTO extraction_queue (file_path, source_type, status, added_at) VALUES (?, ?, 'pending', datetime('now'))`,
        [file_path, sourceType]
      );
      row = await db.get('SELECT * FROM extraction_queue WHERE id = ?', r.lastID);
      console.log(`[queued] id=${row.id}  ${path.basename(file_path)}`);
    } else {
      console.log(`[reuse]  id=${row.id}  status=${row.status}  ${path.basename(file_path)}`);
    }

    await db.run(
      `UPDATE extraction_queue SET status='running', started_at=datetime('now'), error_message=NULL WHERE id = ?`,
      row.id
    );
    try {
      const t0 = Date.now();
      const { sourceId, stagedCount } = await extractSource(row, db, { maxChunks, guard });
      const ms = Date.now() - t0;
      await db.run(
        `UPDATE extraction_queue SET status='done', completed_at=datetime('now'), source_id = ? WHERE id = ?`,
        [sourceId, row.id]
      );
      totalStaged += stagedCount;
      console.log(`[done]   id=${row.id}  source_id=${sourceId}  staged=${stagedCount}  (${(ms/1000).toFixed(1)}s)`);
    } catch (err) {
      // Fatal cost-guard errors abort the whole batch, not just this file.
      if (isFatalGuardError(err)) {
        await db.run(
          `UPDATE extraction_queue SET status='failed', completed_at=datetime('now'), error_message = ? WHERE id = ?`,
          ['aborted by cost-guard: ' + err.message, row.id]
        );
        console.error(`[ABORT]  cost-guard tripped: ${err.message}`);
        break;
      }
      await db.run(
        `UPDATE extraction_queue SET status='failed', completed_at=datetime('now'), error_message = ? WHERE id = ?`,
        [err.message, row.id]
      );
      console.error(`[FAIL]   id=${row.id}  ${err.message}`);
    }
  }
  console.log(`\nTotal newly staged: ${totalStaged}`);
  const report = guard.getReport();
  console.log('[cost-guard] final report:');
  console.log(`  cumulative spend:      $${report.cumulativeCostUSD.toFixed(4)} / ceiling $${report.maxSpend.toFixed(2)}`);
  console.log(`  successes / failures:  ${report.totalSuccesses} / ${report.totalFailures}`);
  console.log(`  total tokens (in/out): ${report.totalInputTokens} / ${report.totalOutputTokens}`);
  await db.close();
})().catch(e => {
  if (isFatalGuardError(e)) { console.error('\n' + e.message); process.exit(2); }
  console.error(e);
  process.exit(1);
});
