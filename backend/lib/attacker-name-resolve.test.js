'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAttackerName } = require('./attacker-name-resolve');

test('curated disease names resolve to a pathogen + disease_resistance', () => {
  assert.deepEqual(resolveAttackerName('Fusarium wilt'), { scientificName: 'Fusarium oxysporum', category: 'disease_resistance', kind: 'pathogen' });
  assert.deepEqual(resolveAttackerName('TMV'), { scientificName: 'Tobacco mosaic virus', category: 'disease_resistance', kind: 'pathogen' });
  assert.deepEqual(resolveAttackerName('verticillium'), { scientificName: 'Verticillium dahliae', category: 'disease_resistance', kind: 'pathogen' });
  assert.deepEqual(resolveAttackerName('southern blight'), { scientificName: 'Sclerotium rolfsii', category: 'disease_resistance', kind: 'pathogen' });
});

test('a nematode resolves to the pathogen (disease) side', () => {
  assert.equal(resolveAttackerName('root-knot nematode').category, 'disease_resistance');
  assert.equal(resolveAttackerName('root-knot nematode').kind, 'pathogen');
});

test('curated pest names resolve to an arthropod + pest_resistance', () => {
  assert.deepEqual(resolveAttackerName('whitefly'), { scientificName: 'Bemisia tabaci', category: 'pest_resistance', kind: 'pest' });
  assert.equal(resolveAttackerName('aphids').category, 'pest_resistance');
});

test('matching is case- and trim-insensitive', () => {
  assert.equal(resolveAttackerName('  FUSARIUM WILT  ').category, 'disease_resistance');
});

test('an uncurated name abstains (null), never guesses', () => {
  assert.equal(resolveAttackerName('mystery rot 27'), null);
  assert.equal(resolveAttackerName(''), null);
  assert.equal(resolveAttackerName(null), null);
});

// --- GRIN tomato-disease vocabulary extension (Phase-1 operational run) ---

test('extended tomato disease vocabulary resolves (leaf mold, CMV, Fusarium scientific form)', () => {
  assert.deepEqual(resolveAttackerName('leaf mold'), { scientificName: 'Passalora fulva', category: 'disease_resistance', kind: 'pathogen' });
  assert.deepEqual(resolveAttackerName('Cladosporium fulvum'), { scientificName: 'Passalora fulva', category: 'disease_resistance', kind: 'pathogen' });
  assert.deepEqual(resolveAttackerName('CMV'), { scientificName: 'Cucumber mosaic virus', category: 'disease_resistance', kind: 'pathogen' });
  assert.deepEqual(resolveAttackerName('Fusarium oxysporum'), { scientificName: 'Fusarium oxysporum', category: 'disease_resistance', kind: 'pathogen' });
});

test('qualifier normalizer strips parentheticals / race / forma-specialis and retries', () => {
  assert.equal(resolveAttackerName('fusarium (race 2)').scientificName, 'Fusarium oxysporum');
  assert.equal(resolveAttackerName('Fusarium race 1').scientificName, 'Fusarium oxysporum');
  assert.equal(resolveAttackerName('Fusarium oxysporum f. lycopersici').scientificName, 'Fusarium oxysporum');
  assert.equal(resolveAttackerName('Early Blight (A. linariae; syn. A. tomatophila)').scientificName, 'Alternaria linariae');
});

test('early blight is host-qualified: tomato → A. linariae, potato → A. solani', () => {
  assert.equal(resolveAttackerName('early blight').scientificName, 'Alternaria linariae');
  assert.equal(resolveAttackerName('Alternaria tomatophila').scientificName, 'Alternaria linariae');
  assert.equal(resolveAttackerName('potato early blight').scientificName, 'Alternaria solani');
  assert.equal(resolveAttackerName('Alternaria solani').scientificName, 'Alternaria solani');
});

test('genuinely-vague attacker names still abstain after the extension', () => {
  assert.equal(resolveAttackerName('wilt'), null);
  assert.equal(resolveAttackerName('bacterial rot'), null);
  assert.equal(resolveAttackerName('virus diseases'), null);
  assert.equal(resolveAttackerName('blight'), null);
});
