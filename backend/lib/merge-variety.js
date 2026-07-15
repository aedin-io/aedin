'use strict';

// Reversible variety merge for the human-gated #2c admin. Tombstones (never
// deletes) and records the exact per-field redirected FK ids so Undo is faithful.

async function mergeVariety(db, canonicalId, mergedId) {
  const canon = await db.get(`SELECT id, variety_name, parent_entity_id FROM entities WHERE id=?`, canonicalId);
  const merged = await db.get(`SELECT id, variety_name, parent_entity_id FROM entities WHERE id=?`, mergedId);
  if (!canon || !merged) throw new Error('mergeVariety: canonical or merged entity not found');
  if (canon.parent_entity_id !== merged.parent_entity_id) throw new Error('mergeVariety: refusing cross-parent merge');

  // Capture exact ids BEFORE redirecting, per field.
  const subjIds = (await db.all(`SELECT id FROM claims WHERE subject_entity_id=?`, mergedId)).map(r => r.id);
  const objIds  = (await db.all(`SELECT id FROM claims WHERE object_entity_id=?`, mergedId)).map(r => r.id);
  const traitIds = (await db.all(`SELECT id FROM entity_trait_claims WHERE entity_id=?`, mergedId)).map(r => r.id);

  await db.run('BEGIN IMMEDIATE');
  try {
    await db.run(`UPDATE claims SET subject_entity_id=? WHERE subject_entity_id=?`, [canonicalId, mergedId]);
    await db.run(`UPDATE claims SET object_entity_id=? WHERE object_entity_id=?`, [canonicalId, mergedId]);
    await db.run(`UPDATE entity_trait_claims SET entity_id=? WHERE entity_id=?`, [canonicalId, mergedId]);
    const ins = await db.run(
      `INSERT INTO variety_dedup_log
         (canonical_entity_id, merged_entity_id, merged_variety_name, canonical_variety_name,
          parent_entity_id, levenshtein_distance, claims_updated, entity_trait_claims_updated,
          redirected_claim_ids, redirected_trait_claim_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [canonicalId, mergedId, merged.variety_name, canon.variety_name, canon.parent_entity_id,
       0, subjIds.length + objIds.length, traitIds.length,
       JSON.stringify({ subject: subjIds, object: objIds }), JSON.stringify(traitIds)]
    );
    // Tombstone the merged row; clear the flag on canonical.
    await db.run(`UPDATE entities SET merged_into_entity_id=? WHERE id=?`, [canonicalId, mergedId]);
    await db.run(`UPDATE entities SET needs_dedup=0 WHERE id=?`, [canonicalId]);
    await db.run('COMMIT');
    return ins.lastID;
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
}

async function unmergeVariety(db, logId) {
  const log = await db.get(`SELECT * FROM variety_dedup_log WHERE id=?`, logId);
  if (!log) throw new Error('unmergeVariety: log row not found');
  if (log.undone_at) throw new Error('unmergeVariety: merge already undone');
  const { canonical_entity_id: canon, merged_entity_id: merged } = log;
  const claimIds = JSON.parse(log.redirected_claim_ids || '{"subject":[],"object":[]}');
  const traitIds = JSON.parse(log.redirected_trait_claim_ids || '[]');

  await db.run('BEGIN IMMEDIATE');
  try {
    if (claimIds.subject.length) {
      await db.run(`UPDATE claims SET subject_entity_id=? WHERE id IN (${claimIds.subject.map(() => '?').join(',')})`,
        [merged, ...claimIds.subject]);
    }
    if (claimIds.object.length) {
      await db.run(`UPDATE claims SET object_entity_id=? WHERE id IN (${claimIds.object.map(() => '?').join(',')})`,
        [merged, ...claimIds.object]);
    }
    if (traitIds.length) {
      await db.run(`UPDATE entity_trait_claims SET entity_id=? WHERE id IN (${traitIds.map(() => '?').join(',')})`,
        [merged, ...traitIds]);
    }
    // Un-tombstone + re-flag the pair for re-review.
    await db.run(`UPDATE entities SET merged_into_entity_id=NULL, needs_dedup=1 WHERE id=?`, [merged]);
    await db.run(`UPDATE entities SET needs_dedup=1 WHERE id=?`, [canon]);
    await db.run(`UPDATE variety_dedup_log SET undone_at=datetime('now') WHERE id=?`, [logId]);
    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
}

const { levenshtein } = require('./levenshtein');

function pickCanonical(a, b) {
  if (a.grin_accession && !b.grin_accession) return { canon: a, merged: b };
  if (b.grin_accession && !a.grin_accession) return { canon: b, merged: a };
  if (!a.needs_dedup && b.needs_dedup) return { canon: a, merged: b };
  if (!b.needs_dedup && a.needs_dedup) return { canon: b, merged: a };
  if ((a.created_at || '') <= (b.created_at || '')) return { canon: a, merged: b };
  return { canon: b, merged: a };
}

async function computeCandidates(db, opts = {}) {
  const distCap = opts.distCap ?? 5;
  const ratioCap = opts.ratioCap ?? 0.20;
  const parents = await db.all(`
    SELECT DISTINCT parent_entity_id FROM entities
    WHERE parent_entity_id IS NOT NULL AND variety_name IS NOT NULL
      AND needs_dedup=1 AND merged_into_entity_id IS NULL`);
  const out = [];
  for (const { parent_entity_id } of parents) {
    const vs = await db.all(
      `SELECT id, variety_name, scientific_name, grin_accession, needs_dedup, created_at FROM entities
       WHERE parent_entity_id=? AND variety_name IS NOT NULL AND merged_into_entity_id IS NULL
       ORDER BY created_at, id`, [parent_entity_id]);
    const pairs = [];
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const a = vs[i], b = vs[j];
        if (!a.needs_dedup && !b.needs_dedup) continue;            // at least one flagged
        const dist = levenshtein(a.variety_name.toLowerCase(), b.variety_name.toLowerCase(), distCap);
        if (dist > distCap) continue;
        if (dist / Math.max(a.variety_name.length, b.variety_name.length, 1) > ratioCap) continue;
        if (a.grin_accession && b.grin_accession && a.grin_accession !== b.grin_accession) continue;
        const { canon } = pickCanonical(a, b);
        const aN = (await db.get(`SELECT COUNT(*) n FROM claims WHERE subject_entity_id=? OR object_entity_id=?`, [a.id, a.id])).n;
        const bN = (await db.get(`SELECT COUNT(*) n FROM claims WHERE subject_entity_id=? OR object_entity_id=?`, [b.id, b.id])).n;
        pairs.push({ a: a.id, b: b.id, aName: a.variety_name || a.scientific_name, bName: b.variety_name || b.scientific_name, levenshtein: dist, suggestedCanonicalId: canon.id, aClaimCount: aN, bClaimCount: bN });
      }
    }
    if (pairs.length) {
      const p = await db.get(`SELECT id, scientific_name FROM entities WHERE id=?`, parent_entity_id);
      out.push({ parent: { id: parent_entity_id, name: p ? p.scientific_name : String(parent_entity_id) }, pairs });
    }
  }
  return out;
}

async function keepSeparate(db, idA, idB) {
  await db.run(`UPDATE entities SET needs_dedup=0 WHERE id IN (?, ?)`, [idA, idB]);
}

module.exports = { mergeVariety, unmergeVariety, computeCandidates, keepSeparate, pickCanonical };
