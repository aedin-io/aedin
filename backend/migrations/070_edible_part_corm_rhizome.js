'use strict';
/**
 * Migration 070 — extend the edible_part trait enum with 'corm' and 'rhizome'.
 *
 * The multi-critic gate (2026-06-28 Rubatzky foundational-trait population) found
 * taro/water-chestnut (corm) and ginger/turmeric/arrowroot/canna/sweet-flag
 * (rhizome) force-fit to tuber/root/stem for lack of these tokens, and held those
 * claims. This adds the two organ tokens so the vocabulary matches the botany.
 * Idempotent UPDATE; no-op-safe if the row is absent. Mirrors the 069
 * deficiency_sensitivity enum extension.
 */
const ENUM = ['root', 'tuber', 'bulb', 'corm', 'rhizome', 'stem', 'leaf', 'petiole', 'flower', 'fruit', 'seed', 'whole'];
const DESC = 'Consumed organ(s) (membership list). corm = swollen stem-base storage organ (taro, water chestnut, water bamboo); rhizome = horizontal underground stem (ginger, turmeric, arrowroot, canna, sweet flag); tuber = swollen stem/stolon tip (potato); bulb = layered leaf-base storage (onion). Populate-time: gate on crop_type/edible to avoid non-food anchors.';

function migrate(db) {
  db.prepare(`UPDATE traits_vocabulary SET enum_values = ?, description = ? WHERE trait_name = 'edible_part'`)
    .run(JSON.stringify(ENUM), DESC);
  console.log('[migration-070] edible_part enum extended with corm + rhizome');
}

module.exports = migrate;
module.exports.ENUM = ENUM;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
