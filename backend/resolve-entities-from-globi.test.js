'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { resolveEntities } = require('./resolve-entities-from-globi');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, bio_category TEXT,
    gbif_key INTEGER, kingdom TEXT, phylum TEXT, taxon_class TEXT, taxon_order TEXT,
    family TEXT, genus TEXT, lineage_source TEXT
  )`);
  db.exec(`CREATE TABLE interactions (
    source_name TEXT, source_taxon_ids TEXT, source_kingdom TEXT, source_phylum TEXT,
    source_class TEXT, source_order TEXT, source_family TEXT, source_genus TEXT,
    target_name TEXT, target_taxon_ids TEXT, target_kingdom TEXT, target_phylum TEXT,
    target_class TEXT, target_order TEXT, target_family TEXT, target_genus TEXT
  )`);
  return db;
}

function srcRow(db, name, ids, lin = {}) {
  db.prepare(`INSERT INTO interactions
    (source_name, source_taxon_ids, source_kingdom, source_phylum, source_class, source_order, source_family, source_genus)
    VALUES (?,?,?,?,?,?,?,?)`).run(name, ids,
      lin.kingdom||'Animalia', lin.phylum||'Arthropoda', lin.class||'Insecta',
      lin.order||'Hymenoptera', lin.family||'Apidae', lin.genus||'Apis');
}

test('mode pick: most-frequent GBIF key wins', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO entities (id, scientific_name, bio_category) VALUES (1,'Apis mellifera','other')`).run();
  srcRow(db, 'Apis mellifera', 'GBIF:100');
  srcRow(db, 'Apis mellifera', 'GBIF:100');
  srcRow(db, 'Apis mellifera', 'GBIF:100');
  srcRow(db, 'Apis mellifera', 'GBIF:200');
  const r = resolveEntities(db, { force: true });
  const e = db.prepare('SELECT * FROM entities WHERE id=1').get();
  assert.equal(e.gbif_key, 100);
  assert.equal(e.lineage_source, 'globi');
  assert.equal(e.genus, 'Apis');
  assert.equal(e.bio_category, 'invertebrate');
  assert.equal(r.histogram.globi_keyed, 1);
});

test('--force overwrites a differing existing key and logs disagreement', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO entities (id, scientific_name, bio_category, gbif_key) VALUES (1,'Apis mellifera','invertebrate',999)`).run();
  srcRow(db, 'Apis mellifera', 'GBIF:100');
  const r = resolveEntities(db, { force: true });
  assert.equal(db.prepare('SELECT gbif_key FROM entities WHERE id=1').get().gbif_key, 100);
  assert.equal(r.histogram.key_disagreements, 1);
});

test('incremental only fills null gbif_key', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO entities (id, scientific_name, bio_category, gbif_key) VALUES (1,'Apis mellifera','invertebrate',999)`).run();
  db.prepare(`INSERT INTO entities (id, scientific_name, bio_category) VALUES (2,'Bombus terrestris','other')`).run();
  srcRow(db, 'Apis mellifera', 'GBIF:100');
  srcRow(db, 'Bombus terrestris', 'GBIF:300');
  resolveEntities(db, { force: false });
  assert.equal(db.prepare('SELECT gbif_key FROM entities WHERE id=1').get().gbif_key, 999);
  assert.equal(db.prepare('SELECT gbif_key FROM entities WHERE id=2').get().gbif_key, 300);
});

test('no:match entity left untouched', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO entities (id, scientific_name, bio_category) VALUES (1,'Mystery taxon','other')`).run();
  srcRow(db, 'Mystery taxon', 'no:match');
  const r = resolveEntities(db, { force: true });
  const e = db.prepare('SELECT * FROM entities WHERE id=1').get();
  assert.equal(e.gbif_key, null);
  assert.equal(e.lineage_source, null);
  assert.equal(r.histogram.fallback_no_match, 1);
});

test('bio_category not clobbered when already classified', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO entities (id, scientific_name, bio_category) VALUES (1,'Apis mellifera','invertebrate')`).run();
  srcRow(db, 'Apis mellifera', 'GBIF:100', { kingdom: 'Plantae' });
  resolveEntities(db, { force: true });
  assert.equal(db.prepare('SELECT bio_category FROM entities WHERE id=1').get().bio_category, 'invertebrate');
});

test('--dry-run writes nothing but returns histogram', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO entities (id, scientific_name, bio_category) VALUES (1,'Apis mellifera','other')`).run();
  srcRow(db, 'Apis mellifera', 'GBIF:100');
  const r = resolveEntities(db, { force: true, dryRun: true });
  assert.equal(db.prepare('SELECT gbif_key FROM entities WHERE id=1').get().gbif_key, null);
  assert.equal(r.histogram.globi_keyed, 1);
});
