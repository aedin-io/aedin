'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { resolve, normalizeName, curatedKingdomHint, validateTnrsMatch, binomialOf } = require('./ott-resolve.js');
const { candidatesFor } = require('./ott-lookup.js');

// Real OTT 3.7 ids.
const FIG      = { ott_id: 1050104, name: 'Ficus variegata Blume, 1825', rank: 'species', flags: '', kingdom: 'plantae' };
const MOLLUSC  = { ott_id: 7494610, name: 'Ficus variegata', rank: 'species', flags: '', kingdom: 'invertebrate' };
const FUNGUS   = { ott_id: 212213,  name: 'Cyathus striatus', rank: 'species', flags: '', kingdom: 'fungi' };
const EXTINCT  = { ott_id: 5733833, name: 'Cyathus striatus', rank: 'no rank', flags: 'extinct,incertae_sedis', kingdom: 'invertebrate' };
const STELIS_P = { ott_id: 262162,  name: 'Stelis', rank: 'genus', flags: '', kingdom: 'plantae' };
const STELIS_A = { ott_id: 527806,  name: 'Stelis', rank: 'genus', flags: '', kingdom: 'invertebrate' };

test('no candidates is unmatched, never a guess', () => {
  const r = resolve({ name: 'Nonexistus fakus', candidates: [], curatedHint: null });
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'unmatched');
  assert.equal(r.ott_id, null);
});

test('a single candidate resolves', () => {
  const r = resolve({ name: 'Cyathus striatus', candidates: [FUNGUS], curatedHint: null });
  assert.equal(r.accept, true);
  assert.equal(r.ott_id, 212213);
  assert.equal(r.reason, 'resolved_local');
});

test('OTT-flagged candidates are pruned before the curated lists are consulted', () => {
  // Cyathus striatus has a real species row and an extinct,incertae_sedis row.
  const r = resolve({ name: 'Cyathus striatus', candidates: [EXTINCT, FUNGUS], curatedHint: null });
  assert.equal(r.accept, true);
  assert.equal(r.ott_id, 212213);
});

test('the curated genus list breaks the fig/mollusc collision', () => {
  const r = resolve({ name: 'Ficus variegata', candidates: [MOLLUSC, FIG], curatedHint: 'plantae' });
  assert.equal(r.accept, true);
  assert.equal(r.ott_id, 1050104, 'must pick the fig, not the mollusc');
});

test('a genus with no curated entry abstains rather than coin-flipping', () => {
  // Stelis: orchid genus and bee genus. Neither is in the curated lists.
  const r = resolve({ name: 'Stelis', candidates: [STELIS_P, STELIS_A], curatedHint: null });
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidateIds.sort(), [262162, 527806]);
});

test('a lone candidate contradicting the curated hint abstains', () => {
  const r = resolve({ name: 'Ficus variegata', candidates: [MOLLUSC], curatedHint: 'plantae' });
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'hint_contradiction');
});

test('normalizeName strips authority, hybrid markers and infraspecific ranks — WITHOUT changing case', () => {
  // Case must survive: ott-lookup.js's candidatesFor compares under BINARY
  // collation against OTT's Title-Case names, so a lowercased retry could
  // never match (see the join test below).
  assert.equal(normalizeName('Ficus variegata Blume, 1825'), 'Ficus variegata');
  assert.equal(normalizeName('  Brassica   oleracea  '), 'Brassica oleracea');
  assert.equal(normalizeName('× Triticosecale'), 'Triticosecale');
  assert.equal(normalizeName('Brassica oleracea var. capitata'), 'Brassica oleracea capitata');
});

