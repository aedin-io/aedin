'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { canonicalOrderForFamily, classifyDisagreement } = require('./order-canonical.js');

function ottFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ott_taxa (ott_id INTEGER PRIMARY KEY, parent_ott_id INTEGER,
                           name TEXT, rank TEXT, source_info TEXT, uniqname TEXT, flags TEXT);
    -- Capnodiales > Mycosphaerellaceae   (OTT's placement; we store Mycosphaerellales)
    INSERT INTO ott_taxa VALUES (100, NULL, 'Dothideomycetes', 'class', '', '', '');
    INSERT INTO ott_taxa VALUES (101, 100,  'Capnodiales', 'order', '', '', '');
    INSERT INTO ott_taxa VALUES (102, 101,  'Mycosphaerellaceae', 'family', '', '', '');
    -- Mycosphaerellales also exists as a real order elsewhere -> CONTESTED
    INSERT INTO ott_taxa VALUES (103, 100,  'Mycosphaerellales', 'order', '', '', '');
    -- Ranunculales > Ranunculaceae; 'Polycarpicae' exists nowhere -> ARCHAIC
    INSERT INTO ott_taxa VALUES (200, NULL, 'Magnoliopsida', 'class', '', '', '');
    INSERT INTO ott_taxa VALUES (201, 200,  'Ranunculales', 'order', '', '', '');
    INSERT INTO ott_taxa VALUES (202, 201,  'Ranunculaceae', 'family', '', '', '');
    -- Psocodea exists but as a SUPERORDER, so it is not a valid taxon_order value
    INSERT INTO ott_taxa VALUES (300, NULL, 'Insecta', 'class', '', '', '');
    INSERT INTO ott_taxa VALUES (301, 300,  'Psocodea', 'superorder', '', '', '');
    INSERT INTO ott_taxa VALUES (302, 301,  'Phthiraptera', 'order', '', '', '');
    INSERT INTO ott_taxa VALUES (303, 302,  'Menoponidae', 'family', '', '', '');
  `);
  return db;
}

test('canonicalOrderForFamily walks the family to its order', () => {
  const db = ottFixture();
  assert.equal(canonicalOrderForFamily(db, 'Mycosphaerellaceae'), 'Capnodiales');
  assert.equal(canonicalOrderForFamily(db, 'Ranunculaceae'), 'Ranunculales');
  assert.equal(canonicalOrderForFamily(db, 'Menoponidae'), 'Phthiraptera',
    'must skip the superorder and return the ORDER');
});

test('canonicalOrderForFamily returns null for a family OTT cannot place', () => {
  assert.equal(canonicalOrderForFamily(ottFixture(), 'Nonexistaceae'), null);
});

test('an order name OTT does not carry at order rank is ARCHAIC', () => {
  const db = ottFixture();
  assert.equal(classifyDisagreement(db, 'Polycarpicae', 'Ranunculales'), 'archaic');
  assert.equal(classifyDisagreement(db, 'Psocodea', 'Phthiraptera'), 'archaic',
    'a superorder in the order column is not a valid order value');
});

test('a disagreement between two real orders is CONTESTED, not archaic', () => {
  const db = ottFixture();
  assert.equal(classifyDisagreement(db, 'Mycosphaerellales', 'Capnodiales'), 'contested',
    'both are real OTT orders — adopting one is picking a side, and the audit trail must say so');
});

test('matching names are agree, and a missing canonical yields no verdict', () => {
  const db = ottFixture();
  assert.equal(classifyDisagreement(db, 'Ranunculales', 'Ranunculales'), 'agree');
  assert.equal(classifyDisagreement(db, 'Ranunculales', null), 'agree');
});
