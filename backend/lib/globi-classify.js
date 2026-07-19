'use strict';
/**
 * globi-classify.js — pure interaction classification, extracted from
 * load-globi-claims.js so both the all-triples loader AND the crop-anchored
 * scoped loader (load-globi-scoped.js) share one source of truth. Behaviour is
 * identical to the prior inline logic.
 */
const { remapRow } = require('./globi-interaction-remap');

// ─── Interaction Rules ──────────────────────────────────────────────────────
// Fixed rules: category is determined solely by interaction type, no bio_category needed
const FIXED_RULES = {
  // Pollination
  pollinates:                    { category: 'pollination',        effect: 'beneficial', weight:  3.0 },
  flowersVisitedBy:              { category: 'pollination',        effect: 'beneficial', weight:  3.0 },
  visitsFlowersOf:               { category: 'pollination',        effect: 'beneficial', weight:  3.0 },

  // Mutualism / symbiosis
  symbiontOf:                    { category: 'mutualism',          effect: 'beneficial', weight:  3.0 },
  mutualistOf:                   { category: 'mutualism',          effect: 'beneficial', weight:  3.0 },

  // Mycorrhizal (fungi ↔ plant root mutualism)
  hasArbuscularMycorrhizalHost:  { category: 'mycorrhizal',        effect: 'beneficial', weight:  3.0 },
  arbuscularMycorrhizalHostOf:   { category: 'mycorrhizal',        effect: 'beneficial', weight:  3.0 },
  ectomycorrhizalHostOf:         { category: 'mycorrhizal',        effect: 'beneficial', weight:  3.0 },
  hasEctomycorrhizalHost:        { category: 'mycorrhizal',        effect: 'beneficial', weight:  3.0 },

  // Facilitation / dispersal
  commensalistOf:                { category: 'facilitation',       effect: 'beneficial', weight:  1.0 },
  disperses:                     { category: 'facilitation',       effect: 'beneficial', weight:  1.5 },
  dispersedBy:                   { category: 'facilitation',       effect: 'beneficial', weight:  1.5 },
  hasDispersalVector:            { category: 'facilitation',       effect: 'beneficial', weight:  1.5 },
  createsHabitatFor:             { category: 'facilitation',       effect: 'beneficial', weight:  2.0 },
  providesNutrientsFor:          { category: 'facilitation',       effect: 'beneficial', weight:  2.0 },
  epiphyteOf:                    { category: 'facilitation',       effect: 'neutral',    weight:  0.5 },

  // Competition / allelopathy
  competitorOf:                  { category: 'competition',        effect: 'harmful',    weight: -2.0 },
  allelopathOf:                  { category: 'allelopathy',        effect: 'harmful',    weight: -2.5 },

  // Disease vectoring. NOTE: only `vectorOf` is a fixed disease-vector rule (the
  // literature convention: subject = vector). `hasVector` is NOT fixed — in the GloBI
  // dump it is overwhelmingly plant→frugivore/nectarivore seed/pollen DISPERSAL (and
  // some phoresy), not disease vectoring, so it is resolved by bio_category below.
  vectorOf:                      { category: 'disease_vector',     effect: 'harmful',    weight: -3.0 },
  hasPathogen:                   { category: 'pathogen_pressure',  effect: 'harmful',    weight: -3.0 },
  hasParasite:                   { category: 'parasitism',         effect: 'harmful',    weight: -2.5 },

  // Pest pressure (oviposition = insect choosing plant as host for larvae)
  laysEggsOn:                    { category: 'pest_pressure',      effect: 'harmful',    weight: -1.5 },
  laysEggsIn:                    { category: 'pest_pressure',      effect: 'harmful',    weight: -1.5 },
  rootparasiteOf:                { category: 'parasitism',         effect: 'harmful',    weight: -2.5 },

  // Neutral / skip (too generic or spatial-only)
  inhabits:                      { category: 'facilitation',       effect: 'neutral',    weight:  0.5 },
  adjacentTo:                    { category: 'facilitation',       effect: 'neutral',    weight:  0.0 },
  cohabitsWith:                  { category: 'facilitation',       effect: 'neutral',    weight:  0.0 },
  coOccursWith:                  { category: 'facilitation',       effect: 'neutral',    weight:  0.0 },
  ecologicallyRelatedTo:         { category: 'facilitation',       effect: 'neutral',    weight:  0.0 },
  hasHabitat:                    { category: 'facilitation',       effect: 'neutral',    weight:  0.0 },
  hasRoost:                      { category: 'facilitation',       effect: 'neutral',    weight:  0.0 },
  coRoostsWith:                  { category: 'facilitation',       effect: 'neutral',    weight:  0.0 },
};

