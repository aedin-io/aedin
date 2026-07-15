'use strict';

/**
 * Migration 059: register evolvability / life-history traits in traits_vocabulary.
 *
 * Phase 1 of the eco-evolutionary trait-simulation roadmap
 * (docs/schema-evolution-evolvability-simulation.md). These are the INPUT
 * parameters a forward eco-evolutionary model needs to project trait change under
 * climate scenarios — the literature-tractable ones (the agroecology corpus is rich
 * on resistance evolution + life history; molecular mutation/recombination rates are
 * deliberately NOT added, the corpus doesn't supply them).
 *
 *   generation_time          — age to reproductive maturity (the simulation clock)
 *   generations_per_year     — cross-taxon generalization of `voltinism`
 *   reproductive_mode        — the classic adaptation-rate predictor
 *   resistance_evolution_risk— IRAC/FRAC/HRAC resistance-risk framing
 *   irac_group / hrac_group  — insecticide/herbicide MoA siblings of `frac_group`
 *
 * loadVocabulary() reads traits_vocabulary directly, so registering here auto-flows
 * these into the extractor's {{TRAITS_VOCABULARY}} block — no prompt edit needed.
 *
 * Idempotent: ON CONFLICT(trait_name) DO UPDATE (042 pattern).
 */

const ORGANISMAL = ['plantae', 'invertebrate', 'vertebrate', 'fungi', 'microbe'];

const TRAITS = [
  {
    trait_name: 'generation_time',
    value_kind: 'numeric',
    expected_unit: 'years',
    applicable_bio_categories: ORGANISMAL,
    enum_values: null,
    description: 'Age to reproductive maturity (generation time), in YEARS. The clock for adaptation rate: a tree ≈ decades (slow evolver), an annual weed or multivoltine aphid ≈ weeks (use a fraction, e.g. 0.05). Distinct from days_to_harvest (a crop-management value, not a reproductive clock). Capture only when the source states maturation/generation time.',
  },
  {
    trait_name: 'generations_per_year',
    value_kind: 'numeric',
    expected_unit: 'gen/yr',
    applicable_bio_categories: ORGANISMAL,
    enum_values: null,
    description: 'Number of generations completed per year — the cross-taxon numeric generalization of voltinism (which is invertebrate-only + categorical). E.g. "up to 15 generations per year" → 15. Capture when the source states or directly implies it.',
  },
  {
    trait_name: 'reproductive_mode',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ORGANISMAL,
    enum_values: ['sexual', 'asexual', 'clonal', 'cyclical_parthenogenetic', 'selfing', 'mixed'],
    description: 'Predominant reproductive mode — a key predictor of adaptation RATE (asexual / cyclical-parthenogenetic + many generations + large population = fast evolver, e.g. aphids, many fungi). cyclical_parthenogenetic = alternating sexual/asexual (aphids). selfing = predominantly self-fertilizing plants. Capture only when the source states it.',
  },
  {
    trait_name: 'resistance_evolution_risk',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'fungi', 'microbe', 'plantae'],
    enum_values: ['low', 'moderate', 'high'],
    description: 'Documented or source-assessed risk that the organism evolves resistance to its primary chemical/biological control (the IRAC/FRAC/HRAC resistance-risk framing). high = e.g. polyphagous multivoltine pests, high-fecundity pathogens, prolific-seeding weeds. Capture only when the source assesses resistance risk — do NOT infer from taxonomy alone.',
  },
  {
    trait_name: 'irac_group',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: null,
    description: 'IRAC (Insecticide Resistance Action Committee) mode-of-action group code for an insecticide active ingredient, OR documented resistance group(s) for an arthropod pest (e.g. "IRAC 1B — organophosphates", "resistant to IRAC 3A pyrethroids"). Insecticide sibling of frac_group; used in resistance-management planning.',
  },
  {
    trait_name: 'hrac_group',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['plantae'],
    enum_values: null,
    description: 'HRAC (Herbicide Resistance Action Committee) mode-of-action group for a herbicide, OR documented herbicide-resistance group(s) for a weed (e.g. "HRAC 2 — ALS inhibitors", "Group 9 glyphosate-resistant"). Herbicide sibling of frac_group; applies to weed entities.',
  },
];

function migrate(db) {
  const stmt = db.prepare(`
    INSERT INTO traits_vocabulary
      (trait_name, value_kind, expected_unit, applicable_bio_categories, enum_values, description, introduced_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(trait_name) DO UPDATE SET
      value_kind = excluded.value_kind,
      expected_unit = excluded.expected_unit,
      applicable_bio_categories = excluded.applicable_bio_categories,
      enum_values = excluded.enum_values,
      description = excluded.description
  `);

  for (const t of TRAITS) {
    stmt.run(
      t.trait_name,
      t.value_kind,
      t.expected_unit,
      JSON.stringify(t.applicable_bio_categories),
      t.enum_values ? JSON.stringify(t.enum_values) : null,
      t.description
    );
  }

  console.log(`[migration-059] registered ${TRAITS.length} evolvability traits in traits_vocabulary`);
}

module.exports = migrate;
module.exports.TRAITS = TRAITS;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
