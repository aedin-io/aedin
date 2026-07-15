'use strict';

// Rubatzky vegetable-species index, built from the extracted full-text of
// Rubatzky & Yamaguchi *World Vegetables* (2nd ed., 1995). Used by
// backfill-vegetable-tagging.js to assign `crop_type='vegetable'` and
// `edible=1` to plant entities whose binomial appears in the textbook.
//
// Approach: regex-extract every "Genus species" pattern from the textbook,
// build a Set keyed on lowercased "genus species" pairs, then look up entities.
// Cross-reference (entity must EXIST AND be in Rubatzky) provides safety —
// random false-positive binomial matches in the textbook prose only "tag"
// plant entities that already exist, so a stray match like "Most florida"
// would only stick if there were an entity named "Most florida" (there isn't).
//
// Note: variety and subspecies entities (e.g. "Solanum lycopersicum var.
// cerasiforme") are matched on their genus+species prefix, which is the
// correct treatment — a variety of a vegetable is still a vegetable.

const fs = require('fs');
const path = require('path');

const RUBATZKY_PATH = path.resolve(
  __dirname,
  '../../.claude/agents/agroecologist/reference/rubatzky_yamaguchi_world_vegetables_full_text.md'
);

// "Genus species" pattern: capitalized word (3-20 lowercase letters after a
// capital) followed by a single space, then a fully-lowercase word (3-20 chars).
// We require the species word to be at a word boundary on both ends.
const BINOMIAL_RE = /\b([A-Z][a-z]{2,20}) ([a-z]{3,20})\b/g;

// Taxonomic-revision synonyms: Rubatzky (1995) uses pre-revision binomials for
// some species. When Rubatzky's name appears in the text, we ALSO add the
// modern accepted binomial to the index so `isVegetable()` works against
// current `entities.scientific_name` values.
//
// Format: lowercased "rubatzky_name" → lowercased "modern_name".
// Add entries here as taxonomic revisions surface during backfill review.
const SYNONYMS = {
  // Tomato: reclassified from Lycopersicon to Solanum (Spooner et al. 2005).
  'lycopersicon esculentum': 'solanum lycopersicum',
  // Add more as discovered.
};

// HARD-OVERRIDE: species that appear in Rubatzky but are NOT culinary vegetables
// per Rubatzky's own framing. Surfaced by the agroecologist gate (Phase 1.5):
// Rubatzky organizes content into chapters; binomial extraction picks up names
// from non-vegetable chapters (starchy roots/tubers, condiments, etc.). Without
// chapter-aware extraction, override here.
const HARD_NOT_VEGETABLE = new Set([
  'tacca leontopetaloides',  // Polynesian arrowroot — starchy tuber, not a vegetable
  // Add more as surface.
]);

// POLYMORPHIC species — the bare binomial is too vague to tag as 'vegetable'
// because the species has cultivars used in non-vegetable contexts:
//   - Zea mays: sweet corn (vegetable) vs dent/flint/popcorn (cereal)
//   - Brassica oleracea: kale/cauliflower/kohlrabi/broccoli/cabbage (vegetable)
//                        vs forage kale (fodder)
//   - Cucurbita pepo: zucchini/summer squash (vegetable) vs ornamental gourd
// Strategy: bare 2-word binomials of these species DON'T match isVegetable.
// Cultivar-specified entities (3+ words, like "Zea mays 'Kiss n Tell'" or
// "Brassica oleracea var. capitata") DO match.
const POLYMORPHIC_SPECIES = new Set([
  'zea mays',
  'brassica oleracea',
  'cucurbita pepo',
  'beta vulgaris',  // sugar beet vs Swiss chard vs beetroot
]);

let _cachedSet = null;

function _buildIndex() {
  const text = fs.readFileSync(RUBATZKY_PATH, 'utf8');
  const set = new Set();
  let m;
  while ((m = BINOMIAL_RE.exec(text)) !== null) {
    const key = `${m[1].toLowerCase()} ${m[2].toLowerCase()}`;
    set.add(key);
    if (SYNONYMS[key]) set.add(SYNONYMS[key]);
  }
  return set;
}

function _resetCache() { _cachedSet = null; }  // for tests

function getIndex() {
  if (!_cachedSet) _cachedSet = _buildIndex();
  return _cachedSet;
}

function genusSpeciesKey(sciName) {
  if (!sciName || typeof sciName !== 'string') return null;
  const parts = sciName.toLowerCase().trim().split(/\s+/);
  if (parts.length < 2) return null;
  if (!parts[0] || !parts[1]) return null;
  return `${parts[0]} ${parts[1]}`;
}

function isVegetable(sciName) {
  const key = genusSpeciesKey(sciName);
  if (!key) return false;

  // Hard-override: known false positives from Rubatzky chapter-context drift
  if (HARD_NOT_VEGETABLE.has(key)) return false;

  // Polymorphic species: bare 2-word binomial is too vague — require an
  // explicit USE-FORM designator (cultivar in quotes, var. <name>, convar.
  // <name>). Bare nominate subspecies (e.g. "Zea mays subsp. mays") is
  // explicitly NOT enough — the nominate subspecies covers all subdomestications
  // (dent + flint + popcorn + sweet corn) so it remains polymorphic.
  if (POLYMORPHIC_SPECIES.has(key)) {
    const trimmed = (sciName || '').trim();
    const parts = trimmed.split(/\s+/);
    // Bare 2-word binomial → polymorphic, not vegetable
    if (parts.length < 3) return false;
    // Bare nominate subspecies "Zea mays subsp. mays" — same root word repeats
    // after subsp./ssp.; still polymorphic.
    if (/\b(?:subsp\.|ssp\.)\s+(\w+)$/i.test(trimmed)) {
      const m = trimmed.match(/\b(?:subsp\.|ssp\.)\s+(\w+)$/i);
      if (m && m[1].toLowerCase() === parts[1].toLowerCase()) return false;  // nominate subsp.
    }
  }

  return getIndex().has(key);
}

module.exports = { isVegetable, genusSpeciesKey, getIndex, _resetCache, _RUBATZKY_PATH: RUBATZKY_PATH };