// Variable rules: need source/target bio_category to determine meaning
const VARIABLE_TYPES = new Set([
  'eats', 'preysOn', 'kills',       // predation / herbivory / pathogen — depends on who eats whom
  'parasitoidOf',                     // biocontrol if inv→inv, data error if →plantae
  'parasiteOf',                       // biocontrol if inv→inv, pest/pathogen if →plantae
  'pathogenOf',                       // biocontrol if fungi→inv, pathogen if →plantae
  'endoparasiteOf', 'ectoparasiteOf', // biocontrol if inv→inv, pest if →plantae
  'hostOf', 'hasHost',                // pest/pathogen pressure vs facilitation
  'hasVector',                        // dispersal (plant→frugivore) vs disease_vector (pathogen→arthropod)
  'visits',                           // pollination if animal→plant
  'interactsWith',                    // generic co-observation — resolve by bio_category
]);
const ANIMAL_CATEGORIES = new Set(['invertebrate', 'vertebrate']);
const PEST_CATEGORIES = new Set(['invertebrate', 'fungi', 'microbe']);
// Bee families. A bee's "host plant" (GloBI `hasHost`) is the plant it FORAGES
// on — never a pest association. Family is the fallback signal because the
// family-floor role pass left much of the corpus primary_role='unclassified',
// so a role-only guard would miss most of them.
const POLLINATOR_FAMILIES = new Set([
  'apidae', 'halictidae', 'andrenidae', 'megachilidae', 'colletidae',
  'melittidae', 'stenotritidae',
]);

