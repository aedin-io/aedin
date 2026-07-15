'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGbifKey, parseTaxonIds } = require('./globi-taxon-ids');

const FULL = 'COL:4C67X | EOL:2739321 | GBIF:1346127 | ITIS:769485 | NCBI:2610089 | WD:Q10803783';

test('parseGbifKey extracts the GBIF integer from a multi-authority string', () => {
  assert.equal(parseGbifKey(FULL), 1346127);
});
test('parseGbifKey returns null for no:match / empty / null', () => {
  assert.equal(parseGbifKey('no:match'), null);
  assert.equal(parseGbifKey(''), null);
  assert.equal(parseGbifKey(null), null);
  assert.equal(parseGbifKey(undefined), null);
});
test('parseGbifKey returns null when no GBIF token present', () => {
  assert.equal(parseGbifKey('NCBI:2610089 | WD:Q10803783'), null);
});
test('parseGbifKey tolerates whitespace and lowercase prefix', () => {
  assert.equal(parseGbifKey('gbif:42'), 42);
  assert.equal(parseGbifKey('  GBIF:99  '), 99);
  assert.equal(parseGbifKey('GBIF:7;NCBI:8'), 7);
});
test('parseGbifKey ignores a non-numeric GBIF token', () => {
  assert.equal(parseGbifKey('GBIF:abc'), null);
});
test('parseTaxonIds returns all known authorities', () => {
  const ids = parseTaxonIds(FULL);
  assert.equal(ids.gbif, 1346127);
  assert.equal(ids.ncbi, '2610089');
  assert.equal(ids.col, '4C67X');
  assert.equal(ids.itis, '769485');
  assert.equal(ids.eol, '2739321');
  assert.equal(ids.wd, 'Q10803783');
});
