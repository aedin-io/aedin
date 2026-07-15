'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { selectGrinNarratives, chunk } = require('./grin-narrative-batch');

function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY, scientific_name TEXT, variety_name TEXT,
      parent_entity_id INTEGER, grin_accession TEXT, slug TEXT
    );
    CREATE TABLE grin_varieties (
      grin_accession TEXT, parent_entity_id INTEGER, plant_name TEXT, narrative TEXT
    );
  `);
  // Parent species
  db.prepare(`INSERT INTO entities (id, scientific_name) VALUES (1, 'Solanum lycopersicum')`).run();
  // A served variety entity (has slug + variety_name) linked by accession
  db.prepare(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, grin_accession, slug)
              VALUES (2, ?, ?, 1, ?, ?)`).run("Solanum lycopersicum 'Walter'", 'Walter', 'PI 1', 'walter');
  // grin rows: one resistance (served), one trait-only (unserved), one empty narrative
  db.prepare(`INSERT INTO grin_varieties VALUES (?, 1, ?, ?)`).run('PI 1', "'Walter'", 'First tomato variety with resistance to the Fusarium wilt pathogen.');
  db.prepare(`INSERT INTO grin_varieties VALUES (?, 1, ?, ?)`).run('PI 2', "'Bellstar'", 'Determinate. 70 days. Productive paste tomato.');
  db.prepare(`INSERT INTO grin_varieties VALUES (?, 1, ?, ?)`).run('PI 3', "'Empty'", '');
  return db;
}

test('phase=resistance admits only resistance/tolerance narratives', () => {
  const db = seed();
  const rows = selectGrinNarratives(db, 'resistance');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grin_accession, 'PI 1');
  assert.equal(rows[0].parent_scientific_name, 'Solanum lycopersicum');
  // served variety: emits the stored variety_name + entity id (so promote attaches, not duplicates)
  assert.equal(rows[0].variety_name, 'Walter');
  assert.equal(rows[0].variety_entity_id, 2);
});

test('phase=traits admits all non-empty narratives; unserved variety has null entity id', () => {
  const db = seed();
  const rows = selectGrinNarratives(db, 'traits');
  assert.equal(rows.length, 2); // PI 1 + PI 2, not the empty PI 3
  const bell = rows.find(r => r.grin_accession === 'PI 2');
  assert.equal(bell.variety_entity_id, null);   // unserved → no entity row
  assert.equal(bell.variety_name, "'Bellstar'"); // falls back to plant_name
});

test('chunk splits into batches of the given size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});
