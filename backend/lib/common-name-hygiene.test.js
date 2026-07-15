const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectCommonNameIssue, KNOWN_CANONICALS } = require('./common-name-hygiene');

// ── lazy_self: common_name === scientific_name (155 such rows in current DB) ──
test('detectCommonNameIssue: lazy_self when common_name equals scientific_name', () => {
  const r = detectCommonNameIssue({ scientific_name: 'Foo bar', common_name: 'Foo bar' });
  assert.equal(r.type, 'lazy_self');
  assert.equal(r.suggestion, null);  // suggest setting to NULL
  assert.equal(r.auto_fixable, true);
});

test('detectCommonNameIssue: lazy_self case-insensitive', () => {
  const r = detectCommonNameIssue({ scientific_name: 'Apis Mellifera', common_name: 'apis mellifera' });
  assert.equal(r.type, 'lazy_self');
});

// ── known_canonical: scientific_name has a hand-curated correct common_name ──
test('detectCommonNameIssue: Apis mellifera "Africanized honey bee" → use canonical "western honey bee"', () => {
  const r = detectCommonNameIssue({ scientific_name: 'Apis mellifera', common_name: 'Africanized honey bee' });
  assert.equal(r.type, 'known_canonical_override');
  assert.equal(r.suggestion, 'western honey bee');
  assert.equal(r.auto_fixable, true);
});

test('detectCommonNameIssue: bare "honey bee" is now flagged (lacks species-level disambiguation)', () => {
  const r = detectCommonNameIssue({ scientific_name: 'Apis mellifera', common_name: 'honey bee' });
  assert.equal(r?.type, 'known_canonical_override');
  assert.equal(r.suggestion, 'western honey bee');
});

test('detectCommonNameIssue: already-canonical "western honey bee" returns null', () => {
  const r = detectCommonNameIssue({ scientific_name: 'Apis mellifera', common_name: 'western honey bee' });
  assert.equal(r, null);
});

test('detectCommonNameIssue: case-insensitive scientific_name match for canonicals', () => {
  const r = detectCommonNameIssue({ scientific_name: 'apis mellifera', common_name: 'Africanized honey bee' });
  assert.equal(r.type, 'known_canonical_override');
  assert.equal(r.suggestion, 'western honey bee');
});

test('detectCommonNameIssue: typo\'d Apis variants are NOT auto-fixed via canonical (they need taxonomic dedup, not name patching)', () => {
  // Removed scientific_aliases path — typo'd entries should be flagged for
  // dedup via needs_dedup column, not silently aliased through the canonical.
  for (const sci of ['Apis melliferae', 'Apis melliferra']) {
    const r = detectCommonNameIssue({ scientific_name: sci, common_name: 'Africanized honey bee' });
    assert.equal(r, null, `typo'd ${sci} should NOT match canonical override`);
  }
});

// ── multi_name: " / " separator (72 such rows) ──
test('detectCommonNameIssue: slash-delimited multi-name flagged but NOT auto-fixable', () => {
  const r = detectCommonNameIssue({ scientific_name: 'Allium cepa', common_name: 'Onion / Garlic / Leek' });
  assert.equal(r.type, 'multi_name');
  assert.equal(r.suggestion, null);  // can't auto-pick the right one
  assert.equal(r.auto_fixable, false);
});

// ── No issue ──
test('detectCommonNameIssue: clean common_name returns null', () => {
  const r = detectCommonNameIssue({ scientific_name: 'Bombus terrestris', common_name: 'Buff-tailed bumblebee' });
  assert.equal(r, null);
});

test('detectCommonNameIssue: empty/null common_name returns null (sparse, not wrong)', () => {
  assert.equal(detectCommonNameIssue({ scientific_name: 'Foo bar', common_name: null }), null);
  assert.equal(detectCommonNameIssue({ scientific_name: 'Foo bar', common_name: '' }), null);
});

test('detectCommonNameIssue: missing entity fields handled gracefully', () => {
  assert.equal(detectCommonNameIssue({}), null);
  assert.equal(detectCommonNameIssue(null), null);
});

// ── KNOWN_CANONICALS exposed for inspection ──
test('KNOWN_CANONICALS Apis entry uses ITIS canonical "western honey bee"', () => {
  const apis = KNOWN_CANONICALS.find(c => /apis mellifera/i.test(c.scientific_name));
  assert.ok(apis, 'Apis mellifera should be in KNOWN_CANONICALS');
  assert.equal(apis.canonical, 'western honey bee');
  // The wrong-pattern matchers should include "Africanized" AND bare "honey bee"
  assert.ok(apis.wrong_patterns.some(p => /africaniz/i.test(p.toString())));
  assert.ok(apis.wrong_patterns.some(p => /\^honey bee\$/i.test(p.toString())));
});
