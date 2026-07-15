'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ecosystemServiceParams } = require('./sim-ecosystem-service');
test('maps a legume with sourced facts → derived, high confidence, n_fixer', () => {
  const r = ecosystemServiceParams({ nitrogen_fixation: 'high', cn_ratio: 'high', growth_rate: 'slow', min_root_depth_cm: 150, life_cycle: 'perennial', growth_habit: 'perennial shrub', maximum_height_cm: 300 });
  assert.equal(r.nitrogen_fixation_class, 'high');
  assert.equal(r.residue_decomposition, 'slow_immobilizing'); // C:N high
  assert.equal(r.rooting_niche, 'deep');       // 150 > 100
  assert.equal(r.growth_strategy, 'slow');
  assert.equal(r.life_cycle_class, 'perennial');
  assert.equal(r.param_status, 'derived');
  assert.equal(r.confidence, 'high');          // ≥3 sourced
  const fns = JSON.parse(r.soil_functions);
  assert.ok(fns.includes('n_fixer') && fns.includes('deep_rooter') && fns.includes('perennial_builder'));
});
test('residue class from C:N', () => {
  assert.equal(ecosystemServiceParams({ cn_ratio: 'low' }).residue_decomposition, 'fast');
  assert.equal(ecosystemServiceParams({ cn_ratio: 'medium' }).residue_decomposition, 'balanced');
});
test('rooting niche bands', () => {
  assert.equal(ecosystemServiceParams({ min_root_depth_cm: 20 }).rooting_niche, 'shallow');
  assert.equal(ecosystemServiceParams({ min_root_depth_cm: 60 }).rooting_niche, 'medium');
});
test('ground cover from habit', () => {
  assert.equal(ecosystemServiceParams({ growth_habit: 'mat-forming creeping' }).ground_cover, 'dense');
});
test('no sourced service facts → designed, low confidence', () => {
  const r = ecosystemServiceParams({});
  assert.equal(r.param_status, 'designed');
  assert.equal(r.confidence, 'low');
});
test('biomass is a low-confidence proxy, no dynamic-accumulator field', () => {
  const r = ecosystemServiceParams({ maximum_height_cm: 500, growth_rate: 'rapid' });
  assert.ok(['low', 'medium', 'high'].includes(r.biomass_contribution));
  assert.equal(JSON.parse(r.inputs_json).biomass_contribution.source, 'designed');
  assert.equal(r.dynamic_accumulator, undefined);
});
