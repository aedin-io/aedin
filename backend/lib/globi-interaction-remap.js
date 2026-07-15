'use strict';

/**
 * globi-interaction-remap.js — semantic correction for GloBI-derived claims.
 *
 * GloBI flattens biologically distinct interactions to coarse verbs. The
 * canonical bug: "Apis mellifera eats Lavandula" — the bee is eating nectar,
 * which our consumers want recorded as POLLINATION, not herbivory. The
 * Phase-A audit (docs/globi-interaction-audit.md) profiled all 2.14M
 * tier2_globi rows and found the errors concentrate in a handful of
 * (subject_family, object_bio_category, verb) patterns.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the correction rules. It is
 * consumed by:
 *   - backfill-globi-interaction-remap.js  (Phase C — corrects existing rows)
 *   - sync-globi.js                        (Phase F — corrects new rows at ingest)
 *
 * Design: code, not a DB table — the rules involve set membership
 * (POLLINATOR_FAMILIES) and subject/object flips that are awkward to express
 * as table rows. The `claim_remap_log` table (migration 044) records what
 * was actually changed, for auditability and reversibility.
 *
 * remapRow(row) returns null (no change) OR a correction instruction:
 *   { action, category, effect_direction, confidence_modifier, rule_name }
 * where action ∈ { 'recategorize', 'flip', 'unclassify' }.
 *   - recategorize: change interaction_category (+ direction, confidence)
 *   - flip: swap subject_entity_id ↔ object_entity_id, then apply the
 *           post-flip category (the rule already knows the corrected orientation)
 *   - unclassify: set interaction_category='unclassified' (dropped from public surface)
 */

// Bee + flower-fly families whose GloBI "eats <plant>" edge is UNAMBIGUOUSLY
// nectar/pollen feeding (= pollination service), never herbivory. This is safe
// because bee larvae eat pollen provisioned in the nest, not the living plant —
// so neither the adult nor the larva is a plant herbivore.
//
// NOTE — Lepidoptera are deliberately EXCLUDED from this set (see
// LEPIDOPTERA_FAMILIES below). A "moth/butterfly eats plant" GloBI edge is
// ambiguous: the adult nectar-feeds (pollination) but the larva defoliates
// (herbivory), and host-plant records in biodiversity databases are
// overwhelmingly larval. The Phase-A dry-run caught Abraxas grossulariata
// (magpie moth, a larval orchard defoliator) being mislabeled "pollination" —
// so we leave Lepidoptera "eats" edges as herbivory rather than guess.
const BEE_FLY_POLLINATORS = new Set([
  // Bees (Anthophila)
  'Apidae', 'Halictidae', 'Andrenidae', 'Megachilidae', 'Colletidae',
  'Melittidae', 'Stenotritidae',
  // Flower-visiting flies
  'Syrphidae', 'Bombyliidae',
]);

// Retained for reference / downstream use: the full adult-pollinator family
// set including Lepidoptera. NOT used by the eats→pollination rule (see above).
const POLLINATOR_FAMILIES = new Set([
  ...BEE_FLY_POLLINATORS,
  'Nymphalidae', 'Hesperiidae', 'Pieridae', 'Lycaenidae', 'Papilionidae',
  'Riodinidae', 'Hedylidae', 'Sphingidae', 'Noctuidae', 'Geometridae', 'Erebidae',
  // Anthophilous wasps — adults are documented flower visitors/pollinators
  // (entomologist Phase-E review: Scolia on Hedera is a genuine flower-visit).
  // In POLLINATOR_FAMILIES (used by the inversion-flip rule) but deliberately
  // NOT in BEE_FLY_POLLINATORS — their "eats plant" records are rarer and the
  // larvae are parasitoids, so we don't auto-convert their eats→pollination.
  'Scoliidae', 'Vespidae', 'Pompilidae', 'Sphecidae', 'Crabronidae',
]);

// Gall-inducing families. A GloBI edge to a plant is gall formation, which is
// neither pollination nor generic herbivory.
const GALL_FAMILIES = new Set([
  'Cynipidae',      // gall wasps (oaks, roses)
  'Cecidomyiidae',  // gall midges
]);