const GENBANK_RE = /^[A-Z]{2}\d{6}/;
function isGarbage(name) {
  if (!name || typeof name !== 'string') return true;
  if (GENBANK_RE.test(name)) return true;
  if (!/[a-zA-Z]/.test(name)) return true;
  // Pipe-delimited specimen IDs
  if (name.includes('|')) return true;
  // Starts with lowercase (habitat descriptions)
  if (/^[a-z]/.test(name)) return true;
  // URLs
  if (name.includes('http')) return true;
  // Starts with number (common names, descriptions)
  if (/^\d/.test(name)) return true;
  // Starts with ? (unknown organisms)
  if (name.startsWith('?')) return true;
  // Very long strings (>80 chars) without taxonomic markers
  if (name.length > 80 && !/ var\. | subsp\. /.test(name)) return true;
  // Single-word names (genus-level only, no species)
  if (!name.includes(' ')) return true;
  // Indeterminate: ends with " sp." or " sp" (but not "f. sp.")
  if (/\bsp\.?$/.test(name) && !/f\. sp\./.test(name)) return true;
  // Lettered/numbered indeterminate: "sp. A", "sp 123"
  if (/\bsp\.? [A-Z0-9]/.test(name) && !/f\. sp\./.test(name) && !/ subsp\. /.test(name)) return true;
  // Regional field codes
  if (/\(Sulawesi\)/.test(name)) return true;
  // Uncertain IDs
  if (/ nr\. | nr | cf\. | cf /.test(name)) return true;
  // Quoted descriptions: "Live Oak" trees, "black earth"
  if (name.startsWith('"')) return true;
  // Ampersand-prefixed: & Arenaria, & along dam
  if (name.startsWith('&')) return true;
  // +/- substrate notes
  if (name.startsWith('+/-')) return true;
  // Starts with period, angle bracket, or apostrophe
  if (/^[.<']/.test(name)) return true;
  // Parenthesized start (habitat descriptions): (white) clay savanna
  if (name.startsWith('(')) return true;
  // Abbreviated genus: "A. scoparius" — single letter + dot + space
  if (/^[A-Z]\. /.test(name)) return true;
  return false;
}

function resolveVariable(itype, src, tgt) {
  const srcBio = (src.bio_category || '').toLowerCase();
  const tgtBio = (tgt.bio_category || '').toLowerCase();
  const srcIsAnimal = ANIMAL_CATEGORIES.has(srcBio);
  const tgtIsAnimal = ANIMAL_CATEGORIES.has(tgtBio);
  const srcIsPlant = srcBio === 'plantae';
  const tgtIsPlant = tgtBio === 'plantae';
  const srcIsPestCategory = PEST_CATEGORIES.has(srcBio);  // invertebrate, fungi, microbe
  const tgtIsPestCategory = PEST_CATEGORIES.has(tgtBio);
  const srcIsPollinator = (src.primary_role || '').toLowerCase() === 'pollinator'
    || POLLINATOR_FAMILIES.has((src.family || '').toLowerCase());

  switch (itype) {

    // ── Predation / herbivory ───────────────────────────────────────────────
    case 'eats': case 'preysOn': case 'kills':
      // Animal eating invertebrate/fungi/microbe = predation → biocontrol
      if (srcIsAnimal && tgtIsPestCategory)
        return { category: 'biocontrol', effect: 'beneficial', weight: 2.5, confidence: 'resolved',
                 path: `${srcBio} eating ${tgtBio} → predation/biocontrol` };
      // Fungi/microbe eating invertebrate = entomopathogenic → biocontrol
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 2.5, confidence: 'resolved',
                 path: `${srcBio} eating invertebrate → entomopathogenic biocontrol` };
      // Invertebrate eating plant = herbivory
      if (srcBio === 'invertebrate' && tgtIsPlant)
        return { category: 'herbivory', effect: 'harmful', weight: -2.0, confidence: 'resolved',
                 path: `invertebrate eating plant → herbivory` };
      // Vertebrate eating plant = herbivory (lower weight — some is dispersal)
      if (srcBio === 'vertebrate' && tgtIsPlant)
        return { category: 'herbivory', effect: 'harmful', weight: -1.5, confidence: 'resolved',
                 path: `vertebrate eating plant → herbivory (may include frugivory/dispersal)` };
      // Fungi/microbe eating plant = pathogen
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtIsPlant)
        return { category: 'pathogen_pressure', effect: 'harmful', weight: -3.0, confidence: 'resolved',
                 path: `${srcBio} eating plant → pathogen pressure` };
      return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'resolved',
               path: `${srcBio} eating ${tgtBio} → unresolved neutral` };

    // ── Parasitoid ──────────────────────────────────────────────────────────
    case 'parasitoidOf':
      // Parasitoid of invertebrate = biocontrol (the canonical case)
      if (tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 3.0, confidence: 'resolved',
                 path: `Parasitoid of invertebrate → biological control` };
      // "Parasitoid of plant" is a GloBI data error — treat as pest pressure
      if (tgtIsPlant)
        return { category: 'pest_pressure', effect: 'harmful', weight: -2.0, confidence: 'resolved',
                 path: `Parasitoid of plant → data error, treating as pest pressure` };
      return { category: 'parasitism', effect: 'harmful', weight: -2.0, confidence: 'resolved',
               path: `Parasitoid of ${tgtBio} → parasitism` };

    // ── Parasite ────────────────────────────────────────────────────────────
    case 'parasiteOf': case 'endoparasiteOf': case 'ectoparasiteOf':
      // Invertebrate parasitizing invertebrate = biocontrol (parasitic wasps, etc.)
      if (srcBio === 'invertebrate' && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 2.5, confidence: 'resolved',
                 path: `invertebrate parasitizing invertebrate → biocontrol` };
      // Fungi parasitizing invertebrate = entomopathogenic → biocontrol
      if (srcBio === 'fungi' && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 3.0, confidence: 'resolved',
                 path: `fungi parasitizing invertebrate → entomopathogenic biocontrol` };
      // Microbe parasitizing invertebrate = entomopathogenic → biocontrol
      if (srcBio === 'microbe' && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 3.0, confidence: 'resolved',
                 path: `microbe parasitizing invertebrate → entomopathogenic biocontrol` };
      // Invertebrate parasitizing plant = pest pressure (plant-parasitic nematodes, mites, etc.)
      if (srcBio === 'invertebrate' && tgtIsPlant)
        return { category: 'pest_pressure', effect: 'harmful', weight: -2.5, confidence: 'resolved',
                 path: `invertebrate parasitizing plant → pest pressure` };
      // Fungi/microbe parasitizing plant = pathogen pressure
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtIsPlant)
        return { category: 'pathogen_pressure', effect: 'harmful', weight: -3.0, confidence: 'resolved',
                 path: `${srcBio} parasitizing plant → pathogen pressure` };
      // Parasitic plant on plant (Cuscuta, Viscum, Striga) = parasitism
      if (srcIsPlant && tgtIsPlant)
        return { category: 'parasitism', effect: 'harmful', weight: -2.5, confidence: 'resolved',
                 path: `parasitic plant on plant → parasitism` };
      // Vertebrate parasitizing plant = pest pressure
      if (srcBio === 'vertebrate' && tgtIsPlant)
        return { category: 'pest_pressure', effect: 'harmful', weight: -2.0, confidence: 'resolved',
                 path: `vertebrate parasitizing plant → pest pressure` };
      return { category: 'parasitism', effect: 'harmful', weight: -2.0, confidence: 'resolved',
               path: `${srcBio} parasitizing ${tgtBio} → default parasitism` };

    // ── Pathogen ────────────────────────────────────────────────────────────
    case 'pathogenOf':
      // Fungi/microbe pathogen of invertebrate = entomopathogenic → biocontrol
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 3.0, confidence: 'resolved',
                 path: `${srcBio} pathogen of invertebrate → entomopathogenic biocontrol` };
      // Fungi/microbe pathogen of plant = pathogen pressure (the canonical case)
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtIsPlant)
        return { category: 'pathogen_pressure', effect: 'harmful', weight: -3.0, confidence: 'resolved',
                 path: `${srcBio} pathogen of plant → pathogen pressure` };
      // Invertebrate pathogen of plant = nematodes, etc.
      if (srcBio === 'invertebrate' && tgtIsPlant)
        return { category: 'pathogen_pressure', effect: 'harmful', weight: -2.5, confidence: 'resolved',
                 path: `invertebrate pathogen of plant → pathogen pressure (nematodes etc.)` };
      // "Plant pathogen of plant" = likely parasitic plant or misclassified fungus
      if (srcIsPlant && tgtIsPlant)
        return { category: 'parasitism', effect: 'harmful', weight: -2.0, confidence: 'resolved',
                 path: `plant "pathogen" of plant → likely parasitic plant or misclassified fungus` };
      return { category: 'pathogen_pressure', effect: 'harmful', weight: -2.0, confidence: 'resolved',
               path: `${srcBio} pathogen of ${tgtBio} → default pathogen pressure` };

    // ── Host relationships ──────────────────────────────────────────────────
    case 'hostOf':
      // Plant hosting animal = facilitation (insect habitat)
      if (srcIsPlant && tgtIsAnimal)
        return { category: 'facilitation', effect: 'beneficial', weight: 1.0, confidence: 'resolved',
                 path: `Plant hosting ${tgtBio} → facilitation` };
      // Plant hosting fungi/microbe = pathogen pressure
      if (srcIsPlant && (tgtBio === 'fungi' || tgtBio === 'microbe'))
        return { category: 'pathogen_pressure', effect: 'harmful', weight: -3.0, confidence: 'resolved',
                 path: `Plant hosting ${tgtBio} → pathogen pressure` };
      return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'resolved',
               path: `${srcBio} hosting ${tgtBio} → neutral` };

    case 'hasHost':
      // A POLLINATOR's "host plant" is its FORAGE plant — GloBI uses `hasHost`
      // broadly, so this MUST be checked before the generic invertebrate rule
      // below, which would otherwise brand every bee→plant record a pest
      // (the pollinator-as-pest artifact: ~410 bee claims).
      if (srcIsPollinator && tgtIsPlant)
        return { category: 'pollination', effect: 'beneficial', weight: 2.0, confidence: 'resolved',
                 path: `pollinator has host plant → pollination/foraging` };
      // Fungi/microbe has host plant = pathogen pressure
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtIsPlant)
        return { category: 'pathogen_pressure', effect: 'harmful', weight: -3.0, confidence: 'resolved',
                 path: `${srcBio} has host plant → pathogen pressure` };
      // Invertebrate has host plant = pest pressure
      if (srcBio === 'invertebrate' && tgtIsPlant)
        return { category: 'pest_pressure', effect: 'harmful', weight: -2.5, confidence: 'resolved',
                 path: `invertebrate has host plant → pest pressure` };
      // Animal has host animal = parasitism
      if (srcIsAnimal && tgtIsAnimal)
        return { category: 'parasitism', effect: 'harmful', weight: -2.0, confidence: 'resolved',
                 path: `${srcBio} has host ${tgtBio} → parasitism` };
      return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'resolved',
               path: `${srcBio} has host ${tgtBio} → neutral` };

    // ── Visits ──────────────────────────────────────────────────────────────
    case 'visits':
      // Animal visiting plant = pollination/foraging (beneficial)
      if (srcIsAnimal && tgtIsPlant)
        return { category: 'pollination', effect: 'beneficial', weight: 2.0, confidence: 'resolved',
                 path: `${srcBio} visiting plant → pollination/foraging` };
      return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'resolved',
               path: `${srcBio} visiting ${tgtBio} → neutral` };

    // ── Generic "interactsWith" ────────────────────────────────────────────
    // GloBI catch-all: organisms observed together. Resolve by bio_category.
    // Lower weights than explicit interaction types (reduced confidence).
    case 'interactsWith':
      // Invertebrate ↔ plant = most likely flower visiting / foraging
      if (srcBio === 'invertebrate' && tgtIsPlant)
        return { category: 'pollination', effect: 'beneficial', weight: 1.0, confidence: 'inferred',
                 path: `invertebrate interactsWith plant → inferred pollination/foraging` };
      if (srcIsPlant && tgtBio === 'invertebrate')
        return { category: 'pollination', effect: 'beneficial', weight: 1.0, confidence: 'inferred',
                 path: `plant interactsWith invertebrate → inferred pollination/foraging` };
      // Vertebrate ↔ plant = foraging / seed dispersal
      if (srcBio === 'vertebrate' && tgtIsPlant)
        return { category: 'facilitation', effect: 'beneficial', weight: 0.5, confidence: 'inferred',
                 path: `vertebrate interactsWith plant → inferred foraging/dispersal` };
      if (srcIsPlant && tgtBio === 'vertebrate')
        return { category: 'facilitation', effect: 'beneficial', weight: 0.5, confidence: 'inferred',
                 path: `plant interactsWith vertebrate → inferred foraging/dispersal` };
      // Fungi/microbe ↔ plant = ambiguous (pathogen or mutualist), skip
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtIsPlant)
        return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'inferred',
                 path: `${srcBio} interactsWith plant → ambiguous (pathogen or mutualist)` };
      if (srcIsPlant && (tgtBio === 'fungi' || tgtBio === 'microbe'))
        return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'inferred',
                 path: `plant interactsWith ${tgtBio} → ambiguous (pathogen or mutualist)` };
      // Animal ↔ animal = ambiguous (predation or co-occurrence), skip
      if (srcIsAnimal && tgtIsAnimal)
        return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'inferred',
                 path: `${srcBio} interactsWith ${tgtBio} → ambiguous animal interaction` };
      // Everything else = neutral
      return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'inferred',
               path: `${srcBio} interactsWith ${tgtBio} → unresolved neutral` };

    // ── hasVector ───────────────────────────────────────────────────────────
    // GloBI "X hasVector Y" = X is transmitted/dispersed BY Y. In our dump this is
    // overwhelmingly plant→frugivore/nectarivore seed/pollen DISPERSAL (bats, birds,
    // ants/myrmecochory) — NOT disease vectoring. Only a pathogen source is a true
    // disease vector. (The old FIXED_RULE→disease_vector mislabeled dispersers.)
    case 'hasVector':
      if (srcIsPlant && tgtIsAnimal)
        return { category: 'seed_dispersal', effect: 'beneficial', weight: 1.5, confidence: 'resolved',
                 path: `plant hasVector ${tgtBio} → seed/pollen dispersal by frugivore/nectarivore (not disease)` };
      if ((srcBio === 'microbe' || srcBio === 'fungi') && tgtIsAnimal)
        return { category: 'disease_vector', effect: 'harmful', weight: -3.0, confidence: 'resolved',
                 path: `${srcBio} hasVector ${tgtBio} → disease vector (pathogen transmitted by arthropod)` };
      return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'resolved',
               path: `${srcBio} hasVector ${tgtBio} → unresolved (phoresy/commensal) — neutral` };

    default:
      return { category: 'facilitation', effect: 'neutral', weight: 0, confidence: 'resolved',
               path: `No resolution logic for ${itype}` };
  }
}

