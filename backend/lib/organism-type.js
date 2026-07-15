'use strict';

/**
 * organism-type.js
 * Derivations from the LLM-extraction `organism_type` string (e.g. 'fungus', 'insect').
 * Distinct from classify-taxon.js, which works from a GBIF-style taxon_path.
 * Used when auto-creating entities from admin extraction payloads.
 */

function bioCategoryFromOrganismType(orgType) {
  if (!orgType) return 'other';
  if (orgType === 'fungus') return 'fungi';
  if (orgType === 'bacterium' || orgType === 'virus') return 'microbe';
  if (['insect', 'mite', 'nematode', 'mollusk'].includes(orgType)) return 'invertebrate';
  return 'other';
}

function primaryRoleFromOrganismType(orgType) {
  if (!orgType) return 'crop';
  if (['fungus', 'bacterium', 'virus', 'nematode'].includes(orgType)) return 'pathogen';
  return 'pest';
}

module.exports = { bioCategoryFromOrganismType, primaryRoleFromOrganismType };
