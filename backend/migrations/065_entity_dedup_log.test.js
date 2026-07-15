// backend/migrations/065_entity_dedup_log.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m065 } = require('./065_entity_dedup_log');

test('065 creates entity_dedup_log, idempotently', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await m065(db);
  await m065(db);
  const cols = (await db.all(`PRAGMA table_info(entity_dedup_log)`)).map(c => c.name);
  for (const c of ['canonical_entity_id','merged_entity_id','redirected_claim_ids','redirected_trait_claim_ids','redirected_child_ids','undone_at'])
    assert.ok(cols.includes(c), `missing ${c}`);
});
