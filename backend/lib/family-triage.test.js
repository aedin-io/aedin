'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flagContaminants, triageFamily } = require('./family-triage.js');

test('flags a family whose genus tail contains a biocontrol fungus', () => {
  // Didymellaceae: pathogenic core (Ascochyta, Phoma, Didymella) but Epicoccum
  // is a saprobe sold as a biocontrol agent. A family rule here would brand it
  // a plant pathogen — the exact defect the family floor exists to prevent.
  const hits = flagContaminants(['Ascochyta', 'Phoma', 'Didymella', 'Epicoccum']);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].genus, 'Epicoccum');
  assert.equal(hits[0].kind, 'biocontrol');
});

test('flags mycoparasite and entomopathogen genera, not only saprobe biocontrols', () => {
  const hits = flagContaminants(['Coniothyrium', 'Microsphaeropsis', 'Beauveria']);

  assert.deepEqual(hits.map(h => h.genus).sort(),
    ['Beauveria', 'Coniothyrium', 'Microsphaeropsis']);
  assert.equal(hits.find(h => h.genus === 'Coniothyrium').kind, 'mycoparasite');
  assert.equal(hits.find(h => h.genus === 'Beauveria').kind, 'entomopathogen');
});

test('a compositionally clean family is routed for review, never auto-blessed', () => {
  // Pucciniaceae is as monomorphic as fungal families get — all rusts. Even so,
  // the triage must not decide it is assertable. Reading a family name and
  // recalling what the taxon "usually is" is the reasoning that produced
  // fungi->pathogen_fungal. Only a domain critic converts this to a rule.
  const entry = triageFamily({
    family: 'Pucciniaceae',
    entityCount: 4900,
    genera: [{ genus: 'Puccinia', count: 2893 }, { genus: 'Uromyces', count: 886 }],
  });

  assert.equal(entry.verdict, 'needs_review');
  assert.deepEqual(entry.contaminants, []);
});

test('a contaminated family is withheld from auto-apply and names the offender', () => {
  const entry = triageFamily({
    family: 'Didymellaceae',
    entityCount: 1509,
    genera: [
      { genus: 'Ascochyta', count: 536 },
      { genus: 'Phoma', count: 447 },
      { genus: 'Epicoccum', count: 41 },
      { genus: 'Microsphaeropsis', count: 19 },
    ],
  });

  assert.equal(entry.verdict, 'contaminated');
  assert.equal(entry.autoApplyEligible, false);
  assert.deepEqual(entry.contaminants.map(c => c.genus), ['Epicoccum', 'Microsphaeropsis']);
});

test('review-routed families are also withheld from auto-apply', () => {
  // No family reaches role_rules without a critic verdict — contamination is a
  // stronger warning, not the only barrier.
  const entry = triageFamily({
    family: 'Pucciniaceae', entityCount: 4900, genera: [{ genus: 'Puccinia', count: 2893 }],
  });
  assert.equal(entry.autoApplyEligible, false);
});
