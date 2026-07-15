// backend/merge-entity.js
'use strict';

const { CORPUS_DB } = require('./lib/db-paths.cjs');

/**
 * Apply an approved dedup candidate: rewrite claims + entity_trait_claims +
 * entities.parent_entity_id FKs from the loser to the canonical, tombstone the
 * loser via merged_into_entity_id, mark the candidate 'merged', and record the
 * exact redirected ids in entity_dedup_log so unmergeEntity is faithful.
 * Reversible. Read paths must filter WHERE merged_into_entity_id IS NULL.
 */
async function mergeCandidate(db, candidateId, { reviewer_id } = {}) {
  const cand = await db.get(`SELECT * FROM entity_dedup_candidates WHERE id = ?`, candidateId);
  if (!cand) throw new Error(`No dedup candidate ${candidateId}`);
  let canonical_id = cand.suggested_canonical_id;
  if (canonical_id == null) throw new Error(`Candidate ${candidateId} has no suggested canonical entity; needs a human pick`);
  // merged_id is determined from the ORIGINAL suggested_canonical_id (identifies which of a/b is the loser).
  const merged_id = (cand.entity_a_id === canonical_id) ? cand.entity_b_id : cand.entity_a_id;

  // Resolve the canonical to its terminal in case it was itself merged after this
  // candidate was detected (stale-candidate race) — so the loser never points at a
  // tombstone, and no merge chain can form.
  const seenCanon = new Set([canonical_id]);
  let cRow = await db.get(`SELECT merged_into_entity_id AS mi FROM entities WHERE id = ?`, canonical_id);
  while (cRow && cRow.mi != null) {
    if (seenCanon.has(cRow.mi)) throw new Error(`cycle resolving canonical for candidate ${candidateId}`);
    seenCanon.add(cRow.mi);
    canonical_id = cRow.mi;
    cRow = await db.get(`SELECT merged_into_entity_id AS mi FROM entities WHERE id = ?`, canonical_id);
  }

  const canon = await db.get(`SELECT scientific_name FROM entities WHERE id=?`, canonical_id);
  const loser = await db.get(`SELECT scientific_name FROM entities WHERE id=?`, merged_id);

  // Capture exact ids BEFORE redirecting, per field.
  const subjIds  = (await db.all(`SELECT id FROM claims WHERE subject_entity_id=?`, merged_id)).map(r => r.id);
  const objIds   = (await db.all(`SELECT id FROM claims WHERE object_entity_id=?`, merged_id)).map(r => r.id);
  const traitIds = (await db.all(`SELECT id FROM entity_trait_claims WHERE entity_id=?`, merged_id)).map(r => r.id);
  const childIds = (await db.all(`SELECT id FROM entities WHERE parent_entity_id=?`, merged_id)).map(r => r.id);

  await db.run('BEGIN IMMEDIATE');
  try {
    const c1 = await db.run(`UPDATE claims SET subject_entity_id = ? WHERE subject_entity_id = ?`, [canonical_id, merged_id]);
    const c2 = await db.run(`UPDATE claims SET object_entity_id = ? WHERE object_entity_id = ?`, [canonical_id, merged_id]);
    const tc = await db.run(`UPDATE entity_trait_claims SET entity_id = ? WHERE entity_id = ?`, [canonical_id, merged_id]);
    await db.run(`UPDATE entities SET parent_entity_id = ? WHERE parent_entity_id = ?`, [canonical_id, merged_id]);
    await db.run(`UPDATE entities SET merged_into_entity_id = ? WHERE id = ?`, [canonical_id, merged_id]);
    // Forward any earlier loser that pointed at the now-merged entity, so chains
    // don't form (merged_into must always resolve in one hop to a live canonical).
    await db.run(`UPDATE entities SET merged_into_entity_id = ? WHERE merged_into_entity_id = ?`, [canonical_id, merged_id]);
    const claims_updated = (c1.changes || 0) + (c2.changes || 0);
    const trait_claims_updated = tc.changes || 0;
    const ins = await db.run(
      `INSERT INTO entity_dedup_log
         (candidate_id, canonical_entity_id, merged_entity_id, canonical_scientific_name,
          merged_scientific_name, match_basis, tier, redirected_claim_ids,
          redirected_trait_claim_ids, redirected_child_ids, claims_updated, trait_claims_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [candidateId, canonical_id, merged_id, canon ? canon.scientific_name : null,
       loser ? loser.scientific_name : null, cand.match_basis, cand.tier,
       JSON.stringify({ subject: subjIds, object: objIds }), JSON.stringify(traitIds),
       JSON.stringify(childIds), claims_updated, trait_claims_updated]
    );
    await db.run(
      `UPDATE entity_dedup_candidates SET status='merged', reviewed_at=datetime('now'), reviewer_id=? WHERE id=?`,
      [reviewer_id || null, candidateId]
    );
    await db.run('COMMIT');
    return { canonical_id, merged_id, claims_updated, trait_claims_updated, logId: ins.lastID };
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

/** Faithful reverse of mergeCandidate by exact stored FK ids. */
async function unmergeEntity(db, logId) {
  const log = await db.get(`SELECT * FROM entity_dedup_log WHERE id=?`, logId);
  if (!log) throw new Error('unmergeEntity: log row not found');
  if (log.undone_at) throw new Error('unmergeEntity: merge already undone');
  const merged = log.merged_entity_id;
  const claimIds = JSON.parse(log.redirected_claim_ids || '{"subject":[],"object":[]}');
  const traitIds = JSON.parse(log.redirected_trait_claim_ids || '[]');
  const childIds = JSON.parse(log.redirected_child_ids || '[]');

  await db.run('BEGIN IMMEDIATE');
  try {
    if (claimIds.subject.length)
      await db.run(`UPDATE claims SET subject_entity_id=? WHERE id IN (${claimIds.subject.map(() => '?').join(',')})`, [merged, ...claimIds.subject]);
    if (claimIds.object.length)
      await db.run(`UPDATE claims SET object_entity_id=? WHERE id IN (${claimIds.object.map(() => '?').join(',')})`, [merged, ...claimIds.object]);
    if (traitIds.length)
      await db.run(`UPDATE entity_trait_claims SET entity_id=? WHERE id IN (${traitIds.map(() => '?').join(',')})`, [merged, ...traitIds]);
    if (childIds.length)
      await db.run(`UPDATE entities SET parent_entity_id=? WHERE id IN (${childIds.map(() => '?').join(',')})`, [merged, ...childIds]);
    await db.run(`UPDATE entities SET merged_into_entity_id=NULL WHERE id=?`, [merged]);
    if (log.candidate_id != null)
      await db.run(`UPDATE entity_dedup_candidates SET status='pending', reviewed_at=NULL, reviewer_id=NULL WHERE id=?`, [log.candidate_id]);
    await db.run(`UPDATE entity_dedup_log SET undone_at=datetime('now') WHERE id=?`, [logId]);
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

module.exports = { mergeCandidate, unmergeEntity };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const arg = process.argv.find(a => a.startsWith('--candidate='));
  if (!arg) { console.error('Usage: node merge-entity.js --candidate=N'); process.exit(1); }
  const candidateId = Number(arg.split('=')[1]);
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    const r = await mergeCandidate(db, candidateId, { reviewer_id: 'cli-admin' });
    console.log(`[merge-entity] merged #${r.merged_id} into #${r.canonical_id}: ${r.claims_updated} claims, ${r.trait_claims_updated} trait-claims (log #${r.logId}).`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
