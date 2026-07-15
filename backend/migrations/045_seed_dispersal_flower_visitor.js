'use strict';

/**
 * Migration 045: three new interaction_category values for the Phase-G GloBI
 * cross-domain correction (docs/globi-cross-domain-audit.md).
 *
 * The 4-critic audit of untouched GloBI categories surfaced error classes that
 * need categories the enum doesn't yet have:
 *
 *   - `seed_dispersal`  — plant→frugivore dispersal mutualism. ~3,217 frugivore
 *     `hasVector` rows (fruit bats / birds) are currently SIGN-INVERTED into
 *     `disease_vector` (harmful) for lack of this beneficial category.
 *   - `flower_visitor`  — a lower-confidence tier below `pollination` for vague
 *     `visits` edges by non-pollinator taxa. ~106K rows are currently
 *     over-credited as `pollination`; demoting them stops nectar-thieves and
 *     florivores from being laundered into the beneficial-pollination network.
 *   - `endophytism`     — RESERVED. Benign fungal `hasHost` (endophytes)
 *     currently dumped into pathogen_pressure. Not yet populated (needs GBIF
 *     phylum/genus data to detect reliably); registered now so the vocabulary
 *     is ready.
 *
 * As with migration 044, the enum is not DB-CHECK-enforced — "adding" a value
 * means updating lib/interaction-vocabulary.js (done in the same commit). This
 * migration records intent + verifies no stale CHECK constraint blocks them.
 *
 * Idempotent.
 */

function migrate(db) {
  const ddl = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='claims'`
  ).get();
  if (ddl && /interaction_category[^,]*CHECK/i.test(ddl.sql)) {
    console.warn('[migration-045] WARNING: claims.interaction_category appears to carry a CHECK ' +
      'constraint — new categories seed_dispersal/flower_visitor/endophytism may be rejected.');
  } else {
    console.log('[migration-045] verified: no CHECK constraint blocks new interaction_category values');
  }
  console.log('[migration-045] done. seed_dispersal, flower_visitor, endophytism registered in lib/interaction-vocabulary.js.');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
