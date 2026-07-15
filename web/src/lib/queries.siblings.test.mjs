// web/src/lib/queries.siblings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getClaimSiblings } from './queries.ts';

// Reads the real local DB. Finds a literature claim that belongs to a multi-member
// source+category group and asserts getClaimSiblings rebuilds that list.
test('getClaimSiblings rebuilds a multi-partner host/pest list', () => {
  const db = new Database('../backend/globi.sqlite', { readonly: true });
  // Pick an anchor (subject) with >=4 distinct objects in one source+category.
  const anchor = db.prepare(`
    SELECT c.subject_entity_id AS sid, c.source_id AS source_id, c.interaction_category AS cat,
           c.effect_direction AS eff,
           MIN(c.id) AS claim_id, COUNT(DISTINCT c.object_entity_id) AS n
    FROM claims c
    WHERE c.review_status='ai_reviewed' AND c.source_quote IS NOT NULL AND c.source_quote!=''
      AND c.source_id IS NOT NULL AND c.interaction_category IS NOT NULL
    GROUP BY c.subject_entity_id, c.source_id, c.interaction_category, c.effect_direction
    HAVING n >= 4
    ORDER BY n DESC LIMIT 1
  `).get();
  db.close();
  assert.ok(anchor, 'expected at least one >=4-member group in the corpus');

  // getClaimSiblings uses getDb() internally; it must resolve the same local DB.
  const claim = { id: anchor.claim_id, source_id: anchor.source_id, interaction_category: anchor.cat,
    effect_direction: anchor.eff, subject_entity_id: anchor.sid, object_entity_id: null };
  const siblings = getClaimSiblings(claim);
  assert.ok(siblings.length >= 4, `expected >=4 siblings, got ${siblings.length}`);
  assert.ok(siblings.every(s => typeof s.name === 'string' && s.name.length));
});
