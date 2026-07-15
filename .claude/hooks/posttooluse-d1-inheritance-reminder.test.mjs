import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRemind } from './posttooluse-d1-inheritance-reminder.mjs';

test('reminds on a D1 trait-data publish (filename signal)', () => {
  assert.equal(shouldRemind('cd web && wrangler d1 execute agroeco --remote --file=d1/patch-traits.sql --yes'), true);
  assert.equal(shouldRemind('npx wrangler d1 execute agroeco --remote --file=web/d1/patch-foundational-traits.sql'), true);
});

test('reminds on an inline entity_trait_claims publish (--command signal)', () => {
  assert.equal(shouldRemind('wrangler d1 execute agroeco --remote --command="INSERT INTO entity_trait_claims (id) VALUES (1)"'), true);
});

test('does NOT remind on the inheritance refresh itself', () => {
  assert.equal(shouldRemind('wrangler d1 execute agroeco --remote --file=web/d1/patch-inheritance-refresh.sql'), false);
});

test('does NOT remind on non-trait D1 publishes (claims, varieties, merges)', () => {
  assert.equal(shouldRemind('wrangler d1 execute agroeco --remote --file=d1/patch-claims.sql'), false);
  assert.equal(shouldRemind('wrangler d1 execute agroeco --remote --file=d1/patch-merge.sql'), false);
});

test('does NOT remind on local (non --remote) executes or unrelated commands', () => {
  assert.equal(shouldRemind('wrangler d1 execute agroeco --file=d1/patch-traits.sql'), false); // local, no --remote
  assert.equal(shouldRemind('node web/scripts/gen-inheritance-refresh.cjs'), false);
  assert.equal(shouldRemind(''), false);
  assert.equal(shouldRemind('git status'), false);
});
