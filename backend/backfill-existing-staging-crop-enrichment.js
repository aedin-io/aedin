'use strict';

/**
 * Reshape stranded `crop_enrichment` staging rows (target_table='crops')
 * into `entity_trait` shape and re-stage for the multi-critic gate.
 *
 * Idempotent: skips rows already reshape-marked.
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { loadVocabulary } = require('./lib/trait-vocabulary');

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const vocab = await loadVocabulary(db);

  const rows = await db.all(`
    SELECT id, queue_id, source_id, payload
    FROM extraction_staging
    WHERE target_table = 'crops'
      AND (review_status IS NULL OR review_status NOT IN ('promoted','rejected','reshape_done'))
  `);
  console.log(`[backfill-staging] ${rows.length} crop_enrichment staging rows to reshape.`);

  let reshaped = 0;
  for (const r of rows) {
    let payload;
    try { payload = JSON.parse(r.payload); } catch { continue; }
    const sci = payload.scientific_name;
    if (!sci) continue;
    // Each known trait field becomes a new entity_trait staging row
    const candidates = [
      'ph_min', 'ph_max', 'optimal_temp_min', 'optimal_temp_max',
      'optimal_precip_min', 'optimal_precip_max', 'days_to_harvest',
      'growth_habit', 'nitrogen_fixation', 'min_root_depth_cm',
      'soil_texture', 'soil_humidity', 'soil_nutriments',
    ];
    for (const trait of candidates) {
      const v = vocab[trait];
      if (!v) continue;
      const value = payload[trait];
      if (value == null) continue;
      const newPayload = {
        scientific_name: sci,
        common_name: payload.common_name || null,
        trait_name: trait,
        unit: v.expected_unit || null,
        regional_context: payload.region_context || 'Global',
        confidence_score: 0.7,
        evidence_tier: 'inferred',
        extracted_claim: `Reshape of crop_enrichment row for ${sci}.`,
        source_quote: `(reshape from staging id ${r.id})`,
        source_page: null,
      };
      if (v.value_kind === 'numeric') newPayload.value_numeric = Number(value);
      else if (v.value_kind === 'categorical') newPayload.value_text = String(value);
      else if (v.value_kind === 'list') newPayload.value_json = Array.isArray(value) ? value : [value];
      else continue;
      await db.run(
        `INSERT INTO extraction_staging (queue_id, source_id, target_table, payload, created_at)
         VALUES (?, ?, 'entity_trait', ?, datetime('now'))`,
        [r.queue_id, r.source_id, JSON.stringify(newPayload)]
      );
      reshaped++;
    }
    await db.run(`UPDATE extraction_staging SET review_status = 'reshape_done' WHERE id = ?`, [r.id]);
  }
  console.log(`[backfill-staging] inserted ${reshaped} new entity_trait staging rows.`);
  await db.close();
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
