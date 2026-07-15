'use strict';

/**
 * agronomic-uses — controlled vocabulary for entities.agronomic_uses (set
 * by migration 040). Maps Wikidata P366 ("has use") label values to our
 * canonical tag set.
 *
 * Design principles:
 *  - Multi-valued: a single plant carries multiple tags
 *    (e.g. soybean = ["legume", "oilseed", "forage", "medicinal"]).
 *  - Priority-stable: when /crop-web buckets plants into tiers, it consults
 *    AGRONOMIC_PRIMARY first, then ornamental, then medicinal, then weed/wild.
 *  - Whitelist semantics: unknown Wikidata labels are silently dropped.
 *    Better to be conservative than to pollute the vocab with one-off noise
 *    like "tobacco use disorder" or "afforestation".
 *
 * The 17 canonical tags below cover ~99% of what Wikidata P366 sets on
 * plants. If a new tag is needed, add it here AND to WIKIDATA_LABEL_MAP.
 */

// Tags grouped by /crop-web priority tier (matches the brainstorm doc rules).
const AGRONOMIC_PRIMARY = Object.freeze([
  'cereal', 'legume', 'oilseed', 'vegetable', 'fruit', 'nut',
  'root_tuber', 'spice', 'beverage', 'sugar', 'fiber',
  'forage', 'cover_crop',
  // 'food' is a fallback bucket for plants Wikidata tags only as "food"
  // without a more specific category (e.g. Pyrus communis, Malus domestica).
  // These belong in Crop tier even if sub-grouping shows "Food (uncategorized)".
  'food',
]);

const ORNAMENTAL = 'ornamental';
const MEDICINAL = 'medicinal';

const OTHER_USES = Object.freeze([
  'timber', 'dye', 'latex',
]);

const ALL_TAGS = Object.freeze([
  ...AGRONOMIC_PRIMARY,
  ORNAMENTAL,
  MEDICINAL,
  ...OTHER_USES,
]);

// Wikidata P366 label → our canonical tag. Lowercase keys; unknown labels
// are dropped. Some Wikidata values map to two tags (e.g. "fruit vegetable"
// → vegetable, since culinary usage trumps botanical classification for
// agronomy purposes); represent that by listing the value once and resolving
// downstream.
const WIKIDATA_LABEL_MAP = Object.freeze({
  // Generic edible-crop fallback (used when Wikidata only tags "food" with
  // no more specific category — typical for European fruit trees like
  // Pyrus communis, Malus domestica when the entry is sparse).
  'food': 'food',
  'human food': 'food',
  'foodstuff': 'food',

  // Cereals
  'cereal': 'cereal',
  'rice': 'cereal',

  // Legumes
  'legume': 'legume',
  'pulse': 'legume',

  // Oilseeds
  'oilseed': 'oilseed',
  'oil crop': 'oilseed',
  'edible oil': 'oilseed',

  // Vegetables (including culinary "fruit vegetables" — tomato, cucumber, etc.)
  'vegetable': 'vegetable',
  'fruit vegetable': 'vegetable',
  'leaf vegetable': 'vegetable',
  'leafy vegetable': 'vegetable',
  'green vegetable': 'vegetable',

  // Fruits (true fruits eaten as fruit)
  'fruit': 'fruit',
  'fruit tree': 'fruit',

  // Nuts
  'nut': 'nut',
  'tree nut': 'nut',

  // Root/tuber crops
  'root vegetable': 'root_tuber',
  'tuber': 'root_tuber',
  'tuberous root': 'root_tuber',

  // Spices and herbs
  'spice': 'spice',
  'herb': 'spice',
  'culinary herb': 'spice',

  // Beverages (coffee, tea, cacao, etc.)
  'beverage': 'beverage',
  'coffee': 'beverage',
  'tea': 'beverage',
  'cocoa': 'beverage',
  'psychoactive drug': 'beverage',
  'stimulant foodstuff': 'beverage',

  // Sugar crops
  'sugar': 'sugar',
  'sweetener': 'sugar',

  // Fiber
  'fiber': 'fiber',
  'textile fiber': 'fiber',

  // Forage / fodder
  'fodder': 'forage',
  'forage': 'forage',
  'nectar source': 'forage', // beneficial-insect forage, not livestock
  'pasture': 'forage',
  'silage': 'forage',
  'animal feed': 'forage',

  // Cover crops / green manure
  'green manure': 'cover_crop',
  'cover crop': 'cover_crop',

  // Ornamental
  'ornamental plant': 'ornamental',
  'ornamental': 'ornamental',
  'garden plant': 'ornamental',
  'house plant': 'ornamental',
  'houseplant': 'ornamental',
  'cut flower': 'ornamental',
  'bedding plant': 'ornamental',

  // Medicinal
  'medicinal plant': 'medicinal',
  'medicinal herb': 'medicinal',
  'medicine': 'medicinal',
  'veterinary drug': 'medicinal',
  'traditional medicine': 'medicinal',

  // Timber / wood
  'building material': 'timber',
  'timber': 'timber',
  'wood': 'timber',
  'lumber': 'timber',

  // Dyes
  'dye': 'dye',
  'natural dye': 'dye',

  // Latex / gum
  'latex': 'latex',
  'gum': 'latex',
  'natural rubber': 'latex',
});

