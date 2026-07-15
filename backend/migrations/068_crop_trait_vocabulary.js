'use strict';
/**
 * Migration 068: foundational crop/plant trait vocabulary (GRIN trait-enrichment
 * Phase 2). 13 plant traits. The GRIN run populates the produce/growth subset +
 * opportunistic deficiency_sensitivity; the reproduction/pollination + nutrient_demand
 * + NUE traits are defined now and monograph/trial-populated later. Mirrors 059.
 * Idempotent: ON CONFLICT(trait_name) DO UPDATE.
 */
const PL = ['plantae'];

const TRAITS = [
  // ── produce / growth (GRIN-extracted) ──
  { trait_name: 'growth_determinacy', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['determinate','indeterminate','semi_determinate'],
    description: 'Terminal vs continuous vegetative growth: determinate (bush, terminal flower cluster, concentrated set), indeterminate (vining, continuous growth/set), semi_determinate. Cultivar-level; distinct from growth_habit (Trefle tree/shrub/herb form). Capture only when stated; never infer from "bush"/"compact".' },
  { trait_name: 'produce_weight_g', value_kind: 'range', expected_unit: 'g',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Weight of the harvested/edible unit (fruit/root/tuber/bulb/head per edible_part) in GRAMS as {min,max}. Convert source units (1 oz=28.35 g, 1 lb=454 g); a single stated weight → {min:x,max:x}. Capture only a stated weight with a number; never infer from "large"/"small".' },
  { trait_name: 'produce_color', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['red','pink','orange','yellow','green','purple','white','brown','black','bicolor','striped','multicolor'],
    description: 'Dominant color of the harvested/edible part. Pick the single dominant base color; use bicolor/striped/multicolor for mixed. Lowercase. Capture only when stated.' },
  { trait_name: 'produce_shape', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['round','oblate','oval','elongated','heart','pear','ribbed','blocky','irregular','other'],
    description: 'Shape of the harvested/edible part (oxheart→heart, plum/roma→oval, globe→round). Lowercase. Capture only when stated.' },
  { trait_name: 'photoperiod_response', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['short_day','long_day','day_neutral','intermediate'],
    description: 'Flowering/development response to day length. Variety-attachable (onion/strawberry/cannabis cultivars differ; tomato is day_neutral, rarely stated). Capture only when a day-length/photoperiod response is stated; never infer.' },
  // ── reproduction / pollination (vocab-only this build) ──
  { trait_name: 'mating_system', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['autogamous','allogamous','mixed_mating','apomictic'],
    description: 'Predominant breeding behaviour: autogamous (self-pollinating/inbred), allogamous (cross-pollinating/outbreeding), mixed_mating (facultative; a 1-2% residual outcrossing does NOT make an autogamous crop mixed), apomictic (asexual seed). Species-level; monograph-populated (not a cultivar-narrative target).' },
  { trait_name: 'floral_sexual_system', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['hermaphroditic','monoecious','dioecious','andromonoecious','gynomonoecious','protandrous','protogynous','cleistogamous'],
    description: 'Floral sexual structure: hermaphroditic (perfect flowers), monoecious, dioecious, andromonoecious, gynomonoecious, protandrous/protogynous (dichogamy), cleistogamous. Species-level; monograph-populated.' },
  { trait_name: 'self_compatibility', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['self_compatible','self_incompatible','partially_self_compatible','pseudo_self_compatible'],
    description: 'Capacity for own pollen to fertilise: self_compatible, self_incompatible (needs a distinct pollinizer), partially_self_compatible, pseudo_self_compatible (SI breaks down under stress). Distinct from mating_system (a crop can be cross-pollinating AND self-compatible). Species default, cultivar-overridable (orchard self-fertility). "self-unfruitful/needs pollinizer" is the consequence of self_incompatible — not a value. Monograph/pomology-populated.' },
  { trait_name: 'parthenocarpy', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['none','facultative_parthenocarpic','obligate_parthenocarpic','stenospermocarpic'],
    description: 'Fruit set without pollination/fertilisation: none, facultative_parthenocarpic (seedless without pollination, seeded with), obligate_parthenocarpic (seedless regardless; Cavendish banana), stenospermocarpic (fertilisation then seed abortion; seedless grape). Cultivar/clone-level; catalog-extractable for cucurbits/greenhouse lines (future corpus), vocab-only this run.' },
  { trait_name: 'pollination_vector', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['biotic','wind','self','mixed'],
    description: 'Primary pollen-delivery requirement: biotic (insect/animal-pollinated, needs pollinators — entomophilous/zoophilous), wind (anemophilous), self (autogamous-mechanical, no external vector), mixed. The "does this crop need pollinators?" signal — distinct from mating_system (the genetic selfing-vs-outcrossing outcome). Species-level; monograph-populated.' },
  // ── nutrient (mixed) ──
  { trait_name: 'nutrient_demand', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['light','moderate','heavy'],
    description: 'Overall fertility/feeder demand (heavy/moderate/light-feeder gestalt). SPECIES-level (a tomato is a heavy feeder across all cultivars). Monograph-populated. DESCRIPTIVE ONLY — must never derive companion/attractor pairing rows (the heavy-feeder+N-fixer scheme is unsupported folklore). Demand ≠ supply (orthogonal to nitrogen_fixation).' },
  { trait_name: 'nitrogen_use_efficiency', value_kind: 'numeric', expected_unit: 'kg_biomass_per_kg_N',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Nitrogen-use efficiency = biomass per unit N (state grain vs total biomass in provenance). The cultivar-level breeding axis (modern cultivars convert applied N better, not demand less). Trial-data-populated; not a cultivar-narrative target. Capture only a stated NUE figure.' },
  { trait_name: 'deficiency_sensitivity', value_kind: 'list', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['calcium','boron','magnesium','manganese','zinc','iron'],
    description: 'Nutrient deficiencies the plant/cultivar is notably sensitive to (membership list). Cultivar-variable (calcium → blossom-end rot ranking in tomato/pepper). Opportunistically narrative-extractable: a variety noted susceptible to blossom-end rot → ["calcium"]. Capture only stated sensitivities.' },
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
    stmt.run(t.trait_name, t.value_kind, t.expected_unit,
      JSON.stringify(t.applicable_bio_categories),
      t.enum_values ? JSON.stringify(t.enum_values) : null,
      t.description);
  }
  console.log(`[migration-068] registered ${TRAITS.length} crop traits in traits_vocabulary`);
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
