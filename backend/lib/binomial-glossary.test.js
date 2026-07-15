'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { extractCandidates, extractPairings, buildGlossary, renderGlossaryMarkdown } = require('./binomial-glossary');

test('extractCandidates finds a genuine binomial', () => {
  const c = extractCandidates('The melon fly Bactrocera cucurbitae attacks cucurbits.');
  assert.ok(c.has('Bactrocera cucurbitae'));
});

test('extractCandidates counts repeated mentions', () => {
  const c = extractCandidates('Bactrocera cucurbitae ... later Bactrocera cucurbitae again.');
  assert.equal(c.get('Bactrocera cucurbitae'), 2);
});

test('extractCandidates rejects sentence-starter false positives', () => {
  const c = extractCandidates('The species was studied. This insect feeds widely. These plants grow.');
  assert.equal(c.has('The species'), false);
  assert.equal(c.has('This insect'), false);
  assert.equal(c.has('These plants'), false);
});

test('extractCandidates rejects "Genus species"-shaped common phrases via epithet stopwords', () => {
  const c = extractCandidates('Crop species vary. Pest control matters. Plant growth slowed.');
  assert.equal(c.size, 0);
});

test('extractCandidates handles infraspecific markers (keeps bare binomial key)', () => {
  const c = extractCandidates('Brassica oleracea var. capitata is cabbage.');
  assert.ok(c.has('Brassica oleracea'));
});

test('extractCandidates rejects real-world PDF-noise false positives (regression)', () => {
  // From ctahr_ip40_taro_pests.pdf: "Adult square" (body text) and "Last viewed" (footer).
  const c = extractCandidates('Adult square mealybug. Adult square. Last viewed 2024. Last viewed.');
  assert.equal(c.has('Adult square'), false, '"Adult" genus stopword');
  assert.equal(c.has('Last viewed'), false, '"Last" genus stopword');
});

test('buildGlossary (no db): keeps recurring candidates, drops single-occurrence unknowns', async () => {
  const text = 'Bactrocera cucurbitae appears twice: Bactrocera cucurbitae. Zonosemata electa once.';
  const g = await buildGlossary(text, null);
  const names = g.map(x => x.binomial);
  assert.ok(names.includes('Bactrocera cucurbitae'), 'recurring kept');
  assert.ok(!names.includes('Zonosemata electa'), 'single-occurrence unknown dropped (no db)');
});

test('buildGlossary (with db stub): entity-match promotes a single-occurrence candidate', async () => {
  const text = 'The fruit fly Bactrocera frauenfeldi is the mango fruit fly. mango fly, mango fly.';
  // stub db: Bactrocera frauenfeldi is a known entity
  const db = {
    all: async (_sql, params) => params
      .filter(p => p.toLowerCase() === 'bactrocera frauenfeldi')
      .map(() => ({ scientific_name: 'Bactrocera frauenfeldi' })),
  };
  const g = await buildGlossary(text, db);
  const entry = g.find(x => x.binomial === 'Bactrocera frauenfeldi');
  assert.ok(entry, 'single-occurrence but entity-known candidate kept');
  assert.equal(entry.known, true);
});

test('buildGlossary sorts known before novel, then by count', async () => {
  const text = 'Aaa bbbbb. Aaa bbbbb. Ccc ddddd.';  // Aaa bbbbb x2, Ccc ddddd x1 (dropped, unknown single)
  const db = { all: async (_s, params) => params.filter(p => p === 'Ccc ddddd').map(() => ({ scientific_name: 'Ccc ddddd' })) };
  const g = await buildGlossary(text, db);
  // Ccc ddddd is known (single but entity), Aaa bbbbb recurs but unknown
  assert.equal(g[0].binomial, 'Ccc ddddd', 'known sorts first');
});

// ── extractPairings (common-name → binomial disambiguation) ───────────────────

test('extractPairings: "common name (Genus species)" ordering', () => {
  const p = extractPairings('The melon fly (Bactrocera cucurbitae) attacks cucurbits.');
  assert.ok(p.has('melon fly'));
  assert.ok(p.get('melon fly').has('Bactrocera cucurbitae'));
});

test('extractPairings: "Genus species (common name)" ordering', () => {
  const p = extractPairings('Bactrocera dorsalis (oriental fruit fly) is a major pest.');
  assert.ok(p.has('oriental fruit fly'));
  assert.ok(p.get('oriental fruit fly').has('Bactrocera dorsalis'));
});

test('extractPairings: rejects taxonomic authority parentheticals', () => {
  // "Bactrocera dorsalis (Hendel)" — Hendel is the author, NOT a common name
  const p = extractPairings('Bactrocera dorsalis (Hendel) was described in 1912. Cydia pomonella (Linnaeus, 1758) too.');
  assert.equal(p.has('hendel'), false);
  assert.equal([...p.keys()].some(k => /linnaeus/.test(k)), false);
});

test('extractPairings: same common name → multiple congeners flagged ambiguous on render', () => {
  const p = extractPairings('the fruit fly (Bactrocera dorsalis) ... the fruit fly (Bactrocera cucurbitae).');
  assert.ok(p.get('fruit fly').size >= 2, 'both congeners captured under one common name');
  const md = renderGlossaryMarkdown([], p);
  assert.match(md, /AMBIGUOUS/);
  assert.match(md, /Bactrocera dorsalis \| Bactrocera cucurbitae|Bactrocera cucurbitae \| Bactrocera dorsalis/);
});

test('renderGlossaryMarkdown produces a fallback when empty', () => {
  const md = renderGlossaryMarkdown([]);
  assert.match(md, /No explicit binomials/);
});

test('renderGlossaryMarkdown shows the common-name map when pairings present', () => {
  const p = new Map([['melon fly', new Set(['Bactrocera cucurbitae'])]]);
  const md = renderGlossaryMarkdown([{ binomial: 'Bactrocera cucurbitae', count: 2, known: true }], p);
  assert.match(md, /COMMON-NAME . SPECIES MAP/);
  assert.match(md, /"melon fly" . Bactrocera cucurbitae/);
});

test('renderGlossaryMarkdown lists binomials and flags novel ones', () => {
  const md = renderGlossaryMarkdown([
    { binomial: 'Bactrocera cucurbitae', count: 3, known: true },
    { binomial: 'Zonosemata electa', count: 2, known: false },
  ]);
  assert.match(md, /Bactrocera cucurbitae/);
  assert.match(md, /Zonosemata electa \(novel\)/);
  assert.match(md, /authoritative over your prior/);
});
