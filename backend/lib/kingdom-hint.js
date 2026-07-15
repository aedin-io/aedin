'use strict';

/**
 * kingdom-hint.js — derive a kingdom-GROUP hint for an entity from LOCAL evidence
 * that does NOT depend on the (possibly NULL/corrupt) taxonomy columns. The hint
 * feeds lib/gbif-resolve.js's collision guard: it confirms a clean GBIF match and,
 * crucially, forces an ABSTAIN when GBIF resolves a name to the wrong namesake
 * kingdom (Ficus the fig → an animal Ficus).
 *
 * Returns one of: 'microbe' | 'fungi' | 'plantae' | 'animal' | null.
 * Priority: curated genus name (most reliable) → plantae-only trait claim → null.
 * Genus-first so a fungal pathogen with a host-overreach plant-trait claim
 * (e.g. Erysiphe) hints 'fungi', not 'plantae'.
 */

const { BACTERIAL_GENERA, FUNGAL_GENERA } = require('./curated-genera');

const genusOf = (sci) => (sci || '').toString().trim().toLowerCase().split(/\s+/)[0];

// Abiotic non-organisms (soil nutrients, elements) that the extractor sometimes
// emits as "entities". A taxonomic resolver must NOT run them — GBIF matches the
// name to a homonymous animal/plant genus (Phosphorus → the beetle genus
// Phosphorus Erichson). Detected by a non-organism parenthetical marker or a
// bare element/nutrient name. [agroecologist round-2 condition]
const ABIOTIC_RE = /\((soil[\s-]?nutrient|nutrient|macronutrient|micronutrient|fertili[sz]er|mineral|element|abiotic)s?\)|^(phosphorus|potassium|nitrogen|calcium|magnesium|sulfur|sulphur|boron|zinc|iron|manganese|copper|molybdenum|carbon|silicon|sodium|chlorine|nickel|phosphate|nitrate|ammonium|urea|potash|lime|gypsum)\b/i;
const isAbiotic = (sci) => ABIOTIC_RE.test((sci || '').toString().trim());

// Set of entity_ids that are the subject of a plantae-ONLY trait claim — a strong
// "this is a plant" signal. Computed once (better-sqlite3 db) for batch use.
function plantTraitEntityIds(db) {
  const traitRows = db.prepare(
    `SELECT trait_name FROM traits_vocabulary WHERE applicable_bio_categories = '["plantae"]'`
  ).all();
  const traits = traitRows.map(r => r.trait_name);
  if (!traits.length) return new Set();
  const ph = traits.map(() => '?').join(',');
  const ids = db.prepare(
    `SELECT DISTINCT entity_id FROM entity_trait_claims WHERE trait_name IN (${ph})`
  ).all(...traits).map(r => r.entity_id);
  return new Set(ids);
}

// Set of entity_ids that act as / are preyed on as an ANIMAL in their claims:
// the actor in herbivory/predation/pollination, a parasitoid, or prey/pest target.
// Catches animal collectives (Coccoidea, Aphididae) that GBIF would otherwise
// resolve to a fungal/chromista homonym — the role hint then contradicts and we
// abstain. Conservative: only categories where an animal is unambiguous (object
// of herbivory = the PLANT eaten, so it is excluded).
function animalContextEntityIds(db) {
  const rows = db.prepare(`
    SELECT subject_entity_id AS id FROM claims
      WHERE interaction_category IN ('herbivory','predation','pollination','parasitism')
    UNION
    SELECT object_entity_id AS id FROM claims
      WHERE interaction_category IN ('predation','biocontrol')
  `).all();
  return new Set(rows.map(r => r.id).filter(x => x != null));
}

/** @param {{id:number, scientific_name:string}} entity */
function kingdomHint(entity, plantSet, animalSet) {
  const g = genusOf(entity.scientific_name);
  if (BACTERIAL_GENERA.has(g)) return 'microbe';
  if (FUNGAL_GENERA.has(g)) return 'fungi';
  if (plantSet && plantSet.has(entity.id)) return 'plantae';
  if (animalSet && animalSet.has(entity.id)) return 'animal';
  return null;
}

module.exports = { kingdomHint, plantTraitEntityIds, animalContextEntityIds, isAbiotic, genusOf };
