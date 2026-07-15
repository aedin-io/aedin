'use strict';

// Curated canonical field-crop list. Source-of-truth for the AgroEco concept of
// "field crop" (cereals, legumes, oilseeds, root/tuber staples, fiber crops),
// distinct from "vegetable" (which is Rubatzky-anchored).
//
// Loomis & Connor *Crop Ecology* (2003) is the conceptual reference but its
// text uses genus-only or common-name references for many crops, so a regex
// binomial extraction misses key species. Hardcoding the canonical list is
// more reliable for this scope.
//
// Coverage: ~30 species covering >90% of global field-crop area. Add additions
// here as needed (e.g. millets, regional staples, non-food field crops).
//
// Sub-categories enable later refinement (consumer queries can filter to
// cereals only, etc.) without overloading the top-level crop_type column.

// genus_species → sub-category
const CANONICAL_FIELD_CROPS_MAP = new Map([
  // Cereals
  ['triticum aestivum',     'cereal'],   // bread wheat
  ['triticum durum',        'cereal'],   // durum wheat
  ['oryza sativa',          'cereal'],   // rice
  ['zea mays',              'cereal'],   // maize/corn
  ['hordeum vulgare',       'cereal'],   // barley
  ['sorghum bicolor',       'cereal'],   // sorghum
  ['avena sativa',          'cereal'],   // oats
  ['secale cereale',        'cereal'],   // rye
  ['pennisetum glaucum',    'cereal'],   // pearl millet
  ['eleusine coracana',     'cereal'],   // finger millet
  ['panicum miliaceum',     'cereal'],   // proso millet
  ['setaria italica',       'cereal'],   // foxtail millet

  // Legumes (grain legumes; fodder legumes intentionally not included)
  ['glycine max',           'legume'],   // soybean
  ['phaseolus vulgaris',    'legume'],   // common bean
  ['cicer arietinum',       'legume'],   // chickpea
  ['lens culinaris',        'legume'],   // lentil
  ['pisum sativum',         'legume'],   // pea (also vegetable per Rubatzky — COALESCE protects)
  ['cajanus cajan',         'legume'],   // pigeon pea
  ['vicia faba',            'legume'],   // broad bean

  // Oilseeds
  ['helianthus annuus',     'oilseed'],  // sunflower
  ['brassica napus',        'oilseed'],  // rapeseed/canola
  ['brassica juncea',       'oilseed'],  // mustard (also vegetable for some cultivars)
  ['arachis hypogaea',      'oilseed'],  // peanut
  ['sesamum indicum',       'oilseed'],  // sesame
  ['linum usitatissimum',   'oilseed'],  // flax/linseed
  ['carthamus tinctorius',  'oilseed'],  // safflower
  ['ricinus communis',      'oilseed'],  // castor

  // Root / tuber staples
  ['solanum tuberosum',     'root_tuber'], // potato (also Rubatzky vegetable)
  ['manihot esculenta',     'root_tuber'], // cassava
  ['ipomoea batatas',       'root_tuber'], // sweet potato (also Rubatzky vegetable)
  ['dioscorea alata',       'root_tuber'], // greater yam
  ['tacca leontopetaloides','root_tuber'], // Polynesian arrowroot (Phase-1.5 add)
  ['colocasia esculenta',   'root_tuber'], // taro
  ['xanthosoma sagittifolium', 'root_tuber'], // tannia / cocoyam
  ['maranta arundinacea',   'root_tuber'], // arrowroot

  // Fiber + industrial
  ['gossypium hirsutum',    'fiber'],    // upland cotton
  ['gossypium barbadense',  'fiber'],    // pima cotton
  ['saccharum officinarum', 'fiber'],    // sugarcane (industrial; not strictly fiber)
  ['cannabis sativa',       'fiber'],    // hemp
]);

const CANONICAL_FIELD_CROPS = new Set(CANONICAL_FIELD_CROPS_MAP.keys());

function genusSpeciesKey(sciName) {
  if (!sciName || typeof sciName !== 'string') return null;
  const parts = sciName.toLowerCase().trim().split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]} ${parts[1]}`;
}

function isFieldCrop(sciName) {
  const key = genusSpeciesKey(sciName);
  if (!key) return false;
  return CANONICAL_FIELD_CROPS.has(key);
}

function fieldCropCategory(sciName) {
  const key = genusSpeciesKey(sciName);
  if (!key) return null;
  return CANONICAL_FIELD_CROPS_MAP.get(key) || null;
}

module.exports = { isFieldCrop, fieldCropCategory, CANONICAL_FIELD_CROPS, CANONICAL_FIELD_CROPS_MAP, genusSpeciesKey };
