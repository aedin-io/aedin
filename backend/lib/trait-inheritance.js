'use strict';

/**
 * Which traits inherit from parent species at the serializer layer when a
 * variety row has NULL for that trait.
 *
 * Rule of thumb: a cultivar shares its parent species' ENVIRONMENTAL
 * tolerance (climate, soil) more than it shares pest/biology specifics.
 * Cultivar breeding programs select for resistance differentials, so
 * those are the LAST thing to inherit from species.
 *
 * Default policy: climate envelope inherits; biology/resistance does not.
 * Unknown traits fall back to NOT-inheritable (fail-closed).
 *
 * Future-optional ?inheritance=strict_none flag in the serializer can
 * disable inheritance entirely.
 */

const INHERITABLE_TRAITS = new Set([
  // temperature envelope
  'thermal_min', 'thermal_max',
  'optimal_temp_min', 'optimal_temp_max',
  'tolerance_temp_min', 'tolerance_temp_max',
  'favorable_temp_min', 'favorable_temp_max',
  // humidity / moisture
  'optimal_humidity_min', 'optimal_humidity_max',
  'atmospheric_humidity',
  'optimal_soil_moisture',
  // precipitation
  'optimal_precip_min', 'optimal_precip_max',
  'min_precipitation_mm', 'max_precipitation_mm',
  // pH and soil
  'ph_min', 'ph_max',
  'optimal_ph_min', 'optimal_ph_max',
  'optimal_soil_texture',
  // light
  'optimal_light', 'light_requirement',
]);

function isInheritable(trait_name) {
  return INHERITABLE_TRAITS.has(trait_name);
}

module.exports = { INHERITABLE_TRAITS, isInheritable };
