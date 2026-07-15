'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest } = require('./source-manifest');

const good = { entries: [{
  id: 'sare_x', source_org: 'USDA SARE', title: 'T', filename: 'sare_x.pdf',
  category: 'extension', canonical_url: 'https://e/x.pdf',
  fetch_urls: ['https://e/x.pdf'], license: 'public-domain',
}]};

test('valid manifest passes', () => {
  assert.deepEqual(validateManifest(good), { ok: true, errors: [] });
});

test('missing required field fails with id-tagged error', () => {
  const bad = { entries: [{ ...good.entries[0], license: undefined }] };
  const r = validateManifest(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('sare_x') && e.includes('license')));
});

test('duplicate id fails', () => {
  const dup = { entries: [good.entries[0], good.entries[0]] };
  const r = validateManifest(dup);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('duplicate') && e.includes('sare_x')));
});

test('empty fetch_urls fails', () => {
  const bad = { entries: [{ ...good.entries[0], fetch_urls: [] }] };
  assert.equal(validateManifest(bad).ok, false);
});
