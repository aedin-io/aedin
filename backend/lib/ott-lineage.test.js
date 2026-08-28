'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { lineageRanks, compareFields } = require('./ott-lineage.js');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ott_taxa (ott_id INTEGER PRIMARY KEY, parent_ott_id INTEGER,
                           name TEXT, rank TEXT, source_info TEXT, uniqname TEXT, flags TEXT);
    INSERT INTO ott_taxa VALUES (304358, NULL,   'Archaeplastida', 'kingdom', '', '', '');
    INSERT INTO ott_taxa VALUES (1008296, 304358, 'fabids', 'no rank', '', '', '');
    INSERT INTO ott_taxa VALUES (565281, 1008296, 'Rosales', 'order', '', '', '');
    INSERT INTO ott_taxa VALUES (208031, 565281, 'Moraceae', 'family', '', '', '');
    INSERT INTO ott_taxa VALUES (658513, 208031, 'Ficus', 'genus', '', '', '');
    INSERT INTO ott_taxa VALUES (1050104, 658513, 'Ficus variegata Blume, 1825', 'species', '', '', '');
  `);
  return db;
}

test('lineageRanks collects Linnaean ranks and skips no-rank clades', () => {
  const r = lineageRanks(fixture(), 1050104);
  assert.equal(r.kingdom, 'Archaeplastida');
  assert.equal(r.order, 'Rosales');
  assert.equal(r.family, 'Moraceae');
  assert.equal(r.genus, 'Ficus');
  assert.equal('fabids' in r, false, 'no-rank clades must not become fields');
});

test('compareFields classifies each field into one of four buckets', () => {
  const rows = compareFields(
    { kingdom: 'Plantae', phylum: 'Mollusca', family: null,      genus: 'Ficus' },
    { kingdom: 'Plantae', phylum: 'Streptophyta', family: 'Moraceae', genus: null  });
  const byField = Object.fromEntries(rows.map(r => [r.field, r.verdict]));
  assert.equal(byField.kingdom, 'agree');
  assert.equal(byField.phylum, 'differ');
  assert.equal(byField.family, 'ours_missing');
  assert.equal(byField.genus, 'ott_missing');
});

test('compareFields: both values null is agree with bothMissing true', () => {
  const rows = compareFields({ kingdom: null }, { kingdom: null });
  const r = rows.find(r => r.field === 'kingdom');
  assert.equal(r.verdict, 'agree');
  assert.equal(r.bothMissing, true);
});

test('compareFields: both present and equal is agree with bothMissing falsy', () => {
  const rows = compareFields({ kingdom: 'Plantae' }, { kingdom: 'Plantae' });
  const r = rows.find(r => r.field === 'kingdom');
  assert.equal(r.verdict, 'agree');
  assert.ok(!r.bothMissing);
});
