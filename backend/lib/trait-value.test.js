'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeTraitValue, decodeTraitValue, validateTraitValue } = require('./trait-value');

test('encodeTraitValue numeric → value_numeric only', () => {
  const r = encodeTraitValue({ value_kind: 'numeric' }, 7.3);
  assert.deepEqual(r, { value_numeric: 7.3, value_text: null, value_json: null });
});

test('encodeTraitValue categorical → value_text only', () => {
  const r = encodeTraitValue({ value_kind: 'categorical' }, 'univoltine');
  assert.deepEqual(r, { value_numeric: null, value_text: 'univoltine', value_json: null });
});

test('encodeTraitValue range → value_json {min,max}', () => {
  const r = encodeTraitValue({ value_kind: 'range' }, { min: 70, max: 95 });
  assert.equal(r.value_numeric, null);
  assert.equal(r.value_text, null);
  assert.deepEqual(JSON.parse(r.value_json), { min: 70, max: 95 });
});

test('encodeTraitValue list → value_json array', () => {
  const r = encodeTraitValue({ value_kind: 'list' }, ['Brassica oleracea', 'Brassica napus']);
  assert.deepEqual(JSON.parse(r.value_json), ['Brassica oleracea', 'Brassica napus']);
});

test('encodeTraitValue boolean → value_text true|false', () => {
  assert.equal(encodeTraitValue({ value_kind: 'boolean' }, true).value_text, 'true');
  assert.equal(encodeTraitValue({ value_kind: 'boolean' }, false).value_text, 'false');
});

test('decodeTraitValue numeric returns number', () => {
  const r = decodeTraitValue({ value_kind: 'numeric' },
    { value_numeric: 7.3, value_text: null, value_json: null });
  assert.equal(r, 7.3);
});

test('decodeTraitValue range returns object', () => {
  const r = decodeTraitValue({ value_kind: 'range' },
    { value_numeric: null, value_text: null, value_json: '{"min":70,"max":95}' });
  assert.deepEqual(r, { min: 70, max: 95 });
});

test('validateTraitValue rejects categorical not in enum', () => {
  const r = validateTraitValue(
    { trait_name: 'voltinism', value_kind: 'categorical', enum_values: ['univoltine', 'bivoltine'] },
    'multivoltine'
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /not in enum/);
});

test('validateTraitValue accepts categorical in enum', () => {
  const r = validateTraitValue(
    { trait_name: 'voltinism', value_kind: 'categorical', enum_values: ['univoltine', 'bivoltine'] },
    'univoltine'
  );
  assert.equal(r.ok, true);
});

test('validateTraitValue rejects numeric NaN', () => {
  const r = validateTraitValue({ trait_name: 'thermal_min', value_kind: 'numeric' }, NaN);
  assert.equal(r.ok, false);
});

test('validateTraitValue accepts numeric finite', () => {
  assert.equal(validateTraitValue({ trait_name: 'thermal_min', value_kind: 'numeric' }, 7.3).ok, true);
});
