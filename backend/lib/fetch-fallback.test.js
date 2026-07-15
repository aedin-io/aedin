'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { acquireOne } = require('./fetch-fallback');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(11000)]);
const HTML = Buffer.from('<!DOCTYPE html>');

function fakeFetch(map) {
  return async (url) => {
    const v = map[url];
    if (!v) return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) };
    return { ok: true, status: 200, arrayBuffer: async () => v };
  };
}

const entry = (urls, canonical) => ({
  id: 'x', canonical_url: canonical, fetch_urls: urls, filename: 'x.pdf', category: 'extension',
});

test('first url valid -> ok', async () => {
  const e = entry(['https://a/x.pdf'], 'https://a/x.pdf');
  const r = await acquireOne(e, { fetchImpl: fakeFetch({ 'https://a/x.pdf': PDF }), floor: 10240 });
  assert.equal(r.status, 'ok');
  assert.equal(r.url_used, 'https://a/x.pdf');
});

test('first fails, mirror valid -> mirror-used', async () => {
  const e = entry(['https://a/x.pdf', 'https://mirror/x.pdf'], 'https://a/x.pdf');
  const r = await acquireOne(e, { fetchImpl: fakeFetch({ 'https://mirror/x.pdf': PDF }), floor: 10240 });
  assert.equal(r.status, 'mirror-used');
  assert.equal(r.url_used, 'https://mirror/x.pdf');
});

test('HTML placeholder treated as failure', async () => {
  const e = entry(['https://a/x.pdf'], 'https://a/x.pdf');
  const r = await acquireOne(e, { fetchImpl: fakeFetch({ 'https://a/x.pdf': HTML }), floor: 10240 });
  assert.equal(r.status, 'gate');
});

test('canonical present, all fail -> gate', async () => {
  const e = entry(['https://a/x.pdf'], 'https://a/x.pdf');
  const r = await acquireOne(e, { fetchImpl: fakeFetch({}), floor: 10240 });
  assert.equal(r.status, 'gate');
});

test('no canonical in list, all fail -> fail', async () => {
  const e = entry(['https://mirror/x.pdf'], 'https://canonical-not-fetchable/x.pdf');
  const r = await acquireOne(e, { fetchImpl: fakeFetch({}), floor: 10240 });
  assert.equal(r.status, 'fail');
});