// Botanical family → likely agronomic use(s). Applied ONLY as a fallback
// when Wikidata has no P366 data for a given species — never overrides
// actual data. These mappings reflect dominant cultivation patterns within
// each family; rare exceptions stay un-bucketed (acceptable noise).
const FAMILY_FALLBACK = Object.freeze({
  // Fruits (the family dominantly produces edible fruit)
  Rosaceae:        ['fruit'],
  Rutaceae:        ['fruit'],
  Vitaceae:        ['fruit'],
  Anacardiaceae:   ['fruit'],
  Caricaceae:      ['fruit'],
  Musaceae:        ['fruit'],
  Bromeliaceae:    ['fruit'],
  Sapindaceae:     ['fruit'],
  Ericaceae:       ['fruit'],
  Myrtaceae:       ['fruit'],
  Punicaceae:      ['fruit'],

  // Legumes
  Fabaceae:        ['legume'],
  Leguminosae:     ['legume'],  // legacy synonym for Fabaceae

  // Cereals
  Poaceae:         ['cereal'],
  Gramineae:       ['cereal'],  // legacy synonym

  // Vegetables
  Solanaceae:      ['vegetable'],
  Cucurbitaceae:   ['vegetable'],
  Brassicaceae:    ['vegetable'],
  Cruciferae:      ['vegetable'],  // legacy synonym
  Apiaceae:        ['vegetable'],
  Umbelliferae:    ['vegetable'],  // legacy synonym
  Amaryllidaceae:  ['vegetable'],  // Allium per APG IV
  Alliaceae:       ['vegetable'],  // legacy
  Chenopodiaceae:  ['vegetable'],  // Beta, Spinacia
  Amaranthaceae:   ['vegetable'],  // post-APG includes Chenopodiaceae

  // Spices / herbs
  Lamiaceae:       ['spice'],
  Labiatae:        ['spice'],  // legacy synonym
  Lauraceae:       ['spice'],

  // Nuts
  Juglandaceae:    ['nut'],
  Fagaceae:        ['nut'],         // Castanea = chestnut; Quercus = acorn (timber too)
  Betulaceae:      ['nut'],         // Corylus = hazelnut

  // Beverage
  Theaceae:        ['beverage'],
  Rubiaceae:       ['beverage'],    // Coffea

  // Timber / forestry
  Pinaceae:        ['timber'],
  Salicaceae:      ['timber'],
  Cupressaceae:    ['timber'],

  // Forage / pollinator-cover
  Boraginaceae:    ['forage'],      // Borago officinalis; Phacelia historically here
  Hydrophyllaceae: ['forage'],      // Phacelia tanacetifolia — pollinator cover

  // Composites (mixed family — use widest applicable tag)
  Asteraceae:      ['vegetable'],   // lettuce, artichoke, sunflower (oilseed but vegetable wins as fallback)
  Compositae:      ['vegetable'],   // legacy synonym
});

function inferFromFamily(family) {
  if (!family) return [];
  return FAMILY_FALLBACK[family] || [];
}

function mapWikidataLabel(label) {
  if (!label) return null;
  return WIKIDATA_LABEL_MAP[String(label).trim().toLowerCase()] || null;
}

// Map a list of Wikidata P366 labels → deduplicated array of canonical tags.
// Returns [] for empty/no-match inputs.
function tagsFromWikidata(labels) {
  if (!labels || !labels.length) return [];
  const out = new Set();
  for (const lab of labels) {
    const tag = mapWikidataLabel(lab);
    if (tag) out.add(tag);
  }
  return [...out].sort();
}

// Effective tags for an entity: stored Wikidata tags UNION family-fallback
// (only when stored tags are empty). The stored column stays Wikidata-only;
// this function is the consumer-facing accessor.
function effectiveTags({ agronomic_uses, family }) {
  const tags = Array.isArray(agronomic_uses) ? agronomic_uses : (() => {
    try { return agronomic_uses ? JSON.parse(agronomic_uses) : []; }
    catch { return []; }
  })();
  if (tags.length > 0) return tags;
  return inferFromFamily(family);
}

// Priority bucket — matches docs/crop-web-brainstorm.md tier ordering.
// Returns one of: 'crop' / 'ornamental' / 'medicinal' / 'wild' / null.
function priorityTier({ agronomic_uses, primary_role, family }) {
  const tags = effectiveTags({ agronomic_uses, family });
  if (tags.some(t => AGRONOMIC_PRIMARY.includes(t))) return 'crop';
  if (primary_role === 'crop') return 'crop'; // legacy crops not yet tagged
  if (tags.includes(ORNAMENTAL)) return 'ornamental';
  if (tags.includes(MEDICINAL)) return 'medicinal';
  if (primary_role === 'weed' || primary_role === 'wild_plant') return 'wild';
  return null;
}

module.exports = {
  ALL_TAGS,
  AGRONOMIC_PRIMARY,
  ORNAMENTAL,
  MEDICINAL,
  OTHER_USES,
  WIKIDATA_LABEL_MAP,
  FAMILY_FALLBACK,
  mapWikidataLabel,
  tagsFromWikidata,
  inferFromFamily,
  effectiveTags,
  priorityTier,
};
