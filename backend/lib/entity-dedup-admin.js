// backend/lib/entity-dedup-admin.js
'use strict';
// Query/action functions for the entity-dedup admin tab. Thin server.js routes
// wrap these. Reuses the reversible merge rail.
const { mergeCandidate } = require('../merge-entity');

/**
 * The human-review queue: pending candidates that EITHER have an uncertain /
 * below-threshold-same verdict, OR are tier 'domain' with no decisive verdict.
 * Joins the latest verdict for display.
 */
async function getReviewQueue(db, confThreshold = 0.8) {
  return db.all(`
    SELECT c.id AS candidate_id, c.entity_a_id AS a_id, ea.scientific_name AS a_name,
           c.entity_b_id AS b_id, eb.scientific_name AS b_name, c.tier, c.suggested_canonical_id,
           v.critic_name AS critic, v.verdict, v.confidence, v.reasoning
      FROM entity_dedup_candidates c
      JOIN entities ea ON ea.id = c.entity_a_id
      JOIN entities eb ON eb.id = c.entity_b_id
      LEFT JOIN entity_dedup_verdicts v ON v.candidate_id = c.id
     WHERE c.status='pending'
       AND ( v.verdict='uncertain'
          OR (v.verdict='same' AND COALESCE(v.confidence,0) < ?)
          OR (c.tier='domain' AND v.id IS NULL) )
     GROUP BY c.id
     ORDER BY c.id`, [confThreshold]);
}

async function approveMerge(db, candidateId, canonicalId) {
  if (canonicalId != null) {
    await db.run(`UPDATE entity_dedup_candidates SET suggested_canonical_id=? WHERE id=?`, [canonicalId, candidateId]);
  }
  const r = await mergeCandidate(db, candidateId, { reviewer_id: 'admin' });
  return { logId: r.logId };
}

async function keepSeparate(db, candidateId) {
  await db.run(`UPDATE entity_dedup_candidates SET status='rejected', reviewed_at=datetime('now'), reviewer_id='admin' WHERE id=?`, [candidateId]);
}

async function getEntityLog(db) {
  return db.all(`SELECT * FROM entity_dedup_log ORDER BY merged_at DESC`);
}

module.exports = { getReviewQueue, approveMerge, keepSeparate, getEntityLog };