// Arbuscular-mycorrhizal fungal genera (phylum Glomeromycota). GloBI records
// these as "hasHost <plant>" which the baseline mapping sends to
// pathogen_pressure — a SIGN-INVERSION (these are obligate mutualists, not
// pathogens). Phase-G corrects them to mycorrhizal. Genus list per the
// soil-scientist + plant-pathologist Phase-G review (Brady & Weil Ch 11,
// Smith & Read). Detection is genus-of-scientific-name; a GBIF
// phylum=Glomeromycota join would be cleaner but the genus list already
// catches the full known error population (21,681 rows).
const AMF_GENERA = new Set([
  'Glomus', 'Rhizophagus', 'Funneliformis', 'Claroideoglomus', 'Septoglomus',
  'Sclerocystis', 'Gigaspora', 'Scutellospora', 'Racocetra', 'Dentiscutata',
  'Acaulospora', 'Entrophospora', 'Paraglomus', 'Diversispora', 'Ambispora',
  'Archaeospora', 'Geosiphon', 'Pacispora',
]);

function genusOf(scientificName) {
  if (!scientificName || typeof scientificName !== 'string') return null;
  return scientificName.trim().split(/\s+/)[0] || null;
}

// Verbs that, when GloBI records them with a bee/fly pollinator subject on a
// plant object, are flower-visit / nectar-feeding events → pollination.
const POLLINATOR_FEEDING_VERBS = new Set(['eats', 'visits', 'interactsWith']);

// Verbs that appear with plant-as-SUBJECT pointing at an animal object and are
// UNAMBIGUOUS inversions: plants never visit flowers or pollinate, so the
// animal must be the actor. These get flipped.
//
// Deliberately NARROW. We do NOT flip:
//   - hasDispersalVector / hasVector / createsHabitatFor / providesNutrientsFor:
//     legitimate plant-as-subject framings.
//   - preysOn / eats with plant subject: carnivorous plants (Dionaea, Drosera,
//     Nepenthes, Sarracenia, Utricularia…) genuinely prey on / eat animals.
//   - pathogenOf with plant subject: entomopathogenic algae/fungi like
//     Helicosporidium parasiticum are genuine insect pathogens.
// The Phase-A dry-run caught all three of these as false-positive flips.
const INVERSION_VERBS = new Set(['visitsFlowersOf', 'pollinates']);

/**
 * @param {object} row
 *   { subject_bio_category, subject_family, object_bio_category, object_family,
 *     raw_interaction_type, interaction_category (current), effect_direction (current) }
 * @returns {null | {action, category, effect_direction, confidence_modifier, rule_name}}
 */
