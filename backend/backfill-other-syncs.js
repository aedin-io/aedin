'use strict';

/**
 * Sweeps remaining manually-populated columns on `entities` (non-Trefle paths
 * — GRIN varieties, lifecycle-roles outputs, EPPO biology if synced) and
 * creates entity_trait_claims rows tagged with their original source_id.
 *
 * Best-effort: where source provenance is unknown, attaches to a synthetic
 * 'pre-substrate-backfill' source row so the data remains queryable.
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { ALL_CACHE_TRAITS, traitToColumn } = require('./lib/trait-to-column');
const { loadVocabulary } = require('./lib/trait-vocabulary');
const { encodeTraitValue } = require('./lib/trait-value');

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const vocab = await loadVocabulary(db);

  let presub = await db.get(`SELECT id FROM sources WHERE title='Pre-substrate manual/agent backfill'`);
  if (!presub) {
    const r = await db.run(
      `INSERT INTO sources (title, authors, source_type, ingested_at)
       VALUES ('Pre-substrate manual/agent backfill', 'AgroEco', 'unknown', datetime('now'))`
    );
    presub = { id: r.lastID };
  }
  // Also ensure Trefle source exists; we'll skip rows already covered by it.
  const trefleSource = await db.get(`SELECT id FROM sources WHERE title = 'Trefle API'`);
  const trefleId = trefleSource?.id;

  let inserted = 0;
  for (const trait of ALL_CACHE_TRAITS) {
    const col = traitToColumn(trait);
    if (!col) continue;
    const v = vocab[trait];
    if (!v) continue;
    // Only touch entities that are NOT trefle-sourced (or lack a Trefle reading already).
    const rows = await db.all(
      `SELECT id, ${col} AS val FROM entities
       WHERE ${col} IS NOT NULL
         AND id NOT IN (
           SELECT entity_id FROM entity_trait_claims
           WHERE trait_name = ? ${trefleId ? 'AND source_id = ' + Number(trefleId) : ''}
         )`,
      [trait]
    );
    for (const e of rows) {
      let raw = e.val;
      if (v.value_kind === 'list' || v.value_kind === 'range') {
        try { raw = JSON.parse(e.val); } catch { continue; }
      }
      const enc = encodeTraitValue(v, raw);
      const r = await db.run(
        `INSERT OR IGNORE INTO entity_trait_claims (
           entity_id, trait_name, value_numeric, value_text, value_json, unit,
           source_id, source_quote, source_page, regional_context,
           review_status, ai_vouch_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'Global', 'unreviewed', NULL, datetime('now'))`,
        [e.id, trait, enc.value_numeric, enc.value_text, enc.value_json, v.expected_unit ?? null, presub.id]
      );
      if (r.changes > 0) inserted++;
    }
  }
  console.log(`[backfill-other-syncs] inserted ${inserted} rows under presub source ${presub.id}.`);
  await db.close();
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
