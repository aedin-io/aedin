const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('GET /api/admin/review/queue returns status_counts alongside items', async () => {
  const res = await request(app).get('/api/admin/review/queue?pageSize=10');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.status_counts, 'status_counts exists');
  for (const v of ['ai_reviewed', 'human_verified', 'human_rejected', 'disputed']) {
    assert.equal(typeof res.body.status_counts[v], 'number', `${v} is a number`);
  }
});

test('GET /api/admin/review/queue respects review_status filter', async () => {
  const res = await request(app).get('/api/admin/review/queue?review_status=ai_reviewed&pageSize=5');
  assert.equal(res.status, 200);
  assert.ok(res.body.total > 0, 'expected at least one ai_reviewed row in test DB');
  for (const item of res.body.items) {
    assert.equal(item.review_status, 'ai_reviewed');
  }
});

test('GET /api/admin/review/queue critic_verdicts has at least 5 pipe-separated fields per line', async () => {
  // Fetch a page large enough to hopefully include a claim with critic verdicts
  const res = await request(app).get('/api/admin/review/queue?pageSize=50');
  assert.equal(res.status, 200);

  const withVerdicts = res.body.items.filter(it => it.critic_verdicts);
  if (withVerdicts.length === 0) {
    // No claims with critic verdicts in current DB — skip substantive check
    return;
  }
  for (const item of withVerdicts) {
    for (const line of item.critic_verdicts.split('\n')) {
      if (!line.trim()) continue;
      const fields = line.split('|');
      assert.ok(
        fields.length >= 5,
        `critic_verdicts line should have >=5 pipe-separated fields, got ${fields.length}: "${line}"`
      );
    }
  }
});
