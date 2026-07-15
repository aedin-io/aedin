const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('GET /api/admin/review/staging returns verdict_counts alongside items', async () => {
  const res = await request(app).get('/api/admin/review/staging?page=1&pageSize=10');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.verdict_counts, 'verdict_counts exists');
  for (const v of ['plausible', 'uncertain', 'implausible', 'out_of_scope', 'pending']) {
    assert.equal(typeof res.body.verdict_counts[v], 'number', `${v} is a number`);
  }
});

test('GET /api/admin/review/staging respects ai_vouch_status filter', async () => {
  const res = await request(app).get('/api/admin/review/staging?ai_vouch_status=plausible&pageSize=5');
  assert.equal(res.status, 200);
  assert.ok(res.body.total > 0, 'expected at least one plausible row in test DB — without this, a broken WHERE clause would pass vacuously');
  for (const item of res.body.items) {
    assert.equal(item.ai_vouch_status, 'plausible');
  }
});
