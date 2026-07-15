'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./052_claim_localities');

test('052 creates claim_localities with PK + indexes, idempotently', () => {
  const db = new Database(':memory:');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(claim_localities)').all().map(c => c.name);
  assert.deepEqual(cols, ['claim_id', 'country', 'subdivision']);
  const idx = db.prepare('PRAGMA index_list(claim_localities)').all().map(i => i.name);
  assert.ok(idx.includes('idx_cl_country'));
  assert.ok(idx.includes('idx_cl_claim'));
  migrate(db); // idempotent: second run must not throw
  db.close();
});