function remapRow(row) {
  const sb = row.subject_bio_category || null;
  const sf = row.subject_family || null;
  const ob = row.object_bio_category || null;
  const verb = row.raw_interaction_type || '';
  const current = row.interaction_category || '';
  const subjGenus = genusOf(row.subject_scientific_name);

  // ── Rule 1: bee/fly pollinator → plant, feeding verb → pollination ─────────
  // The headline fix. Catches "Apidae eats Asteraceae" (currently herbivory).
  // Restricted to bee/fly families (NOT Lepidoptera — see BEE_FLY_POLLINATORS
  // note). Only fires when current category is NOT already pollination (no-op).
  if (sb === 'invertebrate' && BEE_FLY_POLLINATORS.has(sf) && ob === 'plantae'
      && POLLINATOR_FEEDING_VERBS.has(verb) && current !== 'pollination') {
    return {
      action: 'recategorize',
      category: 'pollination',
      effect_direction: 'beneficial',
      confidence_modifier: 0.85,
      rule_name: 'pollinator_feeding_to_pollination',
    };
  }

  // ── Rule 2: gall-inducing family → plant → gall_formation ──────────────────
  if (sb === 'invertebrate' && GALL_FAMILIES.has(sf) && ob === 'plantae'
      && current !== 'gall_formation') {
    return {
      action: 'recategorize',
      category: 'gall_formation',
      effect_direction: 'harmful',
      confidence_modifier: 0.9,
      rule_name: 'gall_family_to_gall_formation',
    };
  }

  // ── Rule 3: plant-as-subject inversions → flip subject/object ──────────────
  // "Plantae visitsFlowersOf invertebrate" / "plantae pollinates animal": plants
  // do not visit flowers or pollinate, so the animal is the real actor. After
  // flip, set pollination when the (post-flip) subject is a known pollinator,
  // else unclassified so we don't assert a wrong category. INVERSION_VERBS is
  // deliberately narrow (no preysOn/eats/pathogenOf — those are carnivorous
  // plants and entomopathogenic algae, which are correct as plant-subject).
  if (sb === 'plantae' && (ob === 'invertebrate' || ob === 'vertebrate')
      && INVERSION_VERBS.has(verb)) {
    const postFlipSubjFamily = row.object_family || null;
    return {
      action: 'flip',
      category: POLLINATOR_FAMILIES.has(postFlipSubjFamily) ? 'pollination' : 'unclassified',
      effect_direction: POLLINATOR_FAMILIES.has(postFlipSubjFamily) ? 'beneficial' : 'neutral',
      confidence_modifier: 0.6,
      rule_name: 'flip_plant_subject_visit',
    };
  }

  // ══ Phase-G rules (cross-domain audit; docs/globi-cross-domain-audit.md) ═══

  // ── Rule 4: AMF (Glomeromycota) hasHost plant → mycorrhizal [SIGN-INVERSION]
  // ~21,681 rows where an arbuscular-mycorrhizal fungus is mislabeled a
  // pathogen. The worst error type — a mutualist recorded as harm.
  if (sb === 'fungi' && verb === 'hasHost' && current === 'pathogen_pressure'
      && AMF_GENERA.has(subjGenus)) {
    return {
      action: 'recategorize',
      category: 'mycorrhizal',
      effect_direction: 'beneficial',
      confidence_modifier: 0.9,
      rule_name: 'amf_haspathogen_to_mycorrhizal',
    };
  }

  // ── Rule 5: plant hasVector vertebrate → seed_dispersal [SIGN-INVERSION] ────
  // ~3,217 rows where fruit bats / frugivorous birds dispersing seeds are
  // mislabeled disease_vector. Plant-subject framing is correct (plant HAS the
  // dispersal vector) — recategorize only, no flip. Restricted to vertebrate
  // objects; invertebrate hasVector (aphid→virus) stays disease_vector.
  if (sb === 'plantae' && ob === 'vertebrate' && verb === 'hasVector'
      && current === 'disease_vector') {
    return {
      action: 'recategorize',
      category: 'seed_dispersal',
      effect_direction: 'beneficial',
      confidence_modifier: 0.85,
      rule_name: 'frugivore_hasvector_to_seed_dispersal',
    };
  }

  // ── Rule 6: microbe/fungi "pollination" → unclassified [IMPOSSIBLE] ─────────
  // ~589 rows. Microbes and fungi do not pollinate; these are GloBI noise.
  if ((sb === 'fungi' || sb === 'microbe') && current === 'pollination') {
    return {
      action: 'recategorize',
      category: 'unclassified',
      effect_direction: 'neutral',
      confidence_modifier: 0.5,
      rule_name: 'microbe_fungi_pollination_to_unclassified',
    };
  }

  // ── Rule 7: bee/fly mutualistOf plant → pollination ────────────────────────
  // ~7,453 rows where a bee/fly flower-visit is recorded as generic mutualism;
  // pollination is the precise category.
  if (sb === 'invertebrate' && BEE_FLY_POLLINATORS.has(sf)
      && verb === 'mutualistOf' && ob === 'plantae' && current === 'mutualism') {
    return {
      action: 'recategorize',
      category: 'pollination',
      effect_direction: 'beneficial',
      confidence_modifier: 0.8,
      rule_name: 'bee_mutualist_to_pollination',
    };
  }

  // ── Rule 8: non-pollinator "visits" plant → flower_visitor [OVER-CREDIT] ────
  // ~106K rows. The baseline mapping sends every invertebrate "visits plant" to
  // pollination, laundering nectar-thieves/florivores/incidental visitors into
  // the beneficial-pollination network. Demote to flower_visitor UNLESS the
  // subject is a recognized pollinator family (broad POLLINATOR_FAMILIES set —
  // includes Lepidoptera + anthophilous wasps, which DO pollinate). The verb
  // `visits` is vaguer than `visitsFlowersOf`, so non-pollinators get the
  // lower-confidence tier rather than an asserted pollination service.
  if (sb === 'invertebrate' && verb === 'visits' && current === 'pollination'
      && !POLLINATOR_FAMILIES.has(sf)) {
    return {
      action: 'recategorize',
      category: 'flower_visitor',
      effect_direction: 'beneficial',
      confidence_modifier: 0.4,
      rule_name: 'nonpollinator_visits_to_flower_visitor',
    };
  }

  // ── No rule matched ────────────────────────────────────────────────────────
  return null;
}

const LEPIDOPTERA_FAMILIES = new Set([
  'Nymphalidae', 'Hesperiidae', 'Pieridae', 'Lycaenidae', 'Papilionidae',
  'Riodinidae', 'Hedylidae', 'Sphingidae', 'Noctuidae', 'Geometridae', 'Erebidae',
]);
function isLepidopteraFamily(family) {
  return LEPIDOPTERA_FAMILIES.has(family);
}

module.exports = {
  remapRow,
  BEE_FLY_POLLINATORS,
  POLLINATOR_FAMILIES,
  GALL_FAMILIES,
  AMF_GENERA,
  POLLINATOR_FEEDING_VERBS,
  INVERSION_VERBS,
  isLepidopteraFamily,
  genusOf,
};
