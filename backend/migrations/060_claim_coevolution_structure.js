'use strict';
/**
 * Migration 060: claims.coevolution_structure — relationship-level evolutionary
 * structure of a host–pathogen (or host–parasite) interaction.
 *
 * Phase 1 of the eco-evolutionary roadmap (docs/schema-evolution-evolvability-
 * simulation.md item E). Gene-for-gene vs. quantitative resistance is a property of
 * the host × pathogen PAIR, not an entity trait — so it lives on the claim. The
 * Agrios corpus is dense on this (126 gene-for-gene/race-specific hits).
 *
 *   coevolution_structure ∈ { gene_for_gene | quantitative | unknown }
 *     gene_for_gene — race-specific, R-gene/avirulence-gene matching (boom-and-bust,
 *                     non-durable); such an interaction must NOT be generalized
 *                     across cultivars/regions by the prediction layer.
 *     quantitative  — polygenic / horizontal / partial resistance (durable).
 *     unknown       — not stated.
 *
 * This is the data field that lets the prediction layer ENFORCE the "don't
 * generalize race-specific interactions" rule already in CLAUDE.md's blocklist.
 *
 * Idempotent: PRAGMA table_info guard before ALTER. Safe to re-run.
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(claims)').all().map(c => c.name);
  if (!cols.includes('coevolution_structure')) {
    db.exec('ALTER TABLE claims ADD COLUMN coevolution_structure TEXT');
    console.log('[migration-060] added claims.coevolution_structure');
  } else {
    console.log('[migration-060] claims.coevolution_structure already present');
  }
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
