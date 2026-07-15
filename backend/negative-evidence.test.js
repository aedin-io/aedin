'use strict';

/**
 * Unit tests for the negative-evidence capture path (migration 056).
 *
 * DB-free: exercises the pure payload→claim transform in promote-staged-claims.js
 * (mapPayloadToClaim / readAbsence). Importing the module does NOT run the CLI
 * promotion — that is guarded by `require.main === module`.
 *
 * Run: node --test backend/negative-evidence.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { mapPayloadToClaim, readAbsence, readCoevolution } = require('./promote-staged-claims');

test('positive interaction defaults to observedAbsence=0, absenceBasis=null', () => {
  const claim = mapPayloadToClaim(
    { target_table: 'interactions' },
    {
      subject_organism: 'Aulacophora indica',
      object_organism: 'Cucumis sativus',
      interaction_type: 'herbivory',
      effect_direction: 'harmful',
      source_quote: 'major pest of cucurbit crops',
      regional_context: 'Guam',
    }
  );
  assert.equal(claim.observedAbsence, 0);
  assert.equal(claim.absenceBasis, null);
});

test('absence interaction threads observed_absence + valid basis through', () => {
  const claim = mapPayloadToClaim(
    { target_table: 'interactions' },
    {
      subject_organism: 'Plutella xylostella',
      object_organism: 'Allium sativum',
      interaction_type: 'herbivory',
      effect_direction: 'neutral',
      observed_absence: true,
      absence_basis: 'no_choice_trial',
      source_quote: 'diamondback moth did not accept garlic',
      regional_context: 'Global',
    }
  );
  assert.equal(claim.observedAbsence, 1);
  assert.equal(claim.absenceBasis, 'no_choice_trial');
});

test('absence on a crop_vulnerabilities resistance screen threads through', () => {
  const claim = mapPayloadToClaim(
    { target_table: 'crop_vulnerabilities' },
    {
      pest_scientific_name: 'Tuta absoluta',
      crop: 'Solanum lycopersicum',
      damage_type: 'pest_pressure',
      observed_absence: 1,
      absence_basis: 'resistance_screen',
      source_quote: 'cultivar showed no susceptibility',
      regional_context: 'Brazil',
    }
  );
  assert.equal(claim.observedAbsence, 1);
  assert.equal(claim.absenceBasis, 'resistance_screen');
});

test('unrecognized absence_basis is nulled but observedAbsence stays set', () => {
  const claim = mapPayloadToClaim(
    { target_table: 'interactions' },
    {
      subject_organism: 'Aphis gossypii',
      object_organism: 'Lactuca sativa',
      interaction_type: 'herbivory',
      observed_absence: true,
      absence_basis: 'vibes',
      source_quote: 'not found on lettuce in survey',
      regional_context: 'Guam',
    }
  );
  assert.equal(claim.observedAbsence, 1);
  assert.equal(claim.absenceBasis, null, 'bad basis nulled, claim still an absence');
});

test('readAbsence accepts boolean true, integer 1, and string "true"', () => {
  assert.deepEqual(readAbsence({ observed_absence: true, absence_basis: 'choice_trial' }),
    { observedAbsence: 1, absenceBasis: 'choice_trial' });
  assert.deepEqual(readAbsence({ observed_absence: 1, absence_basis: 'field_survey_absent' }),
    { observedAbsence: 1, absenceBasis: 'field_survey_absent' });
  assert.deepEqual(readAbsence({ observed_absence: 'true', absence_basis: 'explicit_non_host' }),
    { observedAbsence: 1, absenceBasis: 'explicit_non_host' });
});

test('readAbsence treats missing / falsey observed_absence as positive', () => {
  assert.deepEqual(readAbsence({}), { observedAbsence: 0, absenceBasis: null });
  assert.deepEqual(readAbsence({ observed_absence: false }), { observedAbsence: 0, absenceBasis: null });
});

test('attractor relationships are always positive (observedAbsence=0)', () => {
  const claim = mapPayloadToClaim(
    { target_table: 'attractor_relationship' },
    {
      subject_organism: 'Fagopyrum esculentum',
      object_organism: 'Chrysoperla carnea',
      interaction_category: 'attracts_natural_enemy',
      source_quote: 'buckwheat flowers attract lacewings',
      regional_context: 'Global',
    }
  );
  assert.equal(claim.observedAbsence, 0);
  assert.equal(claim.absenceBasis, null);
  assert.equal(claim.coevolutionStructure, null, 'attractor is not a host-pathogen pair');
});

// --- coevolution_structure (migration 060) ---

test('coevolution_structure threads through a pathogen interaction claim', () => {
  const claim = mapPayloadToClaim(
    { target_table: 'interactions' },
    {
      subject_organism: 'Puccinia graminis',
      object_organism: 'Triticum aestivum',
      interaction_type: 'pathogen_pressure',
      coevolution_structure: 'gene_for_gene',
      source_quote: 'race-specific stem rust resistance broke down',
      regional_context: 'Global',
    }
  );
  assert.equal(claim.coevolutionStructure, 'gene_for_gene');
});

test('coevolution_structure threads on a crop_vulnerabilities pathogen claim', () => {
  const claim = mapPayloadToClaim(
    { target_table: 'crop_vulnerabilities' },
    {
      pest_scientific_name: 'Phytophthora infestans',
      crop: 'Solanum tuberosum',
      damage_type: 'pathogen_pressure',
      coevolution_structure: 'quantitative',
      source_quote: 'partial field resistance was durable',
      regional_context: 'Global',
    }
  );
  assert.equal(claim.coevolutionStructure, 'quantitative');
});

test('readCoevolution accepts the vocab, nulls everything else', () => {
  assert.equal(readCoevolution({ coevolution_structure: 'gene_for_gene' }), 'gene_for_gene');
  assert.equal(readCoevolution({ coevolution_structure: 'quantitative' }), 'quantitative');
  assert.equal(readCoevolution({ coevolution_structure: 'unknown' }), 'unknown');
  assert.equal(readCoevolution({ coevolution_structure: 'vertical' }), null, 'non-vocab → null');
  assert.equal(readCoevolution({}), null, 'absent → null');
});
