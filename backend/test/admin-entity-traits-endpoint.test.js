const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('GET /api/admin/review/entity-traits returns shape with status_counts', async () => {
  const res = await request(app).get('/api/admin/review/entity-traits?pageSize=5');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(typeof res.body.total, 'number');
  assert.ok(res.body.status_counts);
});

test('respects review_status filter', async () => {
  const res = await request(app).get('/api/admin/review/entity-traits?review_status=ai_vouched&pageSize=5');
  assert.equal(res.status, 200);
  // Don't assert non-empty — if no rows with this status exist, that's fine
  for (const it of res.body.items) {
    assert.equal(it.review_status, 'ai_vouched');
  }
});