test('JOIN: normalizeName output must actually reach the row it was built to find', () => {
  // This is the test that was missing: ott-resolve.test.js asserted
  // normalizeName's output in isolation, and ott-lookup.test.js asserted
  // candidatesFor's matching behavior in isolation, but nothing connected
  // them — so normalizeName lowercasing its output (defeating the
  // case-sensitive `=` comparison in candidatesFor) passed every existing
  // test while the retry path it describes never fired for real names.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ott_taxa (ott_id INTEGER PRIMARY KEY, parent_ott_id INTEGER,
                           name TEXT, rank TEXT, source_info TEXT, uniqname TEXT, flags TEXT);
    CREATE TABLE ott_synonyms (name TEXT, ott_id INTEGER, type TEXT);
    INSERT INTO ott_taxa VALUES (1, NULL, 'Quercus alba', 'species', '', '', '');
  `);

  const raw = 'Quercus alba L., 1753';
  // The raw, authority-bearing name has no exact match against taxonomy.tsv.
  assert.deepEqual(candidatesFor(db, raw), []);

  const norm = normalizeName(raw);
  assert.equal(norm, 'Quercus alba', 'must preserve OTT-matching case, not lowercase it');

  const got = candidatesFor(db, norm);
  assert.equal(got.length, 1, 'the normalized retry must actually reach the row');
  assert.equal(got[0].ott_id, 1);
});

test('curatedKingdomHint reads the genus, and is silent when unknown', () => {
  assert.equal(curatedKingdomHint('Trichoderma harzianum'), 'fungi');
  assert.equal(curatedKingdomHint('Bacillus subtilis'), 'microbe');
  assert.equal(curatedKingdomHint('Stelis nemorosa'), null);
});

test('curatedKingdomHint adopts phylum-validator EXTRA_FUNGAL_GENERA (Cyathus)', () => {
  // Regression for the fork drift: phylum-validator.js's EXTRA_FUNGAL_GENERA
  // includes 'cyathus' (the bird's-nest fungus documented throughout this
  // codebase as the canonical genus-collision case), but the old private
  // PLANT_GENERA/FUNGAL_GENERA-only fork here didn't carry it, so this hint
  // returned null and the golden Cyathus case only resolved correctly by
  // accident (the animal homonym row happened to carry an 'extinct' flag).
  assert.equal(curatedKingdomHint('Cyathus striatus'), 'fungi');
});

test('Cyathus resolves via the curated fungal hint, not by accident of a flag', () => {
  const hint = curatedKingdomHint('Cyathus striatus');
  // Two STRONG (non-weak-flagged) candidates: the real fungus and a
  // hypothetical non-extinct animal homonym. Without a real hint this would
  // be an ambiguous tie between two equally-strong candidates; the hint
  // must be what breaks it, not weak-flag pruning.
  const ANIMAL_STRONG = { ott_id: 999001, name: 'Cyathus striatus', rank: 'species', flags: '', kingdom: 'invertebrate' };
  const r = resolve({ name: 'Cyathus striatus', candidates: [ANIMAL_STRONG, FUNGUS], curatedHint: hint });
  assert.equal(r.accept, true);
  assert.equal(r.ott_id, 212213, 'must pick the real fungus via the curated hint');
});

test('validateTnrsMatch: hint contradicts the TNRS result -> hint_contradiction, no id written', () => {
  const r = validateTnrsMatch({ ottId: 7494610, kingdom: 'invertebrate', curatedHint: 'plantae' });
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'hint_contradiction');
  assert.equal(r.ott_id, null);
});

test('validateTnrsMatch: hint agrees -> resolved_tnrs', () => {
  const r = validateTnrsMatch({ ottId: 1050104, kingdom: 'plantae', curatedHint: 'plantae' });
  assert.equal(r.accept, true);
  assert.equal(r.reason, 'resolved_tnrs');
  assert.equal(r.ott_id, 1050104);
});

test('validateTnrsMatch: no hint -> resolved_tnrs', () => {
  const r = validateTnrsMatch({ ottId: 42, kingdom: 'invertebrate', curatedHint: null });
  assert.equal(r.accept, true);
  assert.equal(r.reason, 'resolved_tnrs');
  assert.equal(r.ott_id, 42);
});

test('single candidate with null kingdom + curated hint → abstain as ambiguous', () => {
  const nullKingdom = { ott_id: 999999, name: 'Unknown taxon', rank: 'species', flags: '', kingdom: null };
  const r = resolve({ name: 'Unknown taxon', candidates: [nullKingdom], curatedHint: 'plantae' });
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidateIds, [999999]);
});

test('single candidate with null kingdom + NO curated hint → accept', () => {
  const nullKingdom = { ott_id: 999999, name: 'Unknown taxon', rank: 'species', flags: '', kingdom: null };
  const r = resolve({ name: 'Unknown taxon', candidates: [nullKingdom], curatedHint: null });
  assert.equal(r.accept, true);
  assert.equal(r.ott_id, 999999);
  assert.equal(r.reason, 'resolved_local');
});

test('two candidates: one null kingdom, one matching hint → accept the matching one', () => {
  const nullKingdom = { ott_id: 888888, name: 'Ambiguous', rank: 'genus', flags: '', kingdom: null };
  const r = resolve({ name: 'Some name', candidates: [nullKingdom, FIG], curatedHint: 'plantae' });
  assert.equal(r.accept, true);
  assert.equal(r.ott_id, 1050104);
  assert.equal(r.reason, 'resolved_local');
});

test('two candidates both with null kingdom + curated hint present → ambiguous', () => {
  const null1 = { ott_id: 777777, name: 'Mystery 1', rank: 'species', flags: '', kingdom: null };
  const null2 = { ott_id: 666666, name: 'Mystery 2', rank: 'species', flags: '', kingdom: null };
  const r = resolve({ name: 'Mystery', candidates: [null1, null2], curatedHint: 'plantae' });
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidateIds.sort(), [666666, 777777]);
});

// ── ASCII hybrid markers ──────────────────────────────────────────────────────
test('normalizeName strips the ASCII hybrid marker, not just the × sign', () => {
  // OTT stores the fig-hybrid style names without the marker; our corpus writes
  // "Citrus X limonia". Stripping only the true × left these unmatched, and the
  // network fallback was recovering them one round-trip at a time.
  assert.equal(normalizeName('Citrus X limonia'), 'Citrus limonia');
  assert.equal(normalizeName('Rosa x centifolia'), 'Rosa centifolia');
  assert.equal(normalizeName('× Triticosecale'), 'Triticosecale');
  assert.equal(normalizeName('X Agropogon littoralis'), 'Agropogon littoralis');
});

test('normalizeName does not eat a legitimate epithet that merely starts with x', () => {
  assert.equal(normalizeName('Rosa xanthina'), 'Rosa xanthina');
  assert.equal(normalizeName('Carex xerantica'), 'Carex xerantica');
});

// ── binomial fallback for infraspecific names ────────────────────────────────
test('binomialOf reduces an infraspecific name to its genus + species', () => {
  assert.equal(binomialOf('Armeria maritima planifolia'), 'Armeria maritima');
  assert.equal(binomialOf('Penstemon glaber alpinus'), 'Penstemon glaber');
  assert.equal(binomialOf("Gossypium hirsutum 'Deltapine 458 B/rr'"), 'Gossypium hirsutum');
  assert.equal(binomialOf('Parantica melaneus swinhoei'), 'Parantica melaneus');
});

test('binomialOf returns null when there is nothing to reduce', () => {
  assert.equal(binomialOf('Armeria maritima'), null, 'already a binomial');
  assert.equal(binomialOf('Aphididae'), null, 'single token');
  assert.equal(binomialOf(''), null);
});

test('binomialOf refuses names that are not genus-species shaped', () => {
  // A virus name would truncate to nonsense ("Tomato yellow"), and a Candidatus
  // prefix would truncate to the wrong rank. Neither is a binomial.
  assert.equal(binomialOf('Tomato yellow leaf curl virus'), null);
  assert.equal(binomialOf('Candidatus Liberibacter asiaticus'), null);
  assert.equal(binomialOf('NE-facing limestone scree'), null);
});

test('binomialOf refuses virus names whose suffix is the marker, not a whole word', () => {
  // The original guard used \bvirus\b, which does NOT match inside
  // "rhabdovirus" — so 57 virus entities were truncated to the ORGANISM THEY
  // INFECT: Helicoverpa armigera nucleopolyhedrovirus -> Helicoverpa armigera,
  // a baculovirus biocontrol linked to the moth it kills.
  assert.equal(binomialOf('Cynara cardunculus rhabdovirus'), null);
  assert.equal(binomialOf('Helicoverpa armigera nucleopolyhedrovirus'), null);
  assert.equal(binomialOf('Agastache rugosa associated varicosavirus'), null);
  assert.equal(binomialOf('Citrus tristeza closterovirus'), null);
  assert.equal(binomialOf('Pseudoplusia includens densovirus'), null);
  assert.equal(binomialOf('Cotton leaf curl virus betasatellite DNA'), null);
});

test('binomialOf still accepts real taxa whose epithet merely contains those letters', () => {
  // These are genuine OTT taxa: a fungus, a plant and a bird. A naive substring
  // guard would refuse all three.
  assert.equal(binomialOf('Hygrophorus parvirussula alba'), 'Hygrophorus parvirussula');
  assert.equal(binomialOf('Tristemma virusanum minor'), 'Tristemma virusanum');
  assert.equal(binomialOf('Lipaugus virussu australis'), 'Lipaugus virussu');
});
