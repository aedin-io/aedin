const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

// source_id 6 is the smallest source with extraction_staging rows in the live DB.
const SOURCE_ID = 6;

test('GET /api/admin/review/source-progress returns the four-stage shape', async () => {
  const res = await request(app).get(`/api/admin/review/source-progress?source_id=${SOURCE_ID}`);
  assert.equal(res.status, 200);

  const body = res.body;
  assert.ok(body.source, 'response has a source block');
  assert.equal(typeof body.source.id, 'number');

  for (const stage of ['queue', 'staging', 'entities', 'claims']) {
    assert.ok(body[stage], `response has ${stage} block`);
    assert.equal(typeof body[stage].total, 'number', `${stage}.total is a number`);
  }

  // Staging-specific: by_verdict is an object; keys are a subset of the 4 vouch values
  assert.ok(body.staging.by_verdict !== null && typeof body.staging.by_verdict === 'object', 'staging.by_verdict exists');
  const validVerdicts = new Set(['plausible', 'uncertain', 'implausible', 'out_of_scope', 'pending']);
  for (const key of Object.keys(body.staging.by_verdict)) {
    assert.ok(validVerdicts.has(key), `by_verdict key '${key}' is a valid vouch status`);
    assert.equal(typeof body.staging.by_verdict[key], 'number', `by_verdict.${key} is a number`);
  }

  // Entities-specific: incomplete count
  assert.equal(typeof body.entities.incomplete, 'number');

  // entity_trait_staging block
  assert.ok(body.entity_trait_staging, 'response has entity_trait_staging block');
  assert.equal(typeof body.entity_trait_staging.total,   'number', 'entity_trait_staging.total is a number');
  assert.equal(typeof body.entity_trait_staging.pending, 'number', 'entity_trait_staging.pending is a number');

  // entity_traits block
  assert.ok(body.entity_traits, 'response has entity_traits block');
  assert.equal(typeof body.entity_traits.total,   'number', 'entity_traits.total is a number');
  assert.equal(typeof body.entity_traits.pending, 'number', 'entity_traits.pending is a number');
});

test('GET /api/admin/review/source-progress returns 400 when source_id missing', async () => {
  const res = await request(app).get('/api/admin/review/source-progress');
  assert.equal(res.status, 400);
});

test('GET /api/admin/review/source-progress returns 404 for non-existent source', async () => {
  const res = await request(app).get('/api/admin/review/source-progress?source_id=999999999');
  assert.equal(res.status, 404);
});
