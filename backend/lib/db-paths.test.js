'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { OTT_DB, ATTACH_OTT_SQL, BACKEND_DIR } = require('./db-paths.cjs');

test('OTT_DB sits beside the corpus in backend/', () => {
  assert.equal(OTT_DB, path.join(BACKEND_DIR, 'ott.sqlite'));
});

test('ATTACH_OTT_SQL attaches the OTT db under the ott alias', () => {
  assert.equal(ATTACH_OTT_SQL, `ATTACH DATABASE '${OTT_DB}' AS ott`);
});
