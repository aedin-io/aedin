'use strict';

/**
 * phylum-validator.js — detect corrupt entities.phylum / kingdom produced by GBIF
 * genus-name collisions (Ficus the fig → the gastropod Ficus → phylum Mollusca;
 * Cyathus the bird's-nest fungus → Arthropoda; Uredo the rust → Plantae).
 *
 * This is the DETECTOR the CLAUDE.md follow-on calls for: "validate the stored
 * phylum against a curated genus→expected-phylum map ... NOT the claim-context
 * hint." The earlier hint-driven attempt (revert of 623ff7d) failed because it let
 * claim context DRIVE the detection — herbivory-host plants got false 'animal' hints
 * and ~all 497 hits were false. Here the logic is inverted:
 *
 *   PRIMARY signal  = a curated, unambiguous-as-fungal/bacterial genus name, or a
 *                     known plant genus, sitting in a phylum of the WRONG kingdom.
 *   SECONDARY check = the entity's own context (plant-trait claim / animal-role
 *                     claim) only CONFIRMS or downgrades a candidate — it never
 *                     creates one.
 *
 * That inversion matters for collision genera (Ficus/Stelis/Chloris have real animal
 * namesakes): the name raises the candidate, and context tells us whether THIS row
 * is the plant (→ corrupt) or the legit animal (→ leave alone).
 *
 * Read-only / pure: no DB, no mutation. The report script + the heavy GBIF
 * re-resolution pass consume this.
 */

const { BACTERIAL_GENERA, FUNGAL_GENERA } = require('./curated-genera');
const { genusOf } = require('./kingdom-hint');

// Fungal genera that collide with animals/plants but aren't in curated-genera.js's
// hint list (that list is tuned for the NULL-taxonomy hint path). Additive here so
// we don't perturb kingdom-hint behavior.
const EXTRA_FUNGAL_GENERA = new Set([
  'cyathus', 'crucibulum', 'nidula', 'sphaerobolus',   // bird's-nest / cannonball fungi
  'amanita', 'boletus', 'russula', 'lactarius', 'cortinarius', 'agaricus',
  'marasmius', 'mycena', 'clitocybe', 'tricholoma', 'lepiota',
]);

// Plant genera that GBIF mis-resolves to an animal namesake (or are otherwise
// unambiguous-enough as plants to raise a candidate; the context check filters the
// collision rows). Seeded from the documented Pass-13 cases + common crops/trees.
const PLANT_GENERA = new Set([
  'ficus', 'dacrydium', 'chloris', 'stelis', 'lycopersicon', 'solanum', 'prunus',
  'quercus', 'acacia', 'eucalyptus', 'citrus', 'vitis', 'oryza', 'triticum', 'zea',
  'glycine', 'phaseolus', 'brassica', 'allium', 'capsicum', 'cucumis', 'cucurbita',
  'mangifera', 'musa', 'carica', 'persea', 'coffea', 'theobroma', 'pinus', 'abies',
  'picea', 'populus', 'salix', 'acer', 'betula', 'fraxinus', 'ulmus', 'rosa',
]);

// Phylum (lowercased) → kingdom group. Only the groups we need to discriminate.
const ANIMAL_PHYLA = new Set([
  'arthropoda', 'mollusca', 'chordata', 'annelida', 'nematoda', 'nematomorpha',
  'cnidaria', 'echinodermata', 'porifera', 'platyhelminthes', 'rotifera', 'tardigrada',
  'bryozoa', 'brachiopoda', 'nemertea', 'acanthocephala', 'ctenophora', 'onychophora',
  'sipuncula', 'gastrotricha', 'kinorhyncha', 'priapulida', 'hemichordata',
  'chaetognatha', 'entoprocta', 'placozoa', 'phoronida', 'xenacoelomorpha',
]);
const PLANT_PHYLA = new Set([
  'tracheophyta', 'magnoliophyta', 'bryophyta', 'marchantiophyta', 'anthocerotophyta',
  'pinophyta', 'cycadophyta', 'ginkgophyta', 'gnetophyta', 'lycopodiophyta',
  'polypodiophyta', 'pteridophyta', 'charophyta', 'chlorophyta', 'rhodophyta',
  'streptophyta', 'spermatophyta',
]);
const FUNGAL_PHYLA = new Set([
  'ascomycota', 'basidiomycota', 'mucoromycota', 'zygomycota', 'chytridiomycota',
  'glomeromycota', 'blastocladiomycota', 'microsporidia', 'entomophthoromycota',
  'kickxellomycota', 'olpidiomycota',
]);
const BACTERIAL_PHYLA = new Set([
  'proteobacteria', 'pseudomonadota', 'firmicutes', 'bacillota', 'actinobacteria',
  'actinomycetota', 'cyanobacteria', 'bacteroidetes', 'bacteroidota', 'spirochaetes',
  'tenericutes', 'chlamydiae', 'acidobacteria', 'verrucomicrobia',
]);

/** Expected kingdom group from a genus name, or null if the genus isn't curated. */
function expectedKingdomForGenus(scientificOrGenus) {
  const g = genusOf(scientificOrGenus);
  if (!g) return null;
  if (BACTERIAL_GENERA.has(g)) return 'bacteria';
  if (FUNGAL_GENERA.has(g) || EXTRA_FUNGAL_GENERA.has(g)) return 'fungi';
  if (PLANT_GENERA.has(g)) return 'plantae';
  return null;
}

/** Kingdom group of a stored phylum string, or null if unrecognized. */
function phylumKingdom(phylum) {
  const p = (phylum || '').toString().trim().toLowerCase();
  if (!p) return null;
  if (ANIMAL_PHYLA.has(p)) return 'animal';
  if (PLANT_PHYLA.has(p)) return 'plantae';
  if (FUNGAL_PHYLA.has(p)) return 'fungi';
  if (BACTERIAL_PHYLA.has(p)) return 'bacteria';
  return null;
}

/**
 * Raise a corruption candidate if the genus-expected kingdom and the stored-phylum
 * kingdom are both known and disagree. Returns null when not a candidate.
 *
 * @param {{scientific_name?:string, genus?:string, phylum?:string}} entity
 * @returns {null | {expectedKingdom:string, storedKingdom:string, genus:string}}
 */
function detectCorruptionCandidate(entity) {
  const expected = expectedKingdomForGenus(entity.scientific_name || entity.genus);
  if (!expected) return null;
  const stored = phylumKingdom(entity.phylum);
  if (!stored) return null;
  if (expected === stored) return null;
  return { expectedKingdom: expected, storedKingdom: stored, genus: genusOf(entity.scientific_name || entity.genus) };
}

module.exports = {
  expectedKingdomForGenus,
  phylumKingdom,
  detectCorruptionCandidate,
  PLANT_GENERA,
  EXTRA_FUNGAL_GENERA,
  ANIMAL_PHYLA,
  PLANT_PHYLA,
  FUNGAL_PHYLA,
  BACTERIAL_PHYLA,
};
