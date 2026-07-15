'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m045 } = require('./045_entity_dedup_candidates');
const { runMigration: m064 } = require('./064_entity_dedup_tier');

test('064 adds a tier column, idempotently', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY)`);
  await m045(db);
  await m064(db);
  await m064(db); // idempotent — second run must not throw
  const cols = (await db.all(`PRAGMA table_info(entity_dedup_candidates)`)).map(c => c.name);
  assert.ok(cols.includes('tier'));
});
