'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findLiveIdCollisions, assertNoLiveIdCollision } = require('./id-collision-guard.cjs');

test('findLiveIdCollisions returns the live ids among candidates, querying in chunks', () => {
  const live = new Set([2, 5, 9]);
  const chunkSizes = [];
  const lookup = (ids) => { chunkSizes.push(ids.length); return ids.filter(id => live.has(id)); };
  const collisions = findLiveIdCollisions([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], lookup, 4);
  assert.deepStrictEqual(collisions.sort((a, b) => a - b), [2, 5, 9]);
  assert.deepStrictEqual(chunkSizes, [4, 4, 2], 'chunked 4,4,2 across 10 candidates');
});

test('assertNoLiveIdCollision passes (no throw) when nothing collides', () => {
  assert.doesNotThrow(() => assertNoLiveIdCollision([100, 101, 102], () => [], 'new-claim'));
});

test('assertNoLiveIdCollision throws a labelled, id-listing error on a collision', () => {
  assert.throws(
    () => assertNoLiveIdCollision([1, 2, 3], (ids) => ids.filter(i => i === 2), 'new-claim'),
    (err) => /ABORT: 1 new-claim id\(s\)/.test(err.message) && /\b2\b/.test(err.message),
  );
});

test('empty candidate list never calls the lookup and passes', () => {
  let called = false;
  assert.doesNotThrow(() => assertNoLiveIdCollision([], () => { called = true; return []; }, 'new-trait'));
  assert.strictEqual(called, false, 'lookup must not run for an empty delta');
});
