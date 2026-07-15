// web/src/lib/merge-redirect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMergeRedirect } from './queries-d1.ts';

test('a live entity (no merged_into) → no redirect', () => {
  assert.equal(resolveMergeRedirect({ merged_into_entity_id: null }, 'canon'), null);
  assert.equal(resolveMergeRedirect({}, 'canon'), null);
});

test('a tombstone with a canonical slug → 301 to /entity/<slug>', () => {
  assert.deepEqual(
    resolveMergeRedirect({ merged_into_entity_id: 100 }, 'cocos-nucifera'),
    { location: '/entity/cocos-nucifera', status: 301 }
  );
});

test('a tombstone with no canonical slug → null (caller 404s)', () => {
  assert.equal(resolveMergeRedirect({ merged_into_entity_id: 100 }, null), null);
});
