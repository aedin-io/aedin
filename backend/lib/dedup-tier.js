'use strict';
// Pure precision classifier for entity-dedup candidates. No DB access (levenshtein
// is a pure helper). Tiers a candidate pair into auto_safe | needs_review | domain
// and picks a deterministic canonical.
// See docs/superpowers/specs/2026-06-23-entity-dedup-tiering-design.md
const { levenshtein } = require('./levenshtein');

// A genus token (1st word) one edit apart is a genus typo (`Achillea`/`Achilea`) —
// still the same taxon. Two-or-more apart is a different genus (`Andropogon` vs
// `Schizachyrium`), which the sweep can mis-pair via the stored genus column.
const GENUS_TYPO_MAX = 1;

// A standalone hybrid marker: '×', or a lone 'x' token surrounded by spaces.
const HYBRID_MARKER = /(^|\s)(×|x)(\s)/i;

// Placeholder / unresolved names that must NEVER auto-merge regardless of edit
// distance — distinct morphospecies codes can be one character apart (sp1/sp12,
// sp.A/sp.B). MORPHO_CODE matches an "sp"/"sp."(+short code) token without
// over-matching real epithets like "spinosa"/"spectabilis" (it requires the "sp"
// to be a whitespace-delimited token).
const PLACEHOLDER = /unidentified|morphospecies|incertae\s*sedis/i;
const MORPHO_CODE = /(^|\s)sp\.?\s?[a-z0-9]{0,3}(\s|$)/i;
function isPlaceholder(name) {
  const s = String(name || '');
  return PLACEHOLDER.test(s) || MORPHO_CODE.test(s);
}

function hasHybridMarker(name) {
  return HYBRID_MARKER.test(String(name || ''));
}

function tokenCount(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .filter(t => t && t !== '×' && t.toLowerCase() !== 'x')
    .length;
}

function structuralNorm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/×/g, ' ')               // drop the hybrid sign
    .replace(/(^|\s)x(\s)/g, '$1 $2') // drop a lone 'x' marker token
    .replace(/['']/g, '')             // apostrophes (curly + straight) -> nothing
    .replace(/[^a-z0-9]+/g, ' ')      // any other punctuation/junk -> space
    .trim()
    .replace(/\s+/g, ' ');
}

function pickCanonicalForDedup(a, b) {
  const aAnch = !!a.gbif_key, bAnch = !!b.gbif_key;
  if (aAnch !== bAnch) return aAnch ? a.id : b.id;                 // 1. gbif-anchored
  const aMass = (a.claim_count || 0) + (a.trait_count || 0);
  const bMass = (b.claim_count || 0) + (b.trait_count || 0);
  if (aMass !== bMass) return aMass > bMass ? a.id : b.id;         // 2. data-mass
  const aServed = a.scope_tier != null, bServed = b.scope_tier != null;
  if (aServed !== bServed) return aServed ? a.id : b.id;           // 3a. served
  if (aServed && bServed && a.scope_tier !== b.scope_tier)
    return a.scope_tier < b.scope_tier ? a.id : b.id;             // 3b. lower tier
  return a.id < b.id ? a.id : b.id;                                // 4. lower id
}

function genusToken(name) {
  return String(name || '').trim().split(/\s+/)[0].toLowerCase();
}

function tierOf(a, b, candidate) {
  const aName = a.scientific_name, bName = b.scientific_name;
  const dist = candidate.levenshtein_distance; // the sweep's epithet distance
  // 1. Token-count mismatch guard (subspecies trap) — runs first.
  if (tokenCount(aName) !== tokenCount(bName)) return 'needs_review';
  const sameNorm = structuralNorm(aName) === structuralNorm(bName);
  // 2. × marker pair (exactly one side hybrid-marked, same taxon) -> domain.
  if (sameNorm && (hasHybridMarker(aName) !== hasHybridMarker(bName))) return 'domain';
  // 3. Structural/orthographic duplicate (junk-char, punctuation variant) -> auto_safe.
  if (sameNorm) return 'auto_safe';
  // The sweep's epithet distance is UNRELIABLE for the next three classes (its
  // "epithet" is the 2nd token — a marker, a code, or the wrong word). Demote them:
  // 4a. a hybrid marker means the 2nd token may BE the marker (`Quercus × eplingii`
  //     vs `Quercus X megaleia` — distinct hybrids scored distance-1 on `×`/`X`).
  if (hasHybridMarker(aName) || hasHybridMarker(bName)) return 'needs_review';
  // 4b. placeholder / morphospecies codes never auto-merge (sp1 vs sp12 is distance-1).
  if (isPlaceholder(aName) || isPlaceholder(bName)) return 'needs_review';
  // 4c. a genus mismatch beyond a typo = cross-genus pair (sweep mis-paired via the
  //     stored genus column); the epithet match is coincidental (`Andropogon scoparius`
  //     vs `Schizachyrium scoparium`).
  if (levenshtein(genusToken(aName), genusToken(bName), GENUS_TYPO_MAX + 1) > GENUS_TYPO_MAX) return 'needs_review';
  // 5. Distance-1 epithet typo (equal token count guaranteed by rule 1) -> auto_safe.
  if (dist === 1) return 'auto_safe';
  // 6. Everything else (distance >= 2) -> needs_review.
  return 'needs_review';
}

module.exports = { tokenCount, hasHybridMarker, structuralNorm, isPlaceholder, pickCanonicalForDedup, tierOf };
