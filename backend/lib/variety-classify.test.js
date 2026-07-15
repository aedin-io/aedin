'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyVarietyType } = require('./variety-classify.js');
const C = (scientific_name, variety_name) => classifyVarietyType({ scientific_name, variety_name });

test('quote -> cultivar (straight and curly), quote wins over var.', () => {
  assert.equal(C("Prunus persica 'Gulfking'"), 'cultivar');
  assert.equal(C("Prunus persica ‘Gulfking’"), 'cultivar');
  assert.equal(C("Brassica oleracea var. capitata 'KY-Cross'"), 'cultivar'); // quote wins
});
test('hybrid marker -> hybrid (× sign and " x " between binomials)', () => {
  assert.equal(C('Populus × canescens'), 'hybrid');
  assert.equal(C('Vitis cinerea var. helleri x Vitis riparia'), 'hybrid'); // hybrid wins over var.
});
test('botanical rank markers', () => {
  assert.equal(C('Achillea alpina subsp. japonica'), 'subsp');
  assert.equal(C('Apium graveolens var. dulce'), 'var');
  assert.equal(C('Passiflora edulis f. flavicarpa'), 'f');
  assert.equal(C('Colletotrichum gloeosporioides f. heveae'), 'f'); // fungal f. is still rank 'f' (kingdom via bio_category)
});
test('no marker -> morphotype; cultivar name with letter x is NOT hybrid', () => {
  assert.equal(C('Solanum lycopersicum'), 'morphotype');
  assert.equal(C("Solanum lycopersicum 'Maxifort'"), 'cultivar'); // quote caught first; the x never reaches hybrid
});
