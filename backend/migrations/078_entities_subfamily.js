'use strict';
/**
 * Migration 078: entities.subfamily.
 *
 * WHY: several ecological facts AEDIN needs are true at SUBFAMILY rank and
 * false at family rank, so a family-keyed rule asserts the opposite of the
 * truth for the subfamily. The motivating cases are both Lepidoptera:
 *
 *   Miletinae (in Lycaenidae) — larvae are PREDATORS of aphids, scale insects
 *     and mealybugs (Spalgis epius, Feniseca tarquinius). A Lycaenidae-keyed
 *     rule gives them larval_role='herbivore', which labels a biocontrol agent
 *     a pest — the same failure class as the GloBI pollinator-as-pest bug.
 *   Lymantriinae (in Erebidae) — adults are aphagous, so the blanket
 *     adult_role='nectarivore' for Lepidoptera is wrong for them.
 *
 * The column is populated from the OTT backbone by backfill-subfamily.js;
 * nothing else writes it. Left NULL wherever OTT cannot supply a subfamily —
 * NULL means "unknown", never "no subfamily", and consumers must treat it as
 * an abstention rather than a negative.
 *
 * Note on numbering: 077 is already used twice in this directory
 * (077_entities_ott_columns, 077_interactions_layer), so 078 is the next free
 * number rather than the next after a single 077.
 *
 * Idempotent: checks PRAGMA table_info before ADD COLUMN.
 */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(entities)').all().map(c => c.name));
  let added = 0;
  if (!cols.has('subfamily')) {
    db.exec('ALTER TABLE entities ADD COLUMN subfamily TEXT');
    added++;
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_entities_subfamily ON entities(subfamily)');
  console.log(`[migration-078] added ${added} column(s) + 1 index`);
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB);
  migrate(db);
  db.close();
}
