'use strict';

/**
 * Single source of truth for the claims.interaction_category enum,
 * the impact_class enum, and the attractor → GloBI predicate map.
 *
 * Consumed by:
 *   - extractor.md prompt embed (via extract-source.js substitution)
 *   - promote-staged-claims.js validation
 *   - server.js / web/queries.ts response shaping
 */

const EXISTING_CATEGORIES = [
  'facilitation', 'mutualism', 'pollination', 'biocontrol',
  'herbivory', 'pest_pressure', 'pathogen_pressure', 'parasitism',
  'allelopathy', 'mycorrhizal', 'disease_vector',
  // Added 2026-05-17 (migration 044) for the GloBI semantic-remap (Phase B):
  // `predation` corrects preysOn rows mis-mapped to herbivory; `gall_formation`
  // covers gall-inducing arthropods (Cynipidae, Cecidomyiidae) on plants.
  'predation', 'gall_formation',
  // Added 2026-05-17 (migration 045) for the Phase-G cross-domain correction:
  // `seed_dispersal` (plant→frugivore mutualism, fixes sign-inverted hasVector);
  // `flower_visitor` (lower-confidence tier below pollination for vague `visits`);
  // `endophytism` (RESERVED — benign fungal hasHost, not yet populated).
  'seed_dispersal', 'flower_visitor', 'endophytism',
  // Added 2026-06-25 (migration 067): host-plant resistance — a crop/variety
  // RESISTS an attacker (the inverse of pest_pressure / pathogen_pressure).
  // disease_resistance: object is a pathogen; pest_resistance: object is an arthropod.
  'disease_resistance', 'pest_resistance',
];

const ATTRACTOR_CATEGORIES_LIST = [
  'attracts_natural_enemy',
  'nectar_provision',
  'pollen_provision',
  'provides_alternative_prey',
  'provides_refuge',
  'provides_oviposition_site',
];

const INTERACTION_CATEGORIES = new Set([...EXISTING_CATEGORIES, ...ATTRACTOR_CATEGORIES_LIST]);
const ATTRACTOR_CATEGORIES = new Set(ATTRACTOR_CATEGORIES_LIST);
const IMPACT_CLASSES = new Set(['low', 'moderate', 'high']);

const GLOBI_PREDICATE_MAP = {
  attracts_natural_enemy: 'mutualistOf',
  nectar_provision: 'visitsFlowersOf',
  pollen_provision: 'visitsFlowersOf',
  provides_alternative_prey: 'eatenBy',
  provides_refuge: 'coOccursWith',
  provides_oviposition_site: 'interactsWith',
};

function globiPredicateFor(category) {
  return GLOBI_PREDICATE_MAP[category] || null;
}

function isAttractorCategory(category) {
  return ATTRACTOR_CATEGORIES.has(category);
}

const CATEGORY_DESCRIPTIONS = {
  attracts_natural_enemy: 'Plant attracts predator/parasitoid (general).',
  nectar_provision: 'Flower feeds beneficial via nectar.',
  pollen_provision: 'Flower feeds beneficial via pollen.',
  provides_alternative_prey: 'Host species sustains predator when target pest is absent.',
  provides_refuge: 'Provides shelter/overwintering site for beneficial.',
  provides_oviposition_site: 'Provides egg-laying substrate for beneficial.',
  disease_resistance: 'Host crop/variety resists a pathogen (fungus, bacterium, virus, nematode, parasitic plant).',
  pest_resistance: 'Host crop/variety resists an arthropod pest (insect, mite).',
};

function renderInteractionVocabularyMarkdown() {
  const lines = [];
  lines.push('| interaction_category | globi_predicate (default) | description |');
  lines.push('|---|---|---|');
  for (const c of INTERACTION_CATEGORIES) {
    lines.push(`| ${c} | ${GLOBI_PREDICATE_MAP[c] || '(see extractor.md mapping table)'} | ${CATEGORY_DESCRIPTIONS[c] || ''} |`);
  }
  return lines.join('\n');
}

// When the GloBI Relations-Ontology term says the subject is a vector
// (`vectorOf`), the category MUST be `disease_vector` — never the force-fit
// `pathogen_pressure`/`pest_pressure` the extractor sometimes emits. Pure;
// returns the category unchanged in every other case. Single source of truth
// for the vector-normalization rule (used by promote-staged-claims.js).
function reconcileVectorCategory(category, globiTerm) {
  if (globiTerm === 'vectorOf' && (category === 'pathogen_pressure' || category === 'pest_pressure')) {
    return 'disease_vector';
  }
  return category;
}

module.exports = {
  INTERACTION_CATEGORIES,
  ATTRACTOR_CATEGORIES,
  IMPACT_CLASSES,
  globiPredicateFor,
  isAttractorCategory,
  renderInteractionVocabularyMarkdown,
  reconcileVectorCategory,
};
