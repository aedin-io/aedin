'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findOrderDisagreement } = require('./order-consistency.js');

test('reports a family carrying two names for one order', () => {
  // Erysiphaceae as actually stored: powdery mildews split across Helotiales
  // and Erysiphales, WITHIN the same genera (Erysiphe 347/248). Both name the
  // same fungi; the corpus mixes classification systems.
  const r = findOrderDisagreement([
    { taxon_order: 'Helotiales', count: 1077 },
    { taxon_order: 'Erysiphales', count: 387 },
  ]);

  assert.equal(r.needsCanonicalization, true);
  assert.deepEqual(r.names.map(n => n.taxon_order), ['Helotiales', 'Erysiphales']);
  assert.equal(r.minorityCount, 387);
});

test('the most common name is not treated as the correct one', () => {
  // Helotiales outnumbers Erysiphales here but Erysiphales is the right name.
  // Frequency cannot pick the canonical form, so the result must not claim it.
  const r = findOrderDisagreement([
    { taxon_order: 'Helotiales', count: 1077 },
    { taxon_order: 'Erysiphales', count: 387 },
  ]);
  assert.equal('dominant' in r, false);
  assert.equal('correct' in r, false);
});

test('historical ordinal synonyms are reported, not suppressed', () => {
  // Polycarpicae is the Englerian name for Ranunculales - Ranunculus bulbosus
  // is a real buttercup, not a misfiled row. Reporting it is CORRECT for this
  // detector: two names for one order is exactly the defect it exists to find.
  // It is a naming problem, never evidence that an organism is misplaced.
  const r = findOrderDisagreement([
    { taxon_order: 'Ranunculales', count: 772 },
    { taxon_order: 'Polycarpicae', count: 156 },
  ]);
  assert.equal(r.needsCanonicalization, true);
});

test('a family with one order name needs no canonicalization', () => {
  const r = findOrderDisagreement([{ taxon_order: 'Pucciniales', count: 5044 }]);
  assert.equal(r.needsCanonicalization, false);
  assert.equal(r.minorityCount, 0);
});

test('unknown orders are ignored rather than counted as a second name', () => {
  assert.equal(findOrderDisagreement([]).needsCanonicalization, false);
  assert.equal(findOrderDisagreement([
    { taxon_order: 'Meliolales', count: 1535 }, { taxon_order: null, count: 4 },
  ]).needsCanonicalization, false);
});
