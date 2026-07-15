'use strict';
/**
 * Migration 069: foundational crop-trait vocabulary. 27 plantae traits, define-only
 * (population is a separate downstream pass). Sourced from the horticulturist gap
 * analysis + a second pass against Adams "Principles of Horticulture, 4th ed."
 * (source 245). Overlap resolutions are baked into each description (the load-bearing
 * curation). Also edits two existing rows: deficiency_sensitivity enum extension
 * (+molybdenum/copper/sulphur/potassium — micronutrient sensitivity, not removal) and
 * a sharper maximum_height_cm description. Mirrors 068; idempotent ON CONFLICT.
 */
const PL = ['plantae'];

const TRAITS = [
  // ── growth form & physiology ──
  { trait_name: 'photosynthetic_pathway', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['c3','c4','cam','c3_c4_intermediate'],
    description: 'Carbon-fixation pathway; drives radiation-/water-use efficiency and temperature optimum (maize=c4, most temperate crops=c3, stonecrops=cam). Capture only when stated.' },
  { trait_name: 'life_cycle', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['ephemeral','annual','biennial','herbaceous_perennial','woody_perennial','monocarpic_perennial'],
    description: 'Generational longevity (Adams Table 3.3). Distinct from growth_habit (morphology) and growth_determinacy (apex termination): a tomato is indeterminate, sprawling, AND annual-in-cultivation. herbaceous vs woody perennial signals the agroforestry layer.' },
  { trait_name: 'root_architecture', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['taproot','fibrous','rhizomatous','tuberous','adventitious'],
    description: 'Root-system morphology; pairs with rooting_depth_cm for competition/complementarity reasoning.' },
  { trait_name: 'rooting_depth_cm', value_kind: 'numeric', expected_unit: 'cm',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Maximum effective rooting depth in cm (maize ~150); the below-ground water/nutrient capture stratum for intercrop complementarity.' },
  { trait_name: 'canopy_spread_cm', value_kind: 'numeric', expected_unit: 'cm',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Mature horizontal crown/canopy width in cm; the horizontal partner to maximum_height_cm for spacing and light-footprint.' },
  { trait_name: 'harvest_index', value_kind: 'numeric', expected_unit: null,
    applicable_bio_categories: PL, enum_values: null,
    description: 'Dimensionless ratio (0-1) of harvested (economic) dry mass to total aboveground dry mass; converts biomass to yield in simulation.' },
  // ── environment tolerances (populate from field-crop monographs/ECOCROP, not Adams) ──
  { trait_name: 'shade_tolerance', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['obligate_sun','intermediate','shade_tolerant','obligate_shade'],
    description: 'Survival/yield under sub-optimal shade; master agroforestry-layering trait. Distinct from optimal_light (the light level for PEAK performance) — this is the breadth of acceptable shade.' },
  { trait_name: 'drought_tolerance', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['low','moderate','high'],
    description: 'Tolerance of low plant-water status. Capture only when stated.' },
  { trait_name: 'salinity_tolerance', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['sensitive','moderate','tolerant'],
    description: 'Salt tolerance for saline-soil site-matching.' },
  { trait_name: 'flood_tolerance', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['intolerant','moderate','tolerant'],
    description: 'Waterlogging/submergence tolerance.' },
  { trait_name: 'heat_tolerance', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['low','moderate','high'],
    description: 'Resilience to supra-optimal temperature at sensitive stages. Distinct from tolerance_temp_max (the numeric thermal ceiling) — this is categorical stress resilience.' },
  { trait_name: 'frost_hardiness', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['tender','semi_hardy','moderately_hardy','very_hardy'],
    description: 'Acute freeze-injury survival, temp-anchored (Adams Table 3.3: tender ~>=-1C, semi_hardy ~-6, moderately_hardy ~-15, very_hardy ~<=-18C). Distinct from tolerance_temp_min (steady-state thermal floor) — a plant can sit at a mild minimum yet be frost-killed at a phenological window.' },
  // ── phenology / flowering control ──
  { trait_name: 'vernalization_requirement', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['none','facultative','obligate'],
    description: 'Cold period required to induce FLOWERING (Adams p.75). Distinct from photoperiod_response, and from chilling_requirement_hours (which breaks BUD dormancy, not flowering).' },
  { trait_name: 'chilling_requirement_hours', value_kind: 'numeric', expected_unit: 'hours',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Winter chill (hours below ~7C) to break BUD dormancy/budbreak — the temperate-fruit regional-adaptation trait. Distinct from vernalization_requirement (flowering, not budbreak).' },
  { trait_name: 'juvenility_period_months', value_kind: 'numeric', expected_unit: 'months',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Time from germination to first flowering/bearing capability in months (Brussels sprouts ~2.5; tree fruit several years). Distinct from days_to_harvest (the annual harvest cycle).' },
  // ── propagation & cultivation system (Adams) ──
  { trait_name: 'propagation_method', value_kind: 'list', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['seed','cutting','layering','grafting','budding','division','offset','tissue_culture','runner_stolon'],
    description: 'Commercial propagation route(s) (membership list); determines genetic uniformity and variety-system intake (Adams Ch 6).' },
  { trait_name: 'requires_rootstock', value_kind: 'boolean', expected_unit: null,
    applicable_bio_categories: PL, enum_values: null,
    description: 'Whether the crop is commercially grown on a rootstock (grafted/budded). CONDITIONS maximum_height_cm and spacing — a height/spacing claim on a graftable crop is rootstock-dependent (see rootstock_vigour).' },
  { trait_name: 'rootstock_vigour', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['very_dwarfing','dwarfing','semi_dwarfing','vigorous'],
    description: 'Size-control class when grown grafted on a rootstock (apple 6->4 m purely from rootstock choice). Capture only for graftable crops grown on rootstocks.' },
  { trait_name: 'seed_dormancy_type', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['none','physical_coat','physiological','chemical_inhibitor','combinational'],
    description: 'Type of seed dormancy; governs whether the crop can be direct-sown (Adams Ch 6).' },
  { trait_name: 'dormancy_breaking_treatment', value_kind: 'list', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['stratification','scarification','after_ripening','light','leaching'],
    description: 'Treatment(s) that break seed/bud dormancy (membership list — combinational dormancy needs several).' },
  { trait_name: 'protected_culture_suitability', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['field_only','field_or_protected','protected_preferred','protected_only'],
    description: 'Whether the crop is grown under glass/polytunnel; sets the growing-system context (a tender crop is field-only outdoors but year-round under glass).' },
  // ── spacing geometry (anisotropic) & nutrient offtake ──
  { trait_name: 'in_row_spacing_cm', value_kind: 'numeric', expected_unit: 'cm',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Recommended within-row spacing at optimum density, in cm (Adams: potato 40 in-row). Density/rootstock-conditioned — a species-level number a competition model reads with neighborhood context.' },
  { trait_name: 'between_row_spacing_cm', value_kind: 'numeric', expected_unit: 'cm',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Recommended between-row spacing in cm (Adams: potato 70 between-row).' },
  { trait_name: 'edible_part', value_kind: 'list', expected_unit: null,
    applicable_bio_categories: PL, enum_values: ['root','tuber','bulb','stem','leaf','petiole','flower','fruit','seed','whole'],
    description: 'Consumed organ(s) (membership list). Populate-time: gate on crop_type/edible to avoid non-food anchors.' },
  { trait_name: 'n_removal_kg_t', value_kind: 'numeric', expected_unit: 'kg/t',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Nitrogen exported in the harvested product per tonne of yield (offtake) — the rotation/soil-budget replacement number. Distinct from nutrient_demand (categorical uptake class) and nitrogen_use_efficiency.' },
  { trait_name: 'p_removal_kg_t', value_kind: 'numeric', expected_unit: 'kg/t',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Phosphorus offtake in the harvested product per tonne of yield.' },
  { trait_name: 'k_removal_kg_t', value_kind: 'numeric', expected_unit: 'kg/t',
    applicable_bio_categories: PL, enum_values: null,
    description: 'Potassium offtake in the harvested product per tonne of yield.' },
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
  // Existing-trait edits (no-op-safe if the row is absent). Micronutrient sensitivity
  // is modeled here (NOT as a removal/requirement trait): extend the enum.
  db.prepare(`UPDATE traits_vocabulary SET enum_values = ? WHERE trait_name = 'deficiency_sensitivity'`)
    .run(JSON.stringify(['calcium','boron','magnesium','manganese','zinc','iron','molybdenum','copper','sulphur','potassium']));
  db.prepare(`UPDATE traits_vocabulary SET description = ? WHERE trait_name = 'maximum_height_cm'`)
    .run('Typical mature height under cultivation, in cm (rootstock-conditioned for graftable crops — see requires_rootstock). Horizontal partner: canopy_spread_cm.');
  console.log(`[migration-069] registered ${TRAITS.length} foundational crop traits + 2 existing-trait edits`);
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
