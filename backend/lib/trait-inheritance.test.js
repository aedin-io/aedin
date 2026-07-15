'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { INHERITABLE_TRAITS, isInheritable } = require('./trait-inheritance');

test('climate-envelope traits are inheritable', () => {
  for (const t of [
    'thermal_min', 'thermal_max',
    'optimal_temp_min', 'optimal_temp_max',
    'tolerance_temp_min', 'tolerance_temp_max',
    'optimal_precip_min', 'optimal_precip_max',
    'ph_min', 'ph_max',
    'optimal_light', 'optimal_soil_moisture', 'optimal_soil_texture',
    'favorable_temp_min', 'favorable_temp_max',
  ]) {
    assert.ok(isInheritable(t), `expected ${t} to inherit`);
  }
});

test('biology/resistance traits are NOT inheritable', () => {
  for (const t of [
    'host_range', 'vulnerable_host_stage', 'voltinism',
    'crop_damage_type', 'frac_group', 'pathogen_subtype',
    'target_pest_range', 'transmission_mode', 'survival_structure',
    'seed_borne', 'commercial_biocontrol',
  ]) {
    assert.equal(isInheritable(t), false, `expected ${t} NOT to inherit`);
  }
});

test('unknown trait → not inheritable (fail-closed)', () => {
  assert.equal(isInheritable('made_up_trait'), false);
});

test('INHERITABLE_TRAITS is a non-empty Set', () => {
  assert.ok(INHERITABLE_TRAITS instanceof Set);
  assert.ok(INHERITABLE_TRAITS.size > 10);
});
