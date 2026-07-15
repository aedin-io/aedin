'use strict';

/**
 * Migration 043: clear cross-category column contamination.
 *
 * The entities table is one wide table shared across bio_categories, so
 * category-specific columns can end up holding values on rows they don't
 * apply to — almost always legacy bulk-default fills. The trigger case:
 * 12,132 plant rows carried pest_mobility='sedentary'/'none', surfacing a
 * nonsensical "Pest mobility — none" row on the Zea mays entity page.
 *
 * This migration NULLs genuinely-contaminated cells. Survey + rationale:
 * docs/data-hygiene-cross-category.md.
 *
 * IMPORTANT — what this does NOT touch:
 *   - native_regions / invasive_regions: NOT contamination. Plants
 *     legitimately have native/invasive ranges (58,878 + 15,360 rows with
 *     real region data). Excluded deliberately.
 *
 * Idempotent: re-running NULLs nothing new once clean. Logs per-column
 * affected counts.
 */

// Each rule: NULL <column> on rows whose bio_category is NOT in `keepCategories`.
const RULES = [
  { column: 'pest_mobility',     keepCategories: ['invertebrate'] },
  { column: 'larval_role',       keepCategories: ['invertebrate'] },
  { column: 'adult_role',        keepCategories: ['invertebrate'] },
  { column: 'organism_type',     keepCategories: ['invertebrate','vertebrate','fungi','microbe','other'] },
  { column: 'edible',            keepCategories: ['plantae'] },
  { column: 'vegetable',         keepCategories: ['plantae'] },
  { column: 'growth_habit',      keepCategories: ['plantae'] },
  { column: 'nitrogen_fixation', keepCategories: ['plantae'] },
  { column: 'ph_min',            keepCategories: ['plantae'] },
  { column: 'ph_max',            keepCategories: ['plantae'] },
];

const ALL_CATEGORIES = ['plantae','invertebrate','vertebrate','fungi','microbe','other'];

function migrate(db) {
  let grandTotal = 0;
  const apply = db.transaction(() => {
    for (const { column, keepCategories } of RULES) {
      const offCats = ALL_CATEGORIES.filter(c => !keepCategories.includes(c));
      const ph = offCats.map(() => '?').join(',');
      const info = db.prepare(
        `UPDATE entities SET ${column} = NULL
         WHERE ${column} IS NOT NULL
           AND bio_category IN (${ph})`
      ).run(...offCats);
      if (info.changes > 0) {
        console.log(`[migration-043] ${column}: cleared ${info.changes} off-category value(s) (kept on ${keepCategories.join('/')})`);
        grandTotal += info.changes;
      }
    }
  });
  apply();
  console.log(`[migration-043] done — ${grandTotal} contaminated cell(s) cleared. (native_regions/invasive_regions intentionally untouched.)`);
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
