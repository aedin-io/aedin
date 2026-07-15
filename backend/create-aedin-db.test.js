'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { copyCorpus, RAW_TABLES } = require('./create-aedin-db.js');

test('copyCorpus copies non-raw tables with rows + indexes, excludes raw tables', () => {
  const src = new Database(':memory:');
  src.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT);
            CREATE INDEX idx_e_name ON entities(name);
            CREATE TABLE interactions (id INTEGER PRIMARY KEY, src TEXT);`); // raw
  src.prepare('INSERT INTO entities VALUES (1, ?)').run('Garlic');
  src.prepare('INSERT INTO interactions VALUES (1, ?)').run('eats');

  const dest = new Database(':memory:');
  copyCorpus(src, dest, new Set(['interactions']));

  // corpus table copied with its row
  assert.equal(dest.prepare('SELECT name FROM entities WHERE id=1').get().name, 'Garlic');
  // its index copied
  const idx = dest.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entities'").all().map(r => r.name);
  assert.ok(idx.includes('idx_e_name'));
  // raw table NOT copied
  assert.equal(dest.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='interactions'").get().n, 0);
  src.close(); dest.close();
});
