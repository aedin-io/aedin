'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SOURCES = require('./sim-trait-sources');
test('ordered array of valid adapters; USDA before Trefle', () => {
  assert.ok(Array.isArray(SOURCES) && SOURCES.length >= 2);
  for (const a of SOURCES) {
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.cacheDir, 'string');
    assert.equal(typeof a.extract, 'function');
  }
  assert.ok(SOURCES.findIndex((a) => a.name === 'usda') < SOURCES.findIndex((a) => a.name === 'trefle'));
});
