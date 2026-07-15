'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextUnit } = require('./ingest-checkpoint');

const entries = [
  { id: 'a', filename: 'a.pdf', category: 'extension' },
  { id: 'b', filename: 'b.pdf', category: 'extension' },
];
const lock = { a: { sha256: '1' }, b: { sha256: '2' } }; // both acquired

test('returns first acquired-but-not-ingested', () => {
  const u = nextUnit({ manifestEntries: entries, lock, ingestedIds: new Set(['a']) });
  assert.deepEqual(u, { kind: 'extract', entry: entries[1] });
});
test('returns none when all ingested', () => {
  const u = nextUnit({ manifestEntries: entries, lock, ingestedIds: new Set(['a', 'b']) });
  assert.deepEqual(u, { kind: 'none' });
});
test('skips not-yet-acquired entries', () => {
  const u = nextUnit({ manifestEntries: entries, lock: { a: { sha256: '1' } }, ingestedIds: new Set(['a']) });
  assert.deepEqual(u, { kind: 'none' }); // b not in lock yet
});
test('returns first when nothing ingested', () => {
  const u = nextUnit({ manifestEntries: entries, lock, ingestedIds: new Set() });
  assert.deepEqual(u, { kind: 'extract', entry: entries[0] });
});
test('treats lock entry without sha256 as not acquired', () => {
  const u = nextUnit({ manifestEntries: entries, lock: { a: { sha256: '1' }, b: {} }, ingestedIds: new Set(['a']) });
  assert.deepEqual(u, { kind: 'none' }); // b in lock but no sha256 → not really acquired
});
