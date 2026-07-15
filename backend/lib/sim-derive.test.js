'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyLifeForm, growthCurveParams, visualMapping, pestDynamics, biocontrolDefaults } = require('./sim-derive');

test('classifies structural forms from noisy free-text', () => {
  assert.equal(classifyLifeForm('deciduous tree; deep taproot', null, null).lifeForm, 'tree');
  assert.equal(classifyLifeForm('perennial shrub / understory', null, null).lifeForm, 'shrub');
  assert.equal(classifyLifeForm('annual climbing vine; twines up corn stalk', null, null).lifeForm, 'vine');
  assert.equal(classifyLifeForm('annual grass / cereal', null, null).lifeForm, 'grass');
  assert.equal(classifyLifeForm('herbaceous perennial (geophyte); tuber-bearing', null, null).lifeForm, 'geophyte');
});

test('splits herbs by life cycle', () => {
  assert.equal(classifyLifeForm('annual leafy vegetable', 'annual', null).lifeForm, 'annual_herb');
  assert.equal(classifyLifeForm('herbaceous perennial', 'perennial', null).lifeForm, 'perennial_herb');
  assert.equal(classifyLifeForm('herb', null, null).lifeForm, 'annual_herb'); // default when cycle unknown
});

test('falls back to unclassified on pure-metadata text', () => {
  const r = classifyLifeForm('C4 photosynthesis; higher optimum temperature', null, null);
  assert.equal(r.lifeForm, 'unclassified');
  assert.deepEqual(r.matched, []);
});

test('records matched keywords for audit', () => {
  const r = classifyLifeForm('deciduous tree', null, null);
  assert.ok(r.matched.includes('tree'));
});

test('derived when height is sourced; days time_unit for annual herb', () => {
  const info = classifyLifeForm('annual leafy vegetable', 'annual', null);
  const row = growthCurveParams({ max_height_cm: 45, days_to_harvest: 60 }, info);
  assert.equal(row.param_status, 'derived');   // key asymptote (height) sourced
  assert.equal(row.time_unit, 'days');
  assert.equal(row.max_height_cm, 45);
  assert.equal(row.days_to_maturity, 60);
  assert.equal(row.confidence, 'high');         // height + maturity both sourced
  assert.equal(row.height_inflection, 30);      // 0.5 * 60
  assert.equal(row.height_curve_model, 'logistic');
  assert.ok(row.light_extinction_coeff > 0);
  assert.match(row.model_ref, /^growth_v/);
});

test('designed with years time_unit for a tree lacking facts', () => {
  const info = classifyLifeForm('deciduous tree', null, null);
  const row = growthCurveParams({}, info);
  assert.equal(row.param_status, 'designed');
  assert.equal(row.time_unit, 'years');
  assert.equal(row.confidence, 'low');
  assert.equal(row.height_curve_model, 'perennial_seasonal');
  const inputs = JSON.parse(row.inputs_json);
  assert.match(inputs.max_height_cm.source, /^designed:/);
});

test('growthCurveParams: woody form ignores a days_to_harvest fact (years, not days)', () => {
  const info = classifyLifeForm('deciduous tree', null, null); // → tree, time_unit 'years'
  const row = growthCurveParams({ max_height_cm: 500, days_to_harvest: 90 }, info);
  assert.equal(row.time_unit, 'years');
  assert.equal(row.days_to_maturity, 18);  // the DESIGNED tree years value, NOT the 90-day fact
  assert.equal(row.param_status, 'derived'); // height was sourced → still derived
});

test('canopy_layer follows a known height', () => {
  const info = classifyLifeForm('deciduous tree', null, null);
  const row = growthCurveParams({ max_height_cm: 900 }, info);
  assert.equal(row.canopy_layer, 'canopy');
});

test('visualMapping maps life_form → archetype; derived iff produce_color present', () => {
  const info = classifyLifeForm('deciduous tree', null, null);
  const g = growthCurveParams({ max_height_cm: 900 }, info);
  const v1 = visualMapping(g, {});
  assert.equal(v1.model_archetype, 'single_stem_tree');
  assert.equal(v1.param_status, 'designed');
  assert.equal(v1.height_scale_cm, 900);
  const v2 = visualMapping(g, { produce_color: 'red' });
  assert.equal(v2.produce_color, 'red');
  assert.equal(v2.param_status, 'derived');
});

