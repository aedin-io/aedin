'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m067 } = require('./067_claims_resistance_level');

test('067 adds claims.resistance_level, idempotently', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, interaction_category TEXT)`);
  await m067(db);
  await m067(db); // idempotent
  const cols = (await db.all(`PRAGMA table_info(claims)`)).map(c => c.name);
  assert.ok(cols.includes('resistance_level'));
});
