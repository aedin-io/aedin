'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contextForKingdom, groupByContext, matchNames } = require('./ott-tnrs-fallback.js');

test('each of our bio_categories maps to a TNRS context', () => {
  assert.equal(contextForKingdom('plantae'), 'Land plants');
  assert.equal(contextForKingdom('fungi'), 'Fungi');
  assert.equal(contextForKingdom('invertebrate'), 'Animals');
  assert.equal(contextForKingdom('vertebrate'), 'Animals');
  assert.equal(contextForKingdom('microbe'), 'Bacteria');
  assert.equal(contextForKingdom('other'), null, 'unknown kingdom gets no pinned context');
});

test('batches are grouped by context so a mixed batch cannot poison inference', () => {
  const groups = groupByContext([
    { id: 1, scientific_name: 'Ficus variegata', bio_category: 'plantae' },
    { id: 2, scientific_name: 'Oospora pucciniophila', bio_category: 'fungi' },
    { id: 3, scientific_name: 'Malus domestica', bio_category: 'plantae' },
  ]);
  assert.deepEqual([...groups.get('Land plants')].map(e => e.id), [1, 3]);
  assert.deepEqual([...groups.get('Fungi')].map(e => e.id), [2]);
});

test('matchNames sends the pinned context and returns name -> ott_id', async () => {
  let sentBody = null;
  const fakeFetch = async (url, body) => {
    sentBody = body;
    return { results: [{ name: 'Malus domestica',
                         matches: [{ taxon: { ott_id: 42 } }] }],
             unmatched_names: [] };
  };
  const out = await matchNames(['Malus domestica'], 'Land plants', fakeFetch);
  assert.equal(sentBody.context_name, 'Land plants', 'context MUST be pinned');
  assert.deepEqual([...out.entries()], [['Malus domestica', 42]]);
});

test('unmatched names are absent from the result rather than null-valued', async () => {
  const fakeFetch = async () => ({ results: [], unmatched_names: ['Nonexistus fakus'] });
  const out = await matchNames(['Nonexistus fakus'], 'Land plants', fakeFetch);
  assert.equal(out.size, 0);
});
