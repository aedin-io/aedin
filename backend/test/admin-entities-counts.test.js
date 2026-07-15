const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('GET /api/admin/review/entities returns completeness_counts', async () => {
  const res = await request(app).get('/api/admin/review/entities?pageSize=10');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.completeness_counts, 'completeness_counts exists');
  assert.equal(typeof res.body.completeness_counts.incomplete, 'number');
  assert.equal(typeof res.body.completeness_counts.complete, 'number');
});

test('GET /api/admin/review/entities respects completeness=incomplete filter', async () => {
  const res = await request(app).get('/api/admin/review/entities?completeness=incomplete&pageSize=10');
  assert.equal(res.status, 200);
  assert.ok(res.body.total > 0, 'expected at least one incomplete entity in test DB — guards against vacuous pass');
  for (const e of res.body.items) {
    const isIncomplete = !e.scientific_name || !e.bio_category || !e.taxonomy_path ||
                         !e.primary_role ||
                         (e.primary_role === 'crop' && !e.crop_type) ||
                         e.needs_dedup === 1;
    assert.ok(isIncomplete, `entity ${e.id} satisfies incompleteness rule`);
  }
});

test('GET /api/admin/review/entities respects completeness=complete filter', async () => {
  const res = await request(app).get('/api/admin/review/entities?completeness=complete&pageSize=10&scope=all');
  assert.equal(res.status, 200);
  assert.ok(res.body.total > 0, 'expected at least one complete entity in test DB');
  for (const e of res.body.items) {
    const isComplete = e.scientific_name && e.bio_category && e.taxonomy_path &&
                       e.primary_role &&
                       !(e.primary_role === 'crop' && !e.crop_type) &&
                       e.needs_dedup !== 1;
    assert.ok(isComplete, `entity ${e.id} is complete`);
  }
});
