'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { classifyKingdomDelta, animalSubcategory } = require('./kingdom-align.js');

function ott() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ott_taxa (ott_id INTEGER PRIMARY KEY, parent_ott_id INTEGER,
                           name TEXT, rank TEXT, source_info TEXT, uniqname TEXT, flags TEXT);
    INSERT INTO ott_taxa VALUES (1, NULL, 'Metazoa', 'kingdom', '', '', '');
    -- vertebrate spine
    INSERT INTO ott_taxa VALUES (2, 1, 'Chordata', 'phylum', '', '', '');
    INSERT INTO ott_taxa VALUES (8, 2, 'Vertebrata', 'subphylum', '', '', '');
    INSERT INTO ott_taxa VALUES (3, 8, 'Aves', 'class', '', '', '');
    INSERT INTO ott_taxa VALUES (4, 3, 'Cinnyris ornatus', 'species', '', '', '');
    -- a tunicate: Chordata but NOT Vertebrata. Testing on Chordata would call it
    -- a vertebrate; testing on Vertebrata correctly leaves it invertebrate.
    INSERT INTO ott_taxa VALUES (9, 2, 'Tunicata', 'subphylum', '', '', '');
    INSERT INTO ott_taxa VALUES (10, 9, 'Ciona intestinalis', 'species', '', '', '');
    -- invertebrate spine
    INSERT INTO ott_taxa VALUES (5, 1, 'Arthropoda', 'phylum', '', '', '');
    INSERT INTO ott_taxa VALUES (6, 5, 'Insecta', 'class', '', '', '');
    INSERT INTO ott_taxa VALUES (7, 6, 'Apodemia mormo', 'species', '', '', '');
  `);
  return db;
}

test('animalSubcategory separates vertebrates from invertebrates by ancestry', () => {
  const db = ott();
  assert.equal(animalSubcategory(db, 4), 'vertebrate', 'a bird is not an invertebrate');
  assert.equal(animalSubcategory(db, 7), 'invertebrate');
  assert.equal(animalSubcategory(db, 10), 'invertebrate', 'a tunicate is a chordate but not a vertebrate');
});

test('a blank ours is a FILL, and an animal fill resolves the vertebrate split', () => {
  const db = ott();
  assert.deepEqual(classifyKingdomDelta(db, { ours: 'other', ottKingdom: 'invertebrate', ottId: 4 }),
    { verdict: 'fill', value: 'vertebrate' });
  assert.deepEqual(classifyKingdomDelta(db, { ours: 'other', ottKingdom: 'invertebrate', ottId: 7 }),
    { verdict: 'fill', value: 'invertebrate' });
  assert.deepEqual(classifyKingdomDelta(db, { ours: null, ottKingdom: 'fungi', ottId: 7 }),
    { verdict: 'fill', value: 'fungi' });
});

test('vertebrate and invertebrate both AGREE with an OTT animal verdict', () => {
  const db = ott();
  // OTT_KINGDOM_MAP collapses Metazoa to 'invertebrate'; a stored 'vertebrate'
  // is not a contradiction of that, it is a finer statement of the same fact.
  assert.equal(classifyKingdomDelta(db, { ours: 'vertebrate', ottKingdom: 'invertebrate', ottId: 4 }).verdict, 'agree');
  assert.equal(classifyKingdomDelta(db, { ours: 'invertebrate', ottKingdom: 'invertebrate', ottId: 7 }).verdict, 'agree');
});

test('a real disagreement is a CONTRADICTION and is never auto-applied', () => {
  const db = ott();
  const r = classifyKingdomDelta(db, { ours: 'plantae', ottKingdom: 'fungi', ottId: 7 });
  assert.equal(r.verdict, 'contradiction');
  assert.equal(r.value, 'fungi', 'the proposal is carried, but the caller must not apply it unreviewed');
});

test('no OTT kingdom yields no verdict', () => {
  assert.equal(classifyKingdomDelta(ott(), { ours: 'plantae', ottKingdom: null, ottId: 7 }).verdict, 'agree');
});
