#!/usr/bin/env node
/**
 * pilot_extract.js — calibration pilot for the LLM literature ingestion pipeline.
 *
 * Runs extract-source.js on a single corpus file. Produces:
 *   - 1 row in `sources`
 *   - N rows in `extraction_staging` (one per extracted claim, payload=JSON)
 *   - Optionally rows in `entities` + `pending_crops` for new species mentioned
 *
 * Known limitation: extract-source.js truncates input to 80,000 chars
 * (~20K tokens). Books >80K chars are sampled from the start only.
 *
 * Cost estimate: ~$0.30 (Claude Sonnet 4.6, 80K input + ≤16K output).
 *
 * Prereqs: ANTHROPIC_API_KEY set in env or backend/.env.
 *
 * Usage:
 *   node tools/pilot_extract_hull.js                    # defaults to Hull
 *   node tools/pilot_extract_hull.js <path-to-source>   # explicit path
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const { extractSource } = require('../extract-source');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const DEFAULT_SOURCE = path.resolve(
  __dirname,
  '../../.claude/agents/agroecologist/reference/hull_matthews_plant_virology_full_text.md'
);
const SOURCE_FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : DEFAULT_SOURCE;

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY is not set. Add it to backend/.env or export it before running.');
    process.exit(2);
  }
  if (!fs.existsSync(SOURCE_FILE)) {
    console.error('ERROR: source file missing:', SOURCE_FILE);
    process.exit(2);
  }

  const fileSize = fs.statSync(SOURCE_FILE).size;
  console.log(`Source: ${SOURCE_FILE} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Note: extract-source.js will read up to 80,000 chars (~${((80000 / fileSize) * 100).toFixed(2)}% of the book).\n`);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // 1. Insert queue row
  const queueResult = await db.run(
    `INSERT INTO extraction_queue (file_path, source_type, status, started_at)
     VALUES (?, 'book', 'processing', datetime('now'))`,
    [SOURCE_FILE]
  );
  const queueItem = {
    id: queueResult.lastID,
    url: null,
    file_path: SOURCE_FILE,
    source_type: 'book',
  };
  console.log(`Queue row inserted: id=${queueItem.id}`);

  // 2. Run extraction
  console.log('Calling extractSource() (this includes one Claude API call)...');
  const t0 = Date.now();
  let result;
  try {
    result = await extractSource(queueItem, db);
  } catch (err) {
    await db.run(`UPDATE extraction_queue SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`,
      [String(err).slice(0, 500), queueItem.id]);
    await db.close();
    throw err;
  }
  const elapsed = (Date.now() - t0) / 1000;

  await db.run(
    `UPDATE extraction_queue SET status='completed', source_id=?, completed_at=datetime('now') WHERE id=?`,
    [result.sourceId, queueItem.id]
  );

  console.log(`\n=== extractSource completed in ${elapsed.toFixed(1)}s ===`);
  console.log(`  source_id: ${result.sourceId}`);
  console.log(`  staged claims: ${result.stagedCount}`);
  console.log(`  new crops: ${result.newCropCount}`);

  // 3. Breakdown by target_table
  const breakdown = await db.all(
    `SELECT target_table, COUNT(*) AS n FROM extraction_staging WHERE source_id = ? GROUP BY target_table`,
    [result.sourceId]
  );
  console.log('\n--- Breakdown by target_table ---');
  for (const r of breakdown) console.log(`  ${r.target_table}: ${r.n}`);

  // 4. Random 20-claim sample for eyeball review
  console.log('\n--- 20 random sample claims (for eyeball review) ---');
  const samples = await db.all(
    `SELECT target_table, payload FROM extraction_staging WHERE source_id = ? ORDER BY RANDOM() LIMIT 20`,
    [result.sourceId]
  );
  for (const [i, row] of samples.entries()) {
    let p;
    try { p = JSON.parse(row.payload); } catch { p = { _parse_error: row.payload }; }
    const compact = {};
    for (const k of ['subject_crop', 'object_crop', 'crop', 'pest_scientific_name',
                     'beneficial_organism', 'target_pest', 'scientific_name',
                     'interaction_type', 'effect_direction', 'mechanism', 'damage_type',
                     'source_quote', 'source_page', 'confidence_score', 'evidence_tier',
                     'extracted_claim']) {
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') compact[k] = p[k];
    }
    console.log(`\n[${i + 1}] target_table=${row.target_table}`);
    console.log(JSON.stringify(compact, null, 2));
  }

  await db.close();
  console.log('\nDone.');
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
