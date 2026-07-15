'use strict';
/**
 * id-collision-guard.cjs — shared fail-loud id-collision guard for the additive
 * D1 patch generators (gen-claims-patch.cjs, gen-traits-patch.cjs).
 *
 * Those generators compute their delta by diffing local `ai_reviewed` rows only
 * against the live `ai_reviewed` id set. So a local `ai_reviewed` row whose id
 * collides with a live NON-`ai_reviewed` row (notably a GloBI `tier2_globi` claim,
 * 212K rows in their own id block) would slip through and `INSERT OR REPLACE`
 * would silently overwrite it. Any candidate id that already exists live is by
 * definition such a collision (a live `ai_reviewed` row would have been filtered
 * out of the delta already) — so abort rather than clobber. Id ranges are
 * currently disjoint, but that separation is incidental, not guaranteed
 * (d1-publish-auditor, 2026-07-03).
 *
 * Pure + dependency-injected: `lookupLiveIds(idsChunk) -> number[]` performs the
 * live query (via wrangler in the callers), so the collision logic here is
 * unit-testable without any network / wrangler dependency.
 */

/** Return the candidate ids that already exist live, querying in chunks. */
function findLiveIdCollisions(candidateIds, lookupLiveIds, chunkSize = 400) {
  const collisions = [];
  for (let i = 0; i < candidateIds.length; i += chunkSize) {
    collisions.push(...lookupLiveIds(candidateIds.slice(i, i + chunkSize)));
  }
  return collisions;
}

/** Throw a loud, id-listing error if any candidate id already exists live. */
function assertNoLiveIdCollision(candidateIds, lookupLiveIds, label = 'new-row', chunkSize = 400) {
  const collisions = findLiveIdCollisions(candidateIds, lookupLiveIds, chunkSize);
  if (collisions.length) {
    throw new Error(
      `ABORT: ${collisions.length} ${label} id(s) already exist live under a non-ai_reviewed ` +
      `status (id-space collision — INSERT OR REPLACE would overwrite a GloBI/other live row): ` +
      `${collisions.slice(0, 20).join(',')}${collisions.length > 20 ? '…' : ''}`
    );
  }
}

module.exports = { findLiveIdCollisions, assertNoLiveIdCollision };
