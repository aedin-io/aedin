'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const SQL = `
  SELECT r.target_id AS claim_id, c.review_status, c.data_tier, c.chain_role
  FROM revision_log r JOIN claims c ON c.id = r.target_id
  WHERE r.target_type='claim' AND (c.subject_entity_id = ? OR c.object_entity_id = ?)`;

test('Apis mellifera has claim modifications, all quarantined (removed)', () => {
  const db = new Database(CORPUS_DB, { readonly: true });
  const apis = db.prepare("SELECT id FROM entities WHERE scientific_name='Apis mellifera' LIMIT 1").get();
  const rows = db.prepare(SQL).all(apis.id, apis.id);
  db.close();
  const ids = new Set(rows.map(r => r.claim_id));
  const removed = new Set(rows.filter(r => !(r.review_status === 'ai_reviewed' || (r.data_tier === 'tier2_globi' && r.chain_role != null))).map(r => r.claim_id));
  assert.ok(ids.size >= 3, `expected >=3 modified claims, got ${ids.size}`);
  assert.equal(removed.size, ids.size, 'the Apis modified claims are all quarantined/removed');
});
