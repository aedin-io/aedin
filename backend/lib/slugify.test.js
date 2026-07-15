'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { slugify, uniqueSlug } = require('./slugify');

test('slugify: canonical format', () => {
  assert.equal(slugify('Achillea alpina subsp. japonica'), 'achillea-alpina-subsp-japonica');
  assert.equal(slugify('Aesculus × carnea'), 'aesculus-carnea');               // × stripped
  assert.equal(slugify('Leiophron pallipes (Curt.)'), 'leiophron-pallipes-curt');
  assert.equal(slugify('Coix lacryma-jobi'), 'coix-lacryma-jobi');             // intra-word hyphen kept
  assert.equal(slugify("Solanum lycopersicum 'Clemson Spineless'"), 'solanum-lycopersicum-clemson-spineless');
  assert.equal(slugify(''), '');
  assert.equal(slugify('×'), '');
});

function memDb() {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT)');
  return d;
}
test('uniqueSlug: free base returned as-is', () => {
  assert.equal(uniqueSlug(memDb(), 'foo-bar'), 'foo-bar');
});
test('uniqueSlug: collides with an existing slug -> -2', () => {
  const d = memDb(); d.prepare("INSERT INTO entities (slug) VALUES ('foo-bar')").run();
  assert.equal(uniqueSlug(d, 'foo-bar'), 'foo-bar-2');
});
test('uniqueSlug: same base twice in one batch via taken -> base, base-2', () => {
  const d = memDb(); const taken = new Set();
  assert.equal(uniqueSlug(d, 'foo', taken), 'foo');
  assert.equal(uniqueSlug(d, 'foo', taken), 'foo-2');
});
test('uniqueSlug: empty base -> non-empty deterministic', () => {
  assert.equal(uniqueSlug(memDb(), ''), '-2');
});
