'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { CORPUS_DB, RAW_DB, ATTACH_RAW_SQL, ATTACH_CORPUS_SQL, RAW_TABLES } = require('./db-paths.cjs');

test('CORPUS_DB and RAW_DB resolve to the backend dir', () => {
  assert.equal(path.basename(CORPUS_DB), 'aedin.sqlite');
  assert.equal(path.basename(RAW_DB), 'globi.sqlite');
  // both live in the backend/ dir (parent of lib/)
  assert.equal(path.dirname(CORPUS_DB), path.resolve(__dirname, '..'));
  assert.equal(path.dirname(RAW_DB), path.resolve(__dirname, '..'));
});

test('ATTACH_RAW_SQL attaches RAW_DB under the raw alias', () => {
  assert.equal(ATTACH_RAW_SQL, `ATTACH DATABASE '${RAW_DB}' AS raw`);
});

test('RAW_TABLES is the 6 raw GloBI tables', () => {
  assert.deepEqual(
    [...RAW_TABLES].sort(),
    ['claim_remap_log', 'crop_locality_coverage', 'globi_fetch_log',
     'interaction_locality_coverage', 'interactions', 'species_locality_coverage'].sort()
  );
});

test('ATTACH_CORPUS_SQL attaches CORPUS_DB under the corpus alias', () => {
  assert.equal(ATTACH_CORPUS_SQL, `ATTACH DATABASE '${CORPUS_DB}' AS corpus`);
});
