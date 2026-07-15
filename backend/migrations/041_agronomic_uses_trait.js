'use strict';

/**
 * Migration 041: register `agronomic_uses` in traits_vocabulary.
 *
 * Couples to migration 040 (entities.agronomic_uses column). Once this
 * row exists, the extractor.md `{{TRAITS_VOCABULARY}}` template
 * substitution surfaces it to the LLM extraction prompt, so newly-
 * ingested literature can record agronomic-use claims as
 * `entity_traits` items with `value_kind=list`. The controlled
 * vocabulary mirrors lib/agronomic-uses.js#ALL_TAGS.
 *
 * Why this matters for future ingestion:
 *   - sync-wikidata-uses.js is the authoritative backfill for known plants.
 *   - LLM extraction handles ad-hoc claims surfaced by new literature
 *     (e.g. an extension bulletin describing a newly-recognized medicinal
 *     use of a common crop, or a research paper proposing a wild
 *     plant for cover-cropping).
 *   - Both write into the same downstream concept; promotion to
 *     entities.agronomic_uses is a separate concern (the JOIN can happen
 *     at consumption time via lib/agronomic-uses.js#effectiveTags).
 *
 * Idempotent: INSERT OR REPLACE on trait_name (unique).
 */

const { ALL_TAGS } = require('../lib/agronomic-uses');

function migrate(db) {
  const enumValues = JSON.stringify([...ALL_TAGS]);
  const description = 'Agronomic / functional use categories the plant is cultivated or recognized for. Multi-valued. Capture only when the source explicitly describes a use (e.g. "Lavandula angustifolia is a culinary herb and ornamental"). Do NOT infer from family or taxonomy alone.';

  const stmt = db.prepare(`
    INSERT INTO traits_vocabulary
      (trait_name, value_kind, expected_unit, applicable_bio_categories, enum_values, description, upstream_mappings, introduced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(trait_name) DO UPDATE SET
      value_kind = excluded.value_kind,
      expected_unit = excluded.expected_unit,
      applicable_bio_categories = excluded.applicable_bio_categories,
      enum_values = excluded.enum_values,
      description = excluded.description,
      upstream_mappings = excluded.upstream_mappings
  `);

  stmt.run(
    'agronomic_uses',
    'list',
    null,
    JSON.stringify(['plantae']),
    enumValues,
    description,
    JSON.stringify({
      wikidata: 'P366 (has use) — mapped via lib/agronomic-uses.js#WIKIDATA_LABEL_MAP',
      family_fallback: 'lib/agronomic-uses.js#FAMILY_FALLBACK (consumed at read time)',
    })
  );

  console.log('[migration-041] registered agronomic_uses trait in traits_vocabulary');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
