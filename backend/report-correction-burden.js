#!/usr/bin/env node
'use strict';
/**
 * report-correction-burden.js — measure the extraction-correction burden.
 *
 * The trigger that would reopen the extractor-evolver question (docs/hermes-flexibility-map.md):
 * "build an evolver only if a re-measure shows a diverse high-volume tail that hand-fixing can't
 * keep up with." This script is that re-measure. It summarizes the correction tables:
 *   - staging_field_corrections : reviewer actions (correct / edited / rejected)
 *   - extractor_corrections     : value-edits the lessons aggregator consumes
 *   - extractor_lessons         : clustered lessons fed into {{CORRECTION_LESSONS}}
 *
 * Read-only by default. `--backfill` bridges existing staging_field_corrections value-edits
 * (action='edited', non-null corrected_value) into extractor_corrections (idempotent:
 * delete-then-insert per (staging_id, field)) — the same bridge the live admin endpoint now does.
 *
 * Usage:
 *   node report-correction-burden.js
 *   node report-correction-burden.js --backfill
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const BACKFILL = process.argv.includes('--backfill');

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });

  if (BACKFILL) {
    const edits = await db.all(
      `SELECT staging_id, field_path, original_value, corrected_value, note, reviewer_id
       FROM staging_field_corrections
       WHERE action = 'edited' AND corrected_value IS NOT NULL`
    );
    let n = 0;
    for (const e of edits) {
      await db.run('DELETE FROM extractor_corrections WHERE claim_id = ? AND field = ?', [e.staging_id, e.field_path]);
      await db.run(
        `INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id, reasoning)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [e.staging_id, e.field_path, e.original_value, e.corrected_value, e.reviewer_id ?? null, e.note ?? null]
      );
      n++;
    }
    console.log(`[backfill] bridged ${n} value-edit(s) from staging_field_corrections → extractor_corrections\n`);
  }

  console.log('=== Reviewer actions (staging_field_corrections) ===');
  console.table(await db.all('SELECT action, COUNT(*) n FROM staging_field_corrections GROUP BY action ORDER BY n DESC'));

  const valueEdits = (await db.get("SELECT COUNT(*) n FROM staging_field_corrections WHERE action='edited' AND corrected_value IS NOT NULL")).n;
  const totalActions = (await db.get('SELECT COUNT(*) n FROM staging_field_corrections')).n;

  console.log('=== Extractor-lesson pipeline ===');
  const ec = (await db.get('SELECT COUNT(*) n FROM extractor_corrections')).n;
  console.log(`extractor_corrections (value-edits feeding lessons): ${ec}`);
  try {
    const byStatus = await db.all('SELECT status, COUNT(*) n FROM extractor_lessons GROUP BY status ORDER BY n DESC');
    console.log('extractor_lessons by status:'); console.table(byStatus);
  } catch (e) { console.log('extractor_lessons: (none)'); }

  console.log('=== Correction-burden headline ===');
  console.log(`  value-edits (real extraction corrections): ${valueEdits}`);
  console.log(`  flags/rejections (no original→corrected pair): ${totalActions - valueEdits}`);
  if (ec > 0) {
    console.log('=== Most-corrected fields (extractor_corrections) ===');
    console.table(await db.all('SELECT field, COUNT(*) n FROM extractor_corrections GROUP BY field ORDER BY n DESC LIMIT 10'));
  }
  console.log('\nEvolver re-measure rule: revisit an extractor evolver only if value-edits grow into a');
  console.log('DIVERSE, HIGH-VOLUME tail across many distinct fields/patterns that hand-fixing + the');
  console.log('lessons loop cannot keep up with. A few concentrated fields = keep hand-fixing.');

  await db.close();
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