test('growthCurveParams guards non-positive maturity (no Infinity/negative curve params)', () => {
  const info = classifyLifeForm('annual leafy vegetable', 'annual', null);
  const zero = growthCurveParams({ max_height_cm: 50, days_to_harvest: 0 }, info);
  assert.ok(Number.isFinite(zero.height_rate_k) && zero.height_rate_k > 0, 'rate must be finite/positive');
  assert.ok(zero.height_inflection >= 0, 'inflection must be non-negative');
  assert.ok(zero.days_to_maturity >= 1, 'maturity floored to >= 1');
  const neg = growthCurveParams({ max_height_cm: 50, days_to_harvest: -10 }, info);
  assert.ok(Number.isFinite(neg.height_rate_k) && neg.height_rate_k > 0);
  assert.ok(neg.height_inflection >= 0);
});

test('pestDynamics: derived from a sourced generations count', () => {
  const r = pestDynamics({ generations_per_year: 5, favorable_season: 'summer' });
  assert.equal(r.generations_per_year, 5);
  assert.equal(r.onset_season, 'summer');
  assert.equal(r.param_status, 'derived');
});

test('pestDynamics: voltinism words map to a generation count', () => {
  assert.equal(pestDynamics({ voltinism: 'univoltine' }).generations_per_year, 1);
  assert.equal(pestDynamics({ voltinism: 'bivoltine' }).generations_per_year, 2);
  assert.equal(pestDynamics({ voltinism: 'multivoltine' }).generations_per_year, 4);
});

test('pestDynamics: designed default when nothing sourced', () => {
  const r = pestDynamics({});
  assert.equal(r.param_status, 'designed');
  assert.equal(r.generations_per_year, 2);
  assert.equal(r.confidence, 'low');
});

test('biocontrolDefaults: guild sets magnitude; always designed', () => {
  const par = biocontrolDefaults({ enemy_primary_role: 'parasitoid' });
  assert.equal(par.control_magnitude, 0.4);
  assert.equal(par.param_status, 'designed');
  const pred = biocontrolDefaults({ enemy_primary_role: 'predator', commercial_biocontrol: 1 });
  assert.equal(pred.control_magnitude, 0.35);
  assert.equal(pred.establishment, 'augmentative');
  const unk = biocontrolDefaults({ enemy_primary_role: 'something_else' });
  assert.equal(unk.control_magnitude, 0.2);
});

test('classifier: inflected forms + groundcover no longer misclassify', () => {
  assert.equal(classifyLifeForm('shrubby perennial', null, null).lifeForm, 'shrub');
  assert.equal(classifyLifeForm('bulbous perennial herb', null, null).lifeForm, 'geophyte');
  // creeping thyme is a groundcover HERB, not a vine
  const thyme = classifyLifeForm('creeping thyme', null, null).lifeForm;
  assert.ok(thyme === 'annual_herb' || thyme === 'perennial_herb', `creeping groundcover must be a herb, got ${thyme}`);
  // true climbers still classify as vine
  assert.equal(classifyLifeForm('annual climbing vine', null, null).lifeForm, 'vine');
  assert.equal(classifyLifeForm('trailing vine', null, null).lifeForm, 'vine');
});

test('pestDynamics + biocontrolDefaults do not throw on null input', () => {
  assert.doesNotThrow(() => pestDynamics(null));
  assert.doesNotThrow(() => biocontrolDefaults(null));
  assert.equal(pestDynamics(null).param_status, 'designed');
});

test('growthCurveParams: sourced min root depth → [min,max] with min<=max', () => {
  const g = growthCurveParams({ max_height_cm: 50, min_root_depth_cm: 25 }, { lifeForm: 'annual_herb', matched: [] });
  assert.equal(g.min_root_depth_cm, 25);
  assert.ok(g.min_root_depth_cm <= g.max_root_depth_cm);
  assert.equal(JSON.parse(g.inputs_json).min_root_depth_cm.source, 'fact');
});

test('growthCurveParams: designed min root depth when unsourced', () => {
  const g = growthCurveParams({ max_height_cm: 50 }, { lifeForm: 'annual_herb', matched: [] });
  assert.ok(g.min_root_depth_cm != null && g.min_root_depth_cm < g.max_root_depth_cm);
  assert.match(JSON.parse(g.inputs_json).min_root_depth_cm.source, /^designed:/);
});

test('growthCurveParams: sourced min deeper than designed max lifts max', () => {
  const g = growthCurveParams({ max_height_cm: 50, min_root_depth_cm: 80 }, { lifeForm: 'annual_herb', matched: [] });
  assert.equal(g.min_root_depth_cm, 80);
  assert.ok(g.max_root_depth_cm >= 80);
});
