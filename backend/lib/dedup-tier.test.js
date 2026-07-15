'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tokenCount, hasHybridMarker, structuralNorm, isPlaceholder, pickCanonicalForDedup, tierOf } = require('./dedup-tier');

const E = (o) => Object.assign({ id: 0, scientific_name: '', gbif_key: null, scope_tier: null, claim_count: 0, trait_count: 0 }, o);

test('tokenCount ignores a standalone hybrid marker', () => {
  assert.equal(tokenCount('Citrus limon'), 2);
  assert.equal(tokenCount('Citrus × limon'), 2);
  assert.equal(tokenCount('Harmonia axyridis conspicua'), 3);
});

test('hasHybridMarker detects the × marker only as a standalone token', () => {
  assert.equal(hasHybridMarker('Mentha × piperita'), true);
  assert.equal(hasHybridMarker('Mentha piperita'), false);
  assert.equal(hasHybridMarker('Coix lacryma-jobi'), false); // embedded letters, not a marker
});

test('structuralNorm collapses junk + hybrid marker + apostrophe variants', () => {
  assert.equal(structuralNorm('Bombus_ terrestris-complex'), structuralNorm('Bombus terrestris-complex'));
  assert.equal(structuralNorm('Citrus × limon'), structuralNorm('Citrus limon'));
  assert.equal(structuralNorm("Zea mays 'Crisp 'N Sweet'"), structuralNorm("Zea mays 'Crisp 'N Sweet'"));
  assert.notEqual(structuralNorm('Chorebus eros'), structuralNorm('Chorebus bres'));
});

test('pickCanonicalForDedup: gbif-anchored wins', () => {
  assert.equal(pickCanonicalForDedup(E({ id: 1, gbif_key: 'X' }), E({ id: 2 })), 1);
  assert.equal(pickCanonicalForDedup(E({ id: 1 }), E({ id: 2, gbif_key: 'Y' })), 2);
});

test('pickCanonicalForDedup: else data-mass wins', () => {
  assert.equal(pickCanonicalForDedup(E({ id: 1, claim_count: 5 }), E({ id: 2, claim_count: 130, trait_count: 8 })), 2);
});

test('pickCanonicalForDedup: else served (non-null/lower scope_tier) wins', () => {
  assert.equal(pickCanonicalForDedup(E({ id: 1, scope_tier: null }), E({ id: 2, scope_tier: 3 })), 2);
  assert.equal(pickCanonicalForDedup(E({ id: 1, scope_tier: 0 }), E({ id: 2, scope_tier: 3 })), 1);
});

test('pickCanonicalForDedup: else lower id', () => {
  assert.equal(pickCanonicalForDedup(E({ id: 7 }), E({ id: 3 })), 3);
});

test('tierOf: junk-char twin -> auto_safe', () => {
  const a = E({ id: 1, scientific_name: 'Bombus_ terrestris-complex' });
  const b = E({ id: 2, scientific_name: 'Bombus terrestris-complex', scope_tier: 1 });
  assert.equal(tierOf(a, b, { levenshtein_distance: 0 }), 'auto_safe');
});

test('tierOf: punctuation-variant cultivar -> auto_safe', () => {
  const a = E({ id: 1, scientific_name: "Zea mays 'Crisp 'N Sweet'" });
  const b = E({ id: 2, scientific_name: "Zea mays 'Crisp 'N Sweet'", scope_tier: 0 });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'auto_safe');
});

test('tierOf: × marker pair -> domain', () => {
  const a = E({ id: 1, scientific_name: 'Mentha × piperita', scope_tier: 3 });
  const b = E({ id: 2, scientific_name: 'Mentha piperita', scope_tier: 0, claim_count: 20 });
  assert.equal(tierOf(a, b, { levenshtein_distance: 0 }), 'domain');
});

test('tierOf: distance-1 binomial typo -> auto_safe', () => {
  const a = E({ id: 1, scientific_name: 'Achilea milefolium' });
  const b = E({ id: 2, scientific_name: 'Achillea millefolium', gbif_key: 'G' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'auto_safe');
});

test('tierOf: binomial-vs-trinomial at distance-1 -> needs_review (subspecies guard)', () => {
  const a = E({ id: 1, scientific_name: 'Harmonia axyridis conspicua' });
  const b = E({ id: 2, scientific_name: 'Harmonia axyrides' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'needs_review');
});

test('tierOf: distance-2 congeners -> needs_review', () => {
  const a = E({ id: 1, scientific_name: 'Chorebus eros' });
  const b = E({ id: 2, scientific_name: 'Chorebus bres' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 2 }), 'needs_review');
});

test('isPlaceholder flags unresolved/morphospecies names, not real epithets', () => {
  assert.equal(isPlaceholder('Unidentified sp1 M_PL_015'), true);
  assert.equal(isPlaceholder('Lasioglossum sp. 2'), true);
  assert.equal(isPlaceholder('Lasioglossum sp.A'), true);   // letter code
  assert.equal(isPlaceholder('Brassica oleracea'), false);
  assert.equal(isPlaceholder('Pinus spinosa'), false);       // "sp" inside a real epithet
  assert.equal(isPlaceholder('Acacia spectabilis'), false);
});

test('tierOf: morphospecies letter-code pair (sp.A/sp.B) -> needs_review', () => {
  const a = E({ id: 1, scientific_name: 'Lasioglossum sp.A' });
  const b = E({ id: 2, scientific_name: 'Lasioglossum sp.B' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'needs_review');
});

test('tierOf: hybrid-marker-as-epithet (distinct hybrids) -> needs_review', () => {
  // The sweep scored distance-1 on the `×`/`X` markers; the real epithets differ.
  const a = E({ id: 1, scientific_name: 'Quercus × eplingii' });
  const b = E({ id: 2, scientific_name: 'Quercus X megaleia' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'needs_review');
});

test('tierOf: morphospecies code pair -> needs_review (never auto-merge)', () => {
  const a = E({ id: 1, scientific_name: 'Unidentified sp1 M_PL_015' });
  const b = E({ id: 2, scientific_name: 'Unidentified sp12 M_PL_001' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'needs_review');
});

test('tierOf: cross-genus synonym -> needs_review (coincidental epithet match)', () => {
  const a = E({ id: 1, scientific_name: 'Andropogon scoparius' });
  const b = E({ id: 2, scientific_name: 'Schizachyrium scoparium' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'needs_review');
});

test('tierOf: genus-typo (one edit) is NOT cross-genus -> still auto_safe', () => {
  // Achilea/Achillea is a 1-edit genus typo — same taxon, must survive the guard.
  const a = E({ id: 1, scientific_name: 'Achilea milefolium' });
  const b = E({ id: 2, scientific_name: 'Achillea millefolium' });
  assert.equal(tierOf(a, b, { levenshtein_distance: 1 }), 'auto_safe');
});
