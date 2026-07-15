'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m037 } = require('../migrations/037_variety_dedup_log');
const { runMigration: m038 } = require('../migrations/038_variety_dedup_reversibility');

test('migration 038 adds reversibility columns (idempotent)', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY)');
  await m037(db);
  await m038(db);
  await m038(db); // idempotent
  const cols = (await db.all(`PRAGMA table_info(variety_dedup_log)`)).map(c => c.name);
  for (const c of ['redirected_claim_ids', 'redirected_trait_claim_ids', 'undone_at']) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
});
