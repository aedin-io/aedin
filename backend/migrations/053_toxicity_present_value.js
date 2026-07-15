'use strict';

/**
 * Migration 053 — add a non-graded "present" value to the `toxicity` and
 * `allelopathic_activity` categorical traits, and propagate the updated
 * descriptions.
 *
 * Why: those enums were grade-only (toxicity: none/mild/moderate/severe;
 * allelopathy: none/weak/moderate/strong), so when a source merely says
 * "toxic" / "allelopathic" with no degree, the extractor was forced to invent
 * a grade ("moderate"). The multi-critic gate reliably flagged that as an
 * unsupported magnitude (Pass-13 post-mortem #4), gate-failing otherwise-valid
 * trait claims. "present" lets the extractor record the fact faithfully.
 *
 * 033 seeds with INSERT OR IGNORE, so it cannot update existing rows — this
 * migration UPDATEs them. It is data-driven from the 033 seed (single source
 * of truth) so the two can never drift, and idempotent (re-running is a no-op
 * once the live rows already match the seed).
 */

const SEED = require('./033_traits_vocabulary.seed');
const SYNC_TRAITS = ['toxicity', 'allelopathic_activity'];

async function runMigration(db) {
  let updated = 0;
  for (const name of SYNC_TRAITS) {
    const row = SEED.find(r => r.trait_name === name);
    if (!row) { console.warn(`[migration-053] seed missing trait '${name}' — skipped`); continue; }
    const res = await db.run(
      `UPDATE traits_vocabulary SET enum_values = ?, description = ? WHERE trait_name = ?`,
      [
        row.enum_values ? JSON.stringify(row.enum_values) : null,
        row.description,
        name,
      ]
    );
    if (res.changes > 0) updated += res.changes;
  }
  console.log(`[migration-053] synced ${updated} trait row(s) (toxicity, allelopathic_activity) with 'present' value.`);
}

module.exports = { runMigration };

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
