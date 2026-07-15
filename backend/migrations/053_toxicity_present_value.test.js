'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m033 } = require('./033_traits_vocabulary');
const { runMigration: m053 } = require('./053_toxicity_present_value');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await m033(db); // creates + seeds traits_vocabulary
  return db;
}

test('053 adds "present" to toxicity and allelopathic_activity enums', async () => {
  const db = await freshDb();
  await m053(db);
  for (const name of ['toxicity', 'allelopathic_activity']) {
    const row = await db.get('SELECT enum_values, description FROM traits_vocabulary WHERE trait_name = ?', [name]);
    const enums = JSON.parse(row.enum_values);
    assert.ok(enums.includes('present'), `${name} enum should include "present"`);
    assert.match(row.description, /present/i, `${name} description should mention the "present" rule`);
    assert.match(row.description, /ONLY when the source states/i, `${name} description should carry the no-infer rule`);
  }
  await db.close();
});

test('053 is idempotent (re-run leaves the same enum set)', async () => {
  const db = await freshDb();
  await m053(db);
  await m053(db);
  const row = await db.get("SELECT enum_values FROM traits_vocabulary WHERE trait_name = 'toxicity'");
  assert.deepStrictEqual(JSON.parse(row.enum_values), ['none', 'mild', 'moderate', 'severe', 'present']);
  await db.close();
});

test('053 does not disturb other trait rows', async () => {
  const db = await freshDb();
  const before = await db.get("SELECT enum_values FROM traits_vocabulary WHERE trait_name = 'growth_habit'");
  await m053(db);
  const after = await db.get("SELECT enum_values FROM traits_vocabulary WHERE trait_name = 'growth_habit'");
  assert.strictEqual(before.enum_values, after.enum_values);
  await db.close();
});