function assignMechanism(itype, effect, category) {
  if (category === 'pathogen_pressure' || itype === 'pathogenOf' || itype === 'hasPathogen')
    return 'pathogen_sharing';
  if (category === 'disease_vector')
    return 'disease_vector_bridge';
  if (category === 'biocontrol')
    return 'biological_control';
  if (category === 'pollination')
    return 'pollination_mutualism';
  if (category === 'mycorrhizal')
    return 'mycorrhizal_mutualism';
  if (category === 'allelopathy')
    return 'allelopathy';
  if (effect === 'harmful')
    return 'pest_harboring';
  return 'facilitation';
}

function assignSeverity(mechanism, weight) {
  if (mechanism === 'pathogen_sharing' || mechanism === 'disease_vector_bridge')
    return 'threshold';
  if (mechanism === 'pest_harboring' && weight <= -2.5)
    return 'threshold';
  return 'weighted';
}

/**
 * Classify one (src entity, tgt entity, interaction-type) triple.
 * Returns null when the edge is neutral/zero-weight (skip), else the resolved
 * claim fields. src/tgt are entity rows ({id, scientific_name, bio_category, family}).
 */
function classifyTriple(src, tgt, itype) {
  let category, effect, weight, valenceConf, resPath;
  const fixedRule = FIXED_RULES[itype];
  if (fixedRule) {
    category = fixedRule.category; effect = fixedRule.effect; weight = fixedRule.weight;
    valenceConf = 'direct'; resPath = `Fixed: ${itype} → ${effect}`;
  } else if (VARIABLE_TYPES.has(itype)) {
    const res = resolveVariable(itype, src, tgt);
    category = res.category; effect = res.effect; weight = res.weight;
    valenceConf = res.confidence; resPath = res.path;
  } else {
    category = 'facilitation'; effect = 'neutral'; weight = 0;
    valenceConf = 'direct'; resPath = `Unknown type: ${itype}`;
  }

  let subjectId = src.id, objectId = tgt.id, confidence = 0.5;
  const remapped = remapRow({
    subject_bio_category: src.bio_category, subject_family: src.family,
    subject_scientific_name: src.scientific_name,
    object_bio_category: tgt.bio_category, object_family: tgt.family,
    raw_interaction_type: itype, interaction_category: category, effect_direction: effect,
  });
  if (remapped) {
    if (remapped.action === 'flip') { subjectId = tgt.id; objectId = src.id; }
    category = remapped.category; effect = remapped.effect_direction;
    confidence = 0.5 * (remapped.confidence_modifier == null ? 1.0 : remapped.confidence_modifier);
  }

  if (weight === 0 && effect === 'neutral') return null; // neutral — skip

  const mechanism = assignMechanism(itype, effect, category);
  return {
    category, effect, weight, valenceConf, resolutionPath: resPath,
    subjectId, objectId, confidence, mechanism,
    severity: assignSeverity(mechanism, weight),
  };
}

module.exports = {
  classifyTriple, isGarbage,
  FIXED_RULES, VARIABLE_TYPES, ANIMAL_CATEGORIES, PEST_CATEGORIES,
  resolveVariable, assignMechanism, assignSeverity,
};
