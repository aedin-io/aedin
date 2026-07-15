'use strict';

/**
 * Migration 034: code-only attractor interaction_category additions.
 *
 * No DDL — claims.interaction_category is TEXT. The validation set lives in
 * lib/interaction-vocabulary.js. This migration asserts that module is in
 * sync (catches a deploy where the lib file is older than the migration ledger).
 */

const { ATTRACTOR_CATEGORIES } = require('../lib/interaction-vocabulary');

const REQUIRED = [
  'attracts_natural_enemy', 'nectar_provision', 'pollen_provision',
  'provides_alternative_prey', 'provides_refuge', 'provides_oviposition_site',
];

async function runMigration(_db) {
  for (const c of REQUIRED) {
    if (!ATTRACTOR_CATEGORIES.has(c)) {
      throw new Error(`[migration-034] lib/interaction-vocabulary.js missing required attractor category: ${c}`);
    }
  }
  console.log('[migration-034] attractor categories present in lib/interaction-vocabulary.js. (no DDL)');
}

module.exports = { runMigration };

if (require.main === module) {
  (async () => {
    await runMigration(null);
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
