// web/scripts/build-d1.merge.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { entityIdsFromMergedTombstones } = require('./build-d1.cjs');

// A served tombstone (slug + merged_into set) must be retained by the build's
// entity selection so its D1 row survives a full rebuild (else its slug 404s).
test('served merged tombstones are included in the build entity set', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scope_tier INTEGER, merged_into_entity_id INTEGER);`);
  db.prepare(`INSERT INTO entities (id, slug, scope_tier, merged_into_entity_id) VALUES (11,'dup',0,10)`).run(); // served tombstone
  db.prepare(`INSERT INTO entities (id, slug, scope_tier, merged_into_entity_id) VALUES (12,NULL,NULL,10)`).run(); // UNSERVED tombstone → not needed
  const ids = entityIdsFromMergedTombstones(db);
  assert.deepEqual(ids, [11]);
});
