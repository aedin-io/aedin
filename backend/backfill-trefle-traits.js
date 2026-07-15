'use strict';

/**
 * One-shot backfill: every Trefle-populated env column on `entities` becomes
 * one row in `entity_trait_claims` with source_id = single Trefle source row.
 *
 * Idempotent via UNIQUE(entity_id, trait_name, source_id, source_quote).
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { ALL_CACHE_TRAITS, traitToColumn } = require('./lib/trait-to-column');
const { loadVocabulary } = require('./lib/trait-vocabulary');
const { encodeTraitValue } = require('./lib/trait-value');

// Only Trefle-mapped traits get backfilled here
const TREFLE_TRAITS = [
  'ph_min', 'ph_max',
  'optimal_temp_min', 'optimal_temp_max',
  'optimal_precip_min', 'optimal_precip_max',
  'optimal_light', 'optimal_soil_moisture', 'optimal_soil_texture',
  'nitrogen_fixation', 'days_to_harvest', 'growth_habit',
  'maximum_height_cm', 'bloom_months', 'fruit_months',
  'toxicity', 'native_zones', 'introduced_zones',
];

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const vocab = await loadVocabulary(db);

  // Ensure single Trefle source row exists
  let trefleSource = await db.get(`SELECT id FROM sources WHERE title = 'Trefle API'`);
  if (!trefleSource) {
    const r = await db.run(
      `INSERT INTO sources (title, authors, publication, year, source_type, url, file_path, ingested_at, extraction_model)
       VALUES ('Trefle API', 'Trefle.io', 'Trefle Plant API', strftime('%Y','now'), 'api_sync', 'https://trefle.io', NULL, datetime('now'), 'backfill-trefle-traits')`
    );
    trefleSource = { id: r.lastID };
  }
  console.log('[backfill-trefle] source_id =', trefleSource.id);

  let inserted = 0;
  for (const trait of TREFLE_TRAITS) {
    const col = traitToColumn(trait);
    if (!col) continue;
    const v = vocab[trait];
    if (!v) continue;
    const rows = await db.all(
      `SELECT id, ${col} AS val FROM entities WHERE trefle_id IS NOT NULL AND ${col} IS NOT NULL`
    );
    for (const e of rows) {
      let raw = e.val;
      if (v.value_kind === 'list' || v.value_kind === 'range') {
        try { raw = JSON.parse(e.val); } catch { /* if not valid JSON, skip */ continue; }
      }
      const enc = encodeTraitValue(v, raw);
      const r = await db.run(
        `INSERT OR IGNORE INTO entity_trait_claims (
           entity_id, trait_name, value_numeric, value_text, value_json, unit,
           source_id, source_quote, source_page, regional_context,
           review_status, ai_vouch_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'Global', 'ai_reviewed', 'plausible', datetime('now'))`,
        [e.id, trait, enc.value_numeric, enc.value_text, enc.value_json, v.expected_unit ?? null, trefleSource.id]
      );
      if (r.changes > 0) inserted++;
    }
    console.log(`[backfill-trefle] trait ${trait}: ${rows.length} entities scanned`);
  }
  console.log(`[backfill-trefle] inserted ${inserted} new entity_trait_claims rows.`);
  await db.close();
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
