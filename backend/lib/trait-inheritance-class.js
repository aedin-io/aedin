'use strict';
// Kingdom-aware (bio_category, trait_name) -> 'conserved' | 'divergent'.
// Fail-closed: anything not explicitly conserved is divergent (never inherit what we haven't curated).
// Canonical partition: docs/superpowers/specs/2026-06-21-variety-intake-2b-*.md §3.
// IMPLEMENTED: plantae + fungi. DEFERRED (sketch only): microbe, invertebrate, vertebrate -> all divergent.

// Universal rule: host-association / target is the defining axis of every infraspecies unit -> never inherit.
const UNIVERSAL_DIVERGENT = new Set([
  'host_range', 'host', 'host_plants', 'target', 'generations_per_year',
]);

const PLANT_CONSERVED = new Set([
  'ph_min', 'ph_max', 'optimal_temp_min', 'optimal_temp_max',
  'optimal_precip_min', 'optimal_precip_max', 'optimal_light', 'optimal_soil_texture',
  'tolerance_temp_min', 'tolerance_temp_max', 'native_regions', 'habitat_type', 'nitrogen_fixation',
]);

const FUNGI_CONSERVED = new Set([
  'optimal_temp_min', 'optimal_temp_max', 'primary_role', 'interaction_category',
]);

const CONSERVED_BY_KINGDOM = { plantae: PLANT_CONSERVED, fungi: FUNGI_CONSERVED };

function inheritanceClass(bioCategory, traitName) {
  if (UNIVERSAL_DIVERGENT.has(traitName)) return 'divergent';
  const conserved = CONSERVED_BY_KINGDOM[bioCategory];
  if (conserved && conserved.has(traitName)) return 'conserved';
  return 'divergent'; // deferred kingdom OR uncurated trait -> fail-closed
}

module.exports = { inheritanceClass };
