'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTraitPrompt } = require('./render-trait-extractor-prompt');

const VOCAB = {
  photosynthetic_pathway: { trait_name: 'photosynthetic_pathway', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: ['plantae'], enum_values: ['c3','c4','cam','c3_c4_intermediate'], description: 'Carbon-fixation pathway' },
  frost_hardiness: { trait_name: 'frost_hardiness', value_kind: 'categorical', expected_unit: null,
    applicable_bio_categories: ['plantae'], enum_values: ['tender','semi_hardy','moderately_hardy','very_hardy'], description: 'Acute freeze-injury survival' },
};
const TEMPLATE = 'TARGET\n{{TARGET_TRAITS}}\nFULL\n{{TRAITS_VOCABULARY}}\nGLOSS{{BINOMIAL_GLOSSARY}}\nCAND{{CANDIDATE_ENTITIES}}\nDOC\n{{DOCUMENT}}';

test('buildTraitPrompt puts ONLY the target traits in the TARGET block', () => {
  const out = buildTraitPrompt(TEMPLATE, VOCAB, ['photosynthetic_pathway'], { chunk: 'Maize is C4.' });
  const targetBlock = out.slice(out.indexOf('TARGET'), out.indexOf('FULL'));
  assert.match(targetBlock, /photosynthetic_pathway/);
  assert.doesNotMatch(targetBlock, /frost_hardiness/);          // non-target excluded from TARGET block
});

test('buildTraitPrompt keeps the full vocab + injects the chunk', () => {
  const out = buildTraitPrompt(TEMPLATE, VOCAB, ['photosynthetic_pathway'], { chunk: 'Maize is C4.' });
  const fullBlock = out.slice(out.indexOf('FULL'), out.indexOf('GLOSS'));
  assert.match(fullBlock, /frost_hardiness/);                   // full vocab block has all traits
  assert.match(out, /Maize is C4\./);                           // document chunk injected
});

test('buildTraitPrompt injects glossary + candidates', () => {
  const out = buildTraitPrompt(TEMPLATE, VOCAB, ['photosynthetic_pathway'],
    { chunk: 'x', glossaryMd: 'GLOSSARY_BODY', candidatesMd: 'CANDIDATE_BODY' });
  assert.match(out, /GLOSSARY_BODY/);
  assert.match(out, /CANDIDATE_BODY/);
});

test('buildTraitPrompt throws on an unknown target trait', () => {
  assert.throws(() => buildTraitPrompt(TEMPLATE, VOCAB, ['nonexistent_trait'], { chunk: 'x' }), /unknown traits/i);
});
