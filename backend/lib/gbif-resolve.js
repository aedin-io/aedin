'use strict';

/**
 * gbif-resolve.js — hardened GBIF taxonomy resolver with disambiguate-or-abstain.
 *
 * The ingestion data flow (promote-staged-claims.js::resolveEntityForClaim)
 * creates literature entities with NULL taxonomy + a *guessed* bio_category and
 * never GBIF-resolves them. This lib resolves one scientific name against GBIF
 * and returns authoritative kingdom/phylum/class/order + a bio_category derived
 * from the kingdom — but ONLY when it is confident. On a genus-name collision
 * (Ficus the fig vs. a Ficus mollusc namesake) it ABSTAINS rather than writing
 * a guess: a NULL taxonomy is safe; a wrong one re-corrupts routing + serving.
 *
 * Shared by the backfill (resolve-ingested-taxonomy.js) and — going forward —
 * the ingestion-flow hook, so both resolve identically.
 *
 * No API key needed. Caller is responsible for throttling between calls.
 */

const { bioCategoryFromLineage } = require('./bio-category-from-lineage');

const GBIF_API = 'https://api.gbif.org/v1';
const DEFAULT_CONFIDENCE_FLOOR = 90;

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Raw verbose GBIF match (exposed for testing / reuse).
async function gbifMatch(scientificName) {
  const url = `${GBIF_API}/species/match?name=${encodeURIComponent(scientificName)}&verbose=true&strict=false`;
  return fetchJson(url);
}

// Top-level grouping so a hint contradiction is detected across the plant /
// fungus / microbe / animal divide (invertebrate + vertebrate collapse to animal).
function topGroup(bio) {
  if (bio === 'invertebrate' || bio === 'vertebrate') return 'animal';
  return bio; // plantae | fungi | microbe | other
}

/**
 * Resolve one name. `kingdomHint` is an optional bio_category-style value
 * ('plantae'|'fungi'|'microbe'|'animal'|null) derived from local evidence
 * (trait claims, role, curated genus) that breaks collisions.
 *
 * Returns:
 *   { accept: true,  taxonomy: {kingdom,phylum,taxon_class,taxon_order,family,genus},
 *     gbif_key, bio_category, matchType, confidence }
 *   { accept: false, reason: 'no_match'|'hint_contradiction'|'low_confidence', ... }
 */
// Pure decision logic (no network) — testable in isolation.
function decideFromMatch(match, kingdomHint = null, opts = {}) {
  const floor = opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;

  if (!match || match.matchType === 'NONE' || !match.usageKey || !match.kingdom) {
    return { accept: false, reason: 'no_match', matchType: match?.matchType ?? 'ERROR', confidence: match?.confidence ?? 0 };
  }

  const matchBio = bioCategoryFromLineage(match);
  const confidence = match.confidence ?? 0;

  // Unmappable kingdom (incertae sedis, etc.) → bio_category 'other', which is
  // not informative and would DOWNGRADE a known value (a virus tagged 'microbe'
  // must not become 'other'). Abstain rather than write a non-classification.
  if (matchBio === 'other') {
    return { accept: false, reason: 'unmappable_kingdom', matchType: match.matchType, confidence, gbifKingdom: match.kingdom };
  }

  // Collision guard: a confident GBIF kingdom that contradicts the local hint is
  // exactly the namesake-collision signature → abstain, never overwrite.
  if (kingdomHint && topGroup(matchBio) !== topGroup(kingdomHint) && topGroup(matchBio) !== 'other') {
    return { accept: false, reason: 'hint_contradiction', matchType: match.matchType, confidence,
             matchBio, kingdomHint, gbifKingdom: match.kingdom };
  }

  // No hint to confirm + a weak/fuzzy match → abstain rather than guess.
  if (!kingdomHint && (confidence < floor || match.matchType === 'FUZZY')) {
    return { accept: false, reason: 'low_confidence', matchType: match.matchType, confidence };
  }

  return {
    accept: true,
    matchType: match.matchType,
    confidence,
    gbif_key: match.usageKey,
    taxonomy: {
      kingdom: match.kingdom || null,
      phylum: match.phylum || null,
      taxon_class: match.class || null,
      taxon_order: match.order || null,
      family: match.family || null,
      genus: match.genus || null,
    },
    bio_category: matchBio,
  };
}

async function resolveTaxonomy(scientificName, kingdomHint = null, opts = {}) {
  const match = await gbifMatch(scientificName);
  return decideFromMatch(match, kingdomHint, opts);
}

module.exports = { resolveTaxonomy, decideFromMatch, gbifMatch, topGroup, GBIF_API };
