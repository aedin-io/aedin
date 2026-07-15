'use strict';
/**
 * Migration 071 — extend the edible_part enum with 'bud', 'inflorescence', 'calyx'.
 *
 * The multi-critic gate (2026-06-28 Rubatzky population) held/force-fit a class of
 * crops whose edible organ is a reproductive structure other than a true flower:
 * broccoli/cauliflower/artichoke (immature INFLORESCENCE, force-fit to "flower"),
 * caper/Brussels-sprout/myoga (BUD, force-fit to "flower"/"leaf"), roselle
 * (fleshy CALYX, force-fit to "flower"). This adds the three tokens so the
 * vocabulary distinguishes them from a genuine edible flower (borage, nasturtium,
 * squash blossom). Idempotent; no-op-safe. Follows migration 070.
 */
const ENUM = ['root', 'tuber', 'bulb', 'corm', 'rhizome', 'stem', 'leaf', 'petiole',
  'bud', 'inflorescence', 'flower', 'calyx', 'fruit', 'seed', 'whole'];
const DESC = 'Consumed organ(s) (membership list). Reproductive organs are distinct: bud = unopened bud, vegetative or floral (Brussels sprout, caper, myoga); inflorescence = immature flower cluster/head eaten before bloom (broccoli, cauliflower curd, artichoke); flower = an open/true flower eaten as such (borage, nasturtium, squash blossom); calyx = fleshy sepal whorl (roselle). Storage organs: corm (taro, water chestnut), rhizome (ginger, turmeric, arrowroot), tuber (potato), bulb (onion). Populate-time: gate on crop_type/edible to avoid non-food anchors.';

function migrate(db) {
  db.prepare(`UPDATE traits_vocabulary SET enum_values = ?, description = ? WHERE trait_name = 'edible_part'`)
    .run(JSON.stringify(ENUM), DESC);
  console.log('[migration-071] edible_part enum extended with bud + inflorescence + calyx');
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
