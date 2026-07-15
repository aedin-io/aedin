'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('POST /api/admin/staging/bulk rejects empty ids', async () => {
  const res = await request(app).post('/api/admin/staging/bulk').send({ ids: [], action: 'accept' });
  assert.equal(res.status, 400);
});

test('POST /api/admin/staging/bulk rejects missing ids', async () => {
  const res = await request(app).post('/api/admin/staging/bulk').send({ action: 'accept' });
  assert.equal(res.status, 400);
});

test('POST /api/admin/staging/bulk rejects invalid action', async () => {
  const res = await request(app).post('/api/admin/staging/bulk').send({ ids: [1], action: 'frobnicate' });
  assert.equal(res.status, 400);
});

test('POST /api/admin/staging/bulk caps at 200 ids', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => i + 1);
  const res = await request(app).post('/api/admin/staging/bulk').send({ ids, action: 'accept' });
  assert.equal(res.status, 400);
  assert.match(res.body.error || '', /200/);
});

// Smoke test: only runs if there are ≥2 staging rows.
test('POST /api/admin/staging/bulk writes review_status in a transaction', async () => {
  // Find two rows we can safely toggle
  const pickRes = await request(app).get('/api/admin/review/staging?pageSize=2');
  if (!pickRes.body.items || pickRes.body.items.length < 2) return; // skip
  const rows = pickRes.body.items.slice(0, 2);
  const ids = rows.map(r => r.id);
  const originalStatuses = rows.map(r => r.review_status);

  // Flip to flagged
  const r1 = await request(app).post('/api/admin/staging/bulk').send({ ids, action: 'flag' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.updated, ids.length);

  // Verify state changed
  const verifyRes = await request(app).get('/api/admin/review/staging?pageSize=200');
  const flipped = verifyRes.body.items.filter(it => ids.includes(it.id));
  for (const it of flipped) {
    assert.equal(it.review_status, 'flagged');
  }

  // Restore (best-effort)
  for (let i = 0; i < ids.length; i++) {
    const prev = originalStatuses[i];
    if (!prev) continue;
    const reverseAction = prev === 'approved' ? 'accept' : prev === 'rejected' ? 'reject' : null;
    if (reverseAction) {
      await request(app).post('/api/admin/staging/bulk').send({ ids: [ids[i]], action: reverseAction });
    }
  }
});
