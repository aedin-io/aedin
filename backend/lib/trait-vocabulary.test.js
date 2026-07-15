'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m033 } = require('../migrations/033_traits_vocabulary');
const { loadVocabulary, renderVocabularyMarkdown, validateClaimAgainstVocab } = require('./trait-vocabulary');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await m033(db);
  return db;
}

test('loadVocabulary returns array indexed by trait_name', async () => {
  const db = await freshDb();
  const vocab = await loadVocabulary(db);
  assert.ok(vocab.thermal_min);
  assert.equal(vocab.thermal_min.value_kind, 'numeric');
  assert.equal(vocab.thermal_min.expected_unit, '°C');
  assert.deepEqual(vocab.voltinism.enum_values, ['univoltine', 'bivoltine', 'multivoltine', 'continuous']);
});

test('renderVocabularyMarkdown produces non-empty markdown table', async () => {
  const db = await freshDb();
  const vocab = await loadVocabulary(db);
  const md = renderVocabularyMarkdown(vocab);
  assert.match(md, /trait_name/);
  assert.match(md, /value_kind/);
  assert.match(md, /thermal_min/);
  assert.match(md, /voltinism/);
});

test('validateClaimAgainstVocab rejects unknown trait_name', async () => {
  const db = await freshDb();
  const vocab = await loadVocabulary(db);
  const r = validateClaimAgainstVocab(vocab, { trait_name: 'foo_bar', value_numeric: 1, unit: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown trait/);
});

test('validateClaimAgainstVocab rejects wrong unit', async () => {
  const db = await freshDb();
  const vocab = await loadVocabulary(db);
  const r = validateClaimAgainstVocab(vocab, { trait_name: 'thermal_min', value_numeric: 7.3, unit: '°F' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unit/);
});

test('validateClaimAgainstVocab accepts well-formed claim', async () => {
  const db = await freshDb();
  const vocab = await loadVocabulary(db);
  const r = validateClaimAgainstVocab(vocab, { trait_name: 'thermal_min', value_numeric: 7.3, unit: '°C' });
  assert.equal(r.ok, true);
});
