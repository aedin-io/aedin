'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gbifVernacularRecords, wikidataCommonNameRecords } = require('./vernacular-sources');

test('gbifVernacularRecords normalizes language, tags source, skips blanks', () => {
  const recs = gbifVernacularRecords([
    { vernacularName: 'garlic', language: 'eng', source: 'CoL' },
    { vernacularName: 'ajo', language: 'spa' },
    { vernacularName: '', language: 'fra' },        // skip blank name
    { vernacularName: 'knoblauch', language: '' },   // skip blank lang
  ]);
  assert.deepEqual(recs, [
    { name: 'garlic', language: 'en', source: 'gbif', source_ref: 'CoL', is_preferred: 0 },
    { name: 'ajo', language: 'es', source: 'gbif', source_ref: null, is_preferred: 0 },
  ]);
});

test('wikidataCommonNameRecords reads P1843 bindings with xml:lang', () => {
  const recs = wikidataCommonNameRecords([
    { commonName: { value: 'garlic', 'xml:lang': 'en' } },
    { commonName: { value: 'Knoblauch', 'xml:lang': 'de' } },
    { commonName: { value: '  ', 'xml:lang': 'fr' } },  // skip blank
  ], 'Q23400');
  assert.deepEqual(recs, [
    { name: 'garlic', language: 'en', source: 'wikidata', source_ref: 'Q23400', is_preferred: 1 },
    { name: 'Knoblauch', language: 'de', source: 'wikidata', source_ref: 'Q23400', is_preferred: 1 },
  ]);
});
