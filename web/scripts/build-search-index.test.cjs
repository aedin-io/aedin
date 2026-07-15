'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { selectSearchRows } = require('./build-search-index.cjs');

test('selectSearchRows includes only servable entities with required fields', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
    common_name TEXT, primary_role TEXT, bio_category TEXT, family TEXT, scope_tier INTEGER);`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
    data_tier TEXT, review_status TEXT, chain_role TEXT, source_quote TEXT);`);
  db.prepare(`INSERT INTO entities VALUES (1,'crop','Zea mays','maize','crop','plantae','Poaceae',0),
    (2,'pest','Ostrinia nubilalis','borer','pest','invertebrate','Crambidae',1),
    (3,'orphan','Nothing here',NULL,NULL,NULL,NULL,NULL)`).run();
  db.prepare(`INSERT INTO claims VALUES (10,1,2,'tier1_paper','ai_reviewed',NULL,'q')`).run();
  const rows = selectSearchRows(db);
  const slugs = rows.map(r => r.slug).sort();
  assert.deepEqual(slugs, ['crop','pest']);   // orphan (no scope_tier, no claim) excluded
  assert.deepEqual(Object.keys(rows[0]).sort(), ['bio_category','common_name','family','primary_role','scientific_name','slug']);
  db.close();
});
