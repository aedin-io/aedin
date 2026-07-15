'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('./sim-defaults');

const LIFE_FORMS = ['annual_herb','perennial_herb','grass','vine','geophyte','shrub','tree','unclassified'];

test('every life_form default is complete + time_unit valid', () => {
  for (const lf of LIFE_FORMS) {
    const d = D.LIFE_FORM_DEFAULTS[lf];
    assert.ok(d, `missing ${lf}`);
    for (const k of ['time_unit','max_height_cm','max_spread_cm','max_root_depth_cm','days_to_maturity','height_curve_model','canopy_layer','light_extinction_coeff']) {
      assert.ok(d[k] != null, `${lf}.${k} missing`);
    }
    assert.ok(['days','years'].includes(d.time_unit));
    assert.ok(d.light_extinction_coeff > 0 && d.light_extinction_coeff <= 1);
  }
});

test('woody life_forms use years, herbaceous use days', () => {
  assert.equal(D.LIFE_FORM_DEFAULTS.tree.time_unit, 'years');
  assert.equal(D.LIFE_FORM_DEFAULTS.shrub.time_unit, 'years');
  assert.equal(D.LIFE_FORM_DEFAULTS.annual_herb.time_unit, 'days');
});

test('control magnitudes are fractions and parasitoid > generalist', () => {
  for (const v of Object.values(D.CONTROL_MAGNITUDE)) assert.ok(v >= 0 && v <= 1);
  assert.ok(D.CONTROL_MAGNITUDE.parasitoid > D.CONTROL_MAGNITUDE.generalist);
});

test('canopyLayerForHeight bands', () => {
  assert.equal(D.canopyLayerForHeight(null), null);
  assert.equal(D.canopyLayerForHeight(10), 'ground');
  assert.equal(D.canopyLayerForHeight(100), 'herb');
  assert.equal(D.canopyLayerForHeight(300), 'shrub');
  assert.equal(D.canopyLayerForHeight(900), 'canopy');
  assert.equal(D.canopyLayerForHeight(2000), 'emergent');
});

test('model_refs are versioned strings', () => {
  for (const r of [D.GROWTH_MODEL_REF, D.PEST_MODEL_REF, D.BIOCONTROL_MODEL_REF, D.VISUAL_MODEL_REF]) {
    assert.match(r, /_v\d+$/);
  }
});

test('every life_form canopy_layer agrees with canopyLayerForHeight(max_height_cm)', () => {
  for (const [lf, d] of Object.entries(D.LIFE_FORM_DEFAULTS)) {
    assert.equal(d.canopy_layer, D.canopyLayerForHeight(d.max_height_cm), `${lf} canopy_layer must match its height band`);
  }
});

test('MIN_ROOT_DEPTH_FRACTION is a fraction in (0,1)', () => {
  assert.ok(D.MIN_ROOT_DEPTH_FRACTION > 0 && D.MIN_ROOT_DEPTH_FRACTION < 1);
});

test('ecosystem-service constants present + sane', () => {
  assert.match(D.ES_MODEL_REF, /_v\d+$/);
  assert.ok(D.ROOT_SHALLOW_MAX < D.ROOT_DEEP_MIN);
  assert.ok(D.BIOMASS_HEIGHT_LOW < D.BIOMASS_HEIGHT_HIGH);
  assert.ok(D.RATE_FACTOR.rapid > D.RATE_FACTOR.slow);
});
