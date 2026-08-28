'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { STALE_PROVENANCE_CANDIDATES_SQL, isStaleAssignment } = require('./stale-role.js');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, primary_role TEXT,
                           slug TEXT, merged_into_entity_id INTEGER);
    CREATE TABLE role_rules (id INTEGER PRIMARY KEY, enabled INTEGER, rule_type TEXT,
                             match_value TEXT, assigned_role TEXT);
    CREATE TABLE role_assignment_log (entity_id INTEGER, rule_id INTEGER, assigned_role TEXT);

    INSERT INTO role_rules VALUES (1, 0, 'taxonomy_class', 'lepidoptera', 'pest_insect');
    INSERT INTO role_rules VALUES (2, 1, 'taxonomy_family', 'apidae',      'pollinator');

    -- still holding what the DISABLED rule wrote -> stale
    INSERT INTO entities VALUES (10, 'Stale moth', 'pest_insect', 'stale-moth', NULL);
    INSERT INTO role_assignment_log VALUES (10, 1, 'pest_insect');

    -- disabled rule, but the entity was reclassified since -> NOT stale
    INSERT INTO entities VALUES (11, 'Cleared moth', 'unclassified', 'cleared-moth', NULL);
    INSERT INTO role_assignment_log VALUES (11, 1, 'pest_insect');

    -- assigned by a LIVE rule -> NOT stale
    INSERT INTO entities VALUES (12, 'Honey bee', 'pollinator', 'honey-bee', NULL);
    INSERT INTO role_assignment_log VALUES (12, 2, 'pollinator');
  `);
  return db;
}

test('the query selects entities holding a disabled rule\'s role', () => {
  const db = fixture();
  const rows = db.prepare(`SELECT e.id ${STALE_PROVENANCE_CANDIDATES_SQL} ORDER BY e.id`).all();
  assert.deepEqual(rows.map(r => r.id), [10]);
});

test('the predicate agrees with the query on each case', () => {
  assert.equal(isStaleAssignment({ entityRole: 'pest_insect', loggedRole: 'pest_insect', ruleEnabled: 0 }), true);
  assert.equal(isStaleAssignment({ entityRole: 'unclassified', loggedRole: 'pest_insect', ruleEnabled: 0 }), false);
  assert.equal(isStaleAssignment({ entityRole: 'pollinator', loggedRole: 'pollinator', ruleEnabled: 1 }), false);
});

test('a candidate is not automatically a defect', () => {
  // The ants case: 'neutral' was written by the now-disabled hymenoptera rule,
  // but the enabled Formicidae rule produces the same value. The row is a
  // CANDIDATE (stale provenance) and NOT a defect (correct value). A verifier
  // asserting this set is empty could never pass. Only a re-evaluation that
  // CHANGES the role indicates a defect.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, primary_role TEXT,
                           slug TEXT, merged_into_entity_id INTEGER);
    CREATE TABLE role_rules (id INTEGER PRIMARY KEY, enabled INTEGER, rule_type TEXT,
                             match_value TEXT, assigned_role TEXT);
    CREATE TABLE role_assignment_log (entity_id INTEGER, rule_id INTEGER, assigned_role TEXT);
    INSERT INTO role_rules VALUES (1, 0, 'taxonomy_class',  'hymenoptera', 'neutral');
    INSERT INTO role_rules VALUES (2, 1, 'taxonomy_family', 'formicidae',  'neutral');
    INSERT INTO entities   VALUES (20, 'Formica neoclara', 'neutral', 'formica-neoclara', NULL);
    INSERT INTO role_assignment_log VALUES (20, 1, 'neutral');
  `);
  const rows = db.prepare(`SELECT e.id ${STALE_PROVENANCE_CANDIDATES_SQL}`).all();
  assert.deepEqual(rows.map(r => r.id), [20], 'selected as a candidate');
  // and the live rule would reproduce the same value, so it is not a defect
  const live = db.prepare(
    `SELECT assigned_role FROM role_rules WHERE enabled=1 AND match_value='formicidae'`).get();
  assert.equal(live.assigned_role, 'neutral');
});
