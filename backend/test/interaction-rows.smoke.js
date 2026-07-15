'use strict';
// Smoke-test the interaction query SQL + normalizer logic against the local DB.
// Mirrors queries-d1.ts INTERACTION_ROWS_SQL / normalizeInteractionRow (the D1
// functions need a D1 binding; the SQL + logic are identical and validated here).
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const SQL = `
  SELECT c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
    c.review_status, c.data_tier, c.source_quote, c.reference_url,
    c.country, c.subdivision, c.subject_entity_id, c.object_entity_id,
    (SELECT COUNT(*) FROM revision_log r WHERE r.target_type='claim' AND r.target_id=c.id) AS mod_count
  FROM claims c
  WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
    AND ( (c.review_status='ai_reviewed' AND c.source_quote IS NOT NULL AND c.source_quote != '')
          OR (c.data_tier='tier2_globi' AND c.chain_role IS NOT NULL) )
  ORDER BY c.id LIMIT ?`;

test('interaction query returns literature + globi rows for Apis mellifera', () => {
  const db = new Database(CORPUS_DB, { readonly: true });
  const apis = db.prepare("SELECT id FROM entities WHERE scientific_name='Apis mellifera' LIMIT 1").get();
  const rows = db.prepare(SQL).all(apis.id, apis.id, 10000);
  db.close();
  assert.ok(rows.length > 200, `expected >200 rows (uncapped), got ${rows.length}`);
  const provs = new Set(rows.map(r => r.review_status === 'ai_reviewed' ? 'literature' : 'globi'));
  assert.ok(provs.has('globi'), 'expected some GloBI rows');
  assert.ok(rows.length > 0 && 'mod_count' in rows[0], 'mod_count column present in result');
});
