'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanityOk, aggregateHeights } = require('./backfill-sim-height');

test('sanityOk enforces 5..4000 cm and requires a real number', () => {
  assert.equal(sanityOk(5), true);
  assert.equal(sanityOk(4), false);       // below min
  assert.equal(sanityOk(4000), true);
  assert.equal(sanityOk(4001), false);     // above max (>40 m)
  assert.equal(sanityOk(NaN), false);
  assert.equal(sanityOk('30'), false);     // must already be a number
});

test('aggregateHeights: keeps the MAX sane value per species, coerces numeric strings, drops junk', () => {
  const m = aggregateHeights([
    { scientific_name: 'Solanum lycopersicum', value_numeric: 120 },
    { scientific_name: 'Solanum lycopersicum', value_numeric: 180 },  // max wins
    { scientific_name: 'Solanum lycopersicum', value_numeric: 9000 }, // out of range → ignored
    { scientific_name: 'Lactuca sativa', value_numeric: '30' },       // string coerced
    { scientific_name: '  Zea mays  ', value_numeric: 250 },          // trimmed
    { scientific_name: '', value_numeric: 50 },                       // no name → dropped
    { scientific_name: 'Tiny thing', value_numeric: 2 },              // below min → dropped
  ]);
  assert.equal(m.get('Solanum lycopersicum'), 180);
  assert.equal(m.get('Lactuca sativa'), 30);
  assert.equal(m.get('Zea mays'), 250);
  assert.equal(m.has(''), false);
  assert.equal(m.has('Tiny thing'), false);
  assert.equal(m.size, 3);
});
