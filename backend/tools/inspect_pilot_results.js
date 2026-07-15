'use strict';
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });

  console.log('=== Most recent extraction_queue rows ===');
  const queue = await db.all(`SELECT id, file_path, source_type, status, error_message, source_id, started_at, completed_at FROM extraction_queue ORDER BY id DESC LIMIT 3`);
  for (const q of queue) {
    console.log(`  id=${q.id} status=${q.status} source_id=${q.source_id} started=${q.started_at} completed=${q.completed_at}`);
    console.log(`    file=${(q.file_path || '').slice(-70)}`);
    if (q.error_message) console.log(`    ERROR: ${q.error_message}`);
  }

  const lastQueue = queue.find(q => q.source_id);
  if (!lastQueue) {
    console.log('\nNo completed pilot run with a source_id found.');
    await db.close();
    return;
  }
  const sourceId = lastQueue.source_id;

  console.log(`\n=== Source row (id=${sourceId}) ===`);
  const src = await db.get('SELECT * FROM sources WHERE id = ?', sourceId);
  console.log(`  title:          ${src.title}`);
  console.log(`  authors:        ${src.authors || '(none)'}`);
  console.log(`  publication:    ${src.publication || '(none)'}`);
  console.log(`  year:           ${src.year || '(none)'}`);
  console.log(`  source_type:    ${src.source_type}`);
  console.log(`  region_focus:   ${src.region_focus || '(none)'}`);
  console.log(`  crop_focus:     ${src.crop_focus || '(none)'}`);
  console.log(`  ingested_at:    ${src.ingested_at}`);
  console.log(`  extraction_model: ${src.extraction_model}`);

  console.log(`\n=== Staging breakdown by target_table for source_id=${sourceId} ===`);
  const breakdown = await db.all(`SELECT target_table, COUNT(*) AS n FROM extraction_staging WHERE source_id = ? GROUP BY target_table`, [sourceId]);
  for (const b of breakdown) console.log(`  ${b.target_table}: ${b.n}`);
  const total = breakdown.reduce((s, r) => s + r.n, 0);
  console.log(`  TOTAL: ${total}`);

  console.log('\n=== Entities created from this run ===');
  const newEnt = await db.all(
    `SELECT scientific_name, common_name, bio_category, primary_role FROM entities WHERE source_table = 'llm_extraction' ORDER BY id DESC LIMIT 20`
  );
  console.log(`  total entities with source_table='llm_extraction': ${newEnt.length} (showing up to 20)`);
  for (const e of newEnt) console.log(`    ${e.scientific_name} (${e.common_name || '–'}) [${e.bio_category}/${e.primary_role}]`);

  const pending = await db.all(
    `SELECT scientific_name, common_name, region_context FROM pending_crops WHERE source_id = ?`,
    [sourceId]
  );
  console.log(`\n  pending_crops for source_id=${sourceId}: ${pending.length}`);
  for (const p of pending) console.log(`    ${p.scientific_name} (${p.common_name || '–'}) — region: ${p.region_context || '–'}`);

  console.log('\n=== 20 random sampled staged claims ===');
  const samples = await db.all(
    `SELECT target_table, payload FROM extraction_staging WHERE source_id = ? ORDER BY RANDOM() LIMIT 20`,
    [sourceId]
  );
  for (const [i, row] of samples.entries()) {
    let p;
    try { p = JSON.parse(row.payload); } catch { p = { _parse_error: row.payload }; }
    const compact = {};
    for (const k of ['subject_crop', 'subject_common_name', 'object_crop', 'object_common_name',
                     'crop', 'crop_common_name', 'pest_scientific_name', 'pest_common_name',
                     'beneficial_organism', 'beneficial_common_name', 'target_pest', 'target_pest_common_name',
                     'scientific_name', 'common_name',
                     'interaction_type', 'effect_direction', 'mechanism', 'damage_type',
                     'severity', 'affected_part', 'control_type',
                     'source_quote', 'source_page', 'confidence_score', 'evidence_tier',
                     'extracted_claim', 'regional_context']) {
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') compact[k] = p[k];
    }
    console.log(`\n[${i + 1}] target_table=${row.target_table}`);
    console.log(JSON.stringify(compact, null, 2));
  }

  await db.close();
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
