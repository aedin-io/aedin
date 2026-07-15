'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./060_claim_coevolution_structure');

test('060 adds claims.coevolution_structure, idempotently', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE claims (id INTEGER PRIMARY KEY, interaction_category TEXT)');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(claims)').all().map(c => c.name);
  assert.ok(cols.includes('coevolution_structure'));

  // accepts the documented enum values
  db.prepare("INSERT INTO claims (id, interaction_category, coevolution_structure) VALUES (1,'pathogen_pressure','gene_for_gene')").run();
  const row = db.prepare('SELECT coevolution_structure FROM claims WHERE id=1').get();
  assert.equal(row.coevolution_structure, 'gene_for_gene');

  migrate(db); // idempotent: second run is a no-op, must not throw
  db.close();
});
