'use strict';

const { inheritanceClass } = require('./trait-inheritance-class');

// All ai_reviewed trait claims for an entity (full rows).
function aiReviewedTraits(db, entityId) {
  return db.prepare(
    `SELECT * FROM entity_trait_claims WHERE entity_id=? AND review_status='ai_reviewed'`
  ).all(entityId);
}

// Merge a variety's own trait claims with its parent species' claims:
// per trait_name, the variety's claims (if any) fully override the parent's.
// Returns full entity_trait_claims rows tagged with `source` + `inherited_from_entity_id`.
// Inherited rows are re-keyed to entity_id = varietyId (they keep the parent claim's `id`;
// the D1 build re-keys the id for PK uniqueness).
function resolveVarietyTraits(db, varietyId) {
  const own = aiReviewedTraits(db, varietyId).map(r => ({
    ...r, source: 'variety_specific', inherited_from_entity_id: null,
  }));
  const ent = db.prepare('SELECT parent_entity_id, bio_category, variety_type FROM entities WHERE id=?').get(varietyId);
  const parentId = ent ? ent.parent_entity_id : null;
  if (parentId == null) return own;
  // Guard C: hybrid/morphotype inherit nothing.
  if (ent.variety_type === 'hybrid' || ent.variety_type === 'morphotype') return own;
  const parent = db.prepare('SELECT bio_category, needs_taxonomy_review FROM entities WHERE id=?').get(parentId);
  if (!parent) return own;
  // Guard A: never inherit across a kingdom boundary (corruption-amplifier mitigation).
  if (parent.bio_category !== ent.bio_category) return own;
  // Guard B: never inherit from a taxonomy-suspect parent.
  if (parent.needs_taxonomy_review) return own;
  const ownTraitNames = new Set(own.map(r => r.trait_name));
  const inherited = aiReviewedTraits(db, parentId)
    .filter(r => !ownTraitNames.has(r.trait_name))
    .filter(r => inheritanceClass(ent.bio_category, r.trait_name) === 'conserved')
    .map(r => ({ ...r, entity_id: varietyId, source: 'inherited', inherited_from_entity_id: parentId }));
  return [...own, ...inherited];
}

module.exports = { resolveVarietyTraits };
