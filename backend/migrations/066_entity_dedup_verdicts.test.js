'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m066 } = require('./066_entity_dedup_verdicts');

test('066 creates entity_dedup_verdicts, idempotently', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await m066(db);
  await m066(db); // idempotent
  const cols = (await db.all(`PRAGMA table_info(entity_dedup_verdicts)`)).map(c => c.name);
  for (const c of ['candidate_id', 'critic_name', 'verdict', 'confidence', 'suggested_canonical_id', 'reasoning', 'model'])
    assert.ok(cols.includes(c), `missing ${c}`);
  // CHECK constraint admits the 3 verdicts, rejects others
  await db.run(`INSERT INTO entity_dedup_verdicts (candidate_id, critic_name, verdict) VALUES (1,'x','same')`);
  await assert.rejects(() => db.run(`INSERT INTO entity_dedup_verdicts (candidate_id, critic_name, verdict) VALUES (2,'x','maybe')`));
});
