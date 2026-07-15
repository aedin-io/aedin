const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('GET /api/admin/review/priority returns shape', async () => {
  const res = await request(app).get('/api/admin/review/priority?pageSize=5');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(typeof res.body.total, 'number');
});
