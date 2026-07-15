'use strict';

/**
 * Map trait_name to corresponding `entities` column for cache rebuild.
 *
 * Most traits share a name with the entities column (ph_min, thermal_min,
 * voltinism, bloom_months, etc.). Some traits have no cache column
 * (e.g. nitrogen_fixation_rate_kg_per_ha_per_yr, target_pest_range) —
 * those live only in entity_trait_claims and are read via JOIN.
 */

const TRAIT_TO_COLUMN = {
  // plant
  ph_min: 'ph_min',
  ph_max: 'ph_max',
  optimal_temp_min: 'optimal_temp_min',
  optimal_temp_max: 'optimal_temp_max',
  tolerance_temp_min: 'tolerance_temp_min',
  tolerance_temp_max: 'tolerance_temp_max',
  optimal_precip_min: 'optimal_precip_min',
  optimal_precip_max: 'optimal_precip_max',
  optimal_light: 'optimal_light',
  optimal_soil_moisture: 'optimal_soil_moisture',
  optimal_soil_texture: 'optimal_soil_texture',
  nitrogen_fixation: 'nitrogen_fixation',
  days_to_harvest: 'days_to_harvest',
  growth_habit: 'growth_habit',
  maximum_height_cm: 'maximum_height_cm',
  bloom_months: 'bloom_months',
  fruit_months: 'fruit_months',
  toxicity: 'toxicity',
  // allelopathic_activity has no entities column → null below
  native_zones: 'native_zones',
  introduced_zones: 'introduced_zones',
  // pest / pathogen / biocontrol shared
  thermal_min: 'thermal_min',
  thermal_max: 'thermal_max',
  favorable_temp_min: 'favorable_temp_min',
  favorable_temp_max: 'favorable_temp_max',
  favorable_humidity: 'favorable_humidity',
  voltinism: 'voltinism',
  degree_days_base10: 'degree_days_base10',
  activity_months: 'activity_months',
  diet_breadth: 'diet_breadth',
  host_range: 'host_range',
  crop_damage_type: 'crop_damage_type',
  vulnerable_host_stage: 'vulnerable_host_stage',
  dispersal_range: 'dispersal_range',
  migration_pattern: 'migration_pattern',
  pest_mobility: 'pest_mobility',
  // pathogen-specific
  leaf_wetness_hours: 'leaf_wetness_hours',
  transmission_mode: 'transmission_mode',
  transmission_vector: 'transmission_vector',
  survival_structure: 'survival_structure',
  soil_persistence_years: 'soil_persistence_years',
  seed_borne: 'seed_borne',
  frac_group: 'frac_group',
  pathogen_subtype: 'pathogen_subtype',
  // biocontrol
  commercial_biocontrol: 'commercial_biocontrol',
  // soil microbe
  soil_health_function: 'soil_health_function',
};

function traitToColumn(trait_name) {
  return TRAIT_TO_COLUMN[trait_name] ?? null;
}

function hasCacheColumn(trait_name) {
  return trait_name in TRAIT_TO_COLUMN;
}

const ALL_CACHE_TRAITS = Object.keys(TRAIT_TO_COLUMN);

module.exports = { traitToColumn, hasCacheColumn, ALL_CACHE_TRAITS };
