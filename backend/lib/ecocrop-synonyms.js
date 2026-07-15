'use strict';

/**
 * Shared synonym map — ECOCROP uses pre-2000 plant taxonomy, so major food
 * crops reclassified since then are stored under historical names. Entities
 * in our DB use modern (post-reclassification) names. This module bridges
 * the two by expanding ECOCROP row keys with both forms at index time.
 *
 * Keys are **historical** names (as they appear in ECOCROP), values are
 * arrays of **modern** synonyms. All names are lowercase, genus+species
 * only (no authority, no subspecies).
 *
 * Add entries as needed when new missing flagships are identified.
 */

const HISTORICAL_TO_MODERN = {
  'lycopersicon esculentum': ['solanum lycopersicum'],      // tomato
  'pennisetum glaucum':      ['cenchrus americanus'],       // pearl millet
  'pennisetum purpureum':    ['cenchrus purpureus'],        // elephant grass
  'phaseolus aureus':        ['vigna radiata'],             // mung bean
  'phaseolus mungo':         ['vigna mungo'],               // black gram
  'phaseolus angularis':     ['vigna angularis'],           // adzuki bean
  'phaseolus calcaratus':    ['vigna umbellata'],           // rice bean
  'phaseolus acutifolius':   ['phaseolus acutifolius'],     // tepary bean — stable, kept for reference
  'cajanus indicus':         ['cajanus cajan'],             // pigeon pea (synonym)
};

function normName(s) {
  return s == null ? '' : String(s).trim().toLowerCase();
}

/**
 * Given an ECOCROP SCIENTNAME (e.g. "Lycopersicon esculentum M."), return an
 * array of lowercase keys suitable for lookup against entities.scientific_name.
 * Always includes the full name + the genus+species prefix + any modern
 * synonyms for that historical name.
 */
function expandEcoCropKeys(scientName) {
  const out = new Set();
  const full = normName(scientName);
  if (!full) return [];
  out.add(full);
  const tokens = full.split(/\s+/);
  let genusSpecies = full;
  if (tokens.length >= 2) {
    genusSpecies = `${tokens[0]} ${tokens[1]}`;
    out.add(genusSpecies);
  }
  for (const modern of (HISTORICAL_TO_MODERN[genusSpecies] || [])) {
    out.add(modern);
  }
  return [...out];
}

module.exports = { HISTORICAL_TO_MODERN, normName, expandEcoCropKeys };
