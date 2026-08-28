'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTaxonomyLine, parseSynonymLine } = require('./ott-tsv.js');

const TAX_HEADER = 'uid\t|\tparent_uid\t|\tname\t|\trank\t|\tsourceinfo\t|\tuniqname\t|\tflags\t|\t';
const TAX_ROOT   = '805080\t|\t\t|\tlife\t|\tno rank\t|\tsilva:0,ncbi:1,gbif:0,irmng:0\t|\t\t|\t\t|\t';
const TAX_PLANT  = '1050104\t|\t658513\t|\tFicus variegata Blume, 1825\t|\tspecies\t|\tgbif:3234563\t|\t\t|\t\t|\t';
const TAX_FUNGUS = '212213\t|\t212214\t|\tCyathus striatus\t|\tspecies\t|\tncbi:100\t|\tCyathus striatus (species in Nucletmycea)\t|\t\t|\t';
const TAX_FLAGGED= '5733833\t|\t5321818\t|\tCyathus striatus\t|\tno rank\t|\tirmng:1\t|\t\t|\textinct,incertae_sedis\t|\t';

const SYN_HEADER = 'name\t|\tuid\t|\ttype\t|\tuniqname\t|\tsourceinfo\t|\t';
const SYN_FICUS  = 'Ficus variegata\t|\t1050104\t|\t\t|\t\t|\tgbif:3234563\t|\t';

test('parses a taxonomy row into named fields', () => {
  assert.deepEqual(parseTaxonomyLine(TAX_PLANT), {
    ott_id: 1050104, parent_ott_id: 658513,
    name: 'Ficus variegata Blume, 1825', rank: 'species',
    source_info: 'gbif:3234563', uniqname: '', flags: '',
  });
});

test('the root row has an empty parent, not a zero', () => {
  const r = parseTaxonomyLine(TAX_ROOT);
  assert.equal(r.ott_id, 805080);
  assert.equal(r.parent_ott_id, null);
  assert.equal(r.name, 'life');
});

test('flags and uniqname are preserved verbatim', () => {
  assert.equal(parseTaxonomyLine(TAX_FLAGGED).flags, 'extinct,incertae_sedis');
  assert.equal(parseTaxonomyLine(TAX_FUNGUS).uniqname, 'Cyathus striatus (species in Nucletmycea)');
});

test('header and blank lines are skipped', () => {
  assert.equal(parseTaxonomyLine(TAX_HEADER), null);
  assert.equal(parseTaxonomyLine(''), null);
  assert.equal(parseSynonymLine(SYN_HEADER), null);
});

test('parses a synonym row', () => {
  assert.deepEqual(parseSynonymLine(SYN_FICUS), {
    name: 'Ficus variegata', ott_id: 1050104, type: '',
  });
});
