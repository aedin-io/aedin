import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesRegion, litCountsByEntity } from './region-counts.ts';

const F = (o = {}) => ({ scope: null, country: null, subdivision: null, ...o });
const E = (subject_id, object_id, r = {}) => ({ subject_id, object_id, country: null, subdivision: null, ...r });

test('matchesRegion ANDs the three axes', () => {
  assert.equal(matchesRegion(E(1, 2, { country: 'India' }), F()), true);
  assert.equal(matchesRegion(E(1, 2, { country: 'India' }), F({ country: 'India' })), true);
  assert.equal(matchesRegion(E(1, 2, { country: 'India' }), F({ country: 'Brazil' })), false);
  assert.equal(matchesRegion(E(1, 2, { country: 'US', subdivision: 'Texas' }), F({ country: 'US', subdivision: 'Texas' })), true);
  assert.equal(matchesRegion(E(1, 2, { country: 'US', subdivision: 'Texas' }), F({ country: 'US', subdivision: 'Ohio' })), false);
});

test('litCountsByEntity increments both endpoints for passing edges only', () => {
  const edges = [
    E(1, 2, { country: 'India' }),
    E(2, 3, { country: 'India' }),
    E(1, 3, { country: 'Brazil' }),
  ];
  const all = litCountsByEntity(edges, F());
  assert.deepEqual([all.get(1), all.get(2), all.get(3)], [2, 2, 2]);
  const india = litCountsByEntity(edges, F({ country: 'India' }));
  assert.deepEqual([india.get(1), india.get(2), india.get(3)], [1, 2, 1]);
  assert.equal(india.get(99), undefined);
});

test('matchesRegion: scope filter matches via edge.scopes (country rollup + coarse parents)', () => {
  const japan = { subject_id: 1, object_id: 2, scopes: ['Asia'], country: 'Japan', subdivision: null };
  const med   = { subject_id: 3, object_id: 4, scopes: ['Europe','Africa','Asia'], country: null, subdivision: null };
  assert.equal(matchesRegion(japan, { scope: 'Asia', country: null, subdivision: null }), true);
  assert.equal(matchesRegion(med,   { scope: 'Africa', country: null, subdivision: null }), true);
  assert.equal(matchesRegion(med,   { scope: 'North America', country: null, subdivision: null }), false);
  assert.equal(matchesRegion(japan, { scope: null, country: 'Japan', subdivision: null }), true);
  assert.equal(matchesRegion(japan, { scope: null, country: 'China', subdivision: null }), false);
});
