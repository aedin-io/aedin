'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pickDomainCritic, ALL_CRITICS, ALL_DOMAIN_CRITICS } = require('./critic-router');

test('exports', () => {
  assert.deepStrictEqual(ALL_DOMAIN_CRITICS, ['entomologist', 'plant-pathologist', 'soil-scientist', 'horticulturist', 'wildlife-ecologist']);
  assert.deepStrictEqual(ALL_CRITICS, ['agroecologist', 'entomologist', 'plant-pathologist', 'soil-scientist', 'horticulturist', 'wildlife-ecologist']);
});

test('cooperative interactions route by mechanism, not the named microbe', () => {
  // companion planting / polyculture facilitation → horticulturist
  assert.strictEqual(pickDomainCritic({ interaction_category: 'facilitation', subject: { name: 'Allium cepa' }, object: { name: 'Daucus carota' } }), 'horticulturist');
  // N-fixation / mycorrhizal cooperation → soil-scientist (even though a fungus/bacterium is named)
  assert.strictEqual(pickDomainCritic({ interaction_category: 'facilitation', subject: { name: 'Fabaceae' }, object: { name: 'Zea mays' }, mechanism: 'nitrogen fixation' }), 'soil-scientist');
  assert.strictEqual(pickDomainCritic({ interaction_category: 'mutualism', subject: { name: 'Glomus intraradices' }, object: { name: 'Triticum aestivum' }, note: 'arbuscular mycorrhiza' }), 'soil-scientist');
  // pollination mutualism → entomology (the animal partner owns it)
  assert.strictEqual(pickDomainCritic({ interaction_category: 'mutualism', subject: { name: 'Bombus terrestris' }, object: { name: 'Trifolium pratense' }, note: 'pollination' }), 'entomologist');
  // biocontrol → entomology even with a fungal agent named
  assert.strictEqual(pickDomainCritic({ interaction_category: 'biocontrol', subject: { name: 'Beauveria bassiana' }, object: { name: 'Spodoptera litura' } }), 'entomologist');
});

test('pathogen interaction → plant-pathologist', () => {
  assert.strictEqual(pickDomainCritic({ interaction_category: 'pathogen' }), 'plant-pathologist');
  assert.strictEqual(pickDomainCritic({ interaction_type: 'pathogenOf' }), 'plant-pathologist');
  assert.strictEqual(pickDomainCritic({ interaction_category: 'infection' }), 'plant-pathologist');
});

test('virus / phage / fungus name → plant-pathologist', () => {
  assert.strictEqual(pickDomainCritic({ subject: { name: 'Citrus tristeza virus' } }), 'plant-pathologist');
  assert.strictEqual(pickDomainCritic({ object: { name: 'Cydia pomonella granulovirus' } }), 'plant-pathologist');
  assert.strictEqual(pickDomainCritic({ object: { name: 'Fusarium oxysporum' } }), 'plant-pathologist');
});

test('pathology dominates entomology when both present (entomopathogen)', () => {
  // Caterpillar + virus → pathologist owns the host-pathogen call.
  assert.strictEqual(
    pickDomainCritic({
      interaction_category: 'parasitism',
      subject: { name: 'Pieris rapae caterpillar' },
      object: { name: 'Pieris rapae granulovirus' },
    }),
    'plant-pathologist'
  );
});

test('mycorrhiza / nitrogen-fixation → soil-scientist', () => {
  assert.strictEqual(pickDomainCritic({ interaction_category: 'mycorrhizal' }), 'soil-scientist');
  assert.strictEqual(pickDomainCritic({ interaction_category: 'nitrogen_fixation' }), 'soil-scientist');
  assert.strictEqual(
    pickDomainCritic({ bio_category: 'microbe', primary_role: 'rhizobial' }),
    'soil-scientist'
  );
});

test('soil/nutrient/cover-crop body terms → soil-scientist', () => {
  assert.strictEqual(
    pickDomainCritic({ source_quote: 'cover crop reduces soil nitrogen leaching' }),
    'soil-scientist'
  );
  assert.strictEqual(
    pickDomainCritic({ mechanism: 'increases cation exchange capacity' }),
    'soil-scientist'
  );
});

test('arthropod predation/parasitism/herbivory → entomologist', () => {
  assert.strictEqual(pickDomainCritic({ interaction_category: 'predation' }), 'entomologist');
  assert.strictEqual(pickDomainCritic({ interaction_category: 'herbivory' }), 'entomologist');
  assert.strictEqual(pickDomainCritic({ interaction_type: 'biocontrol', subject: { name: 'Coccinella septempunctata' } }), 'entomologist');
});

test('arthropod-name-only routes to entomologist', () => {
  assert.strictEqual(
    pickDomainCritic({ subject: { name: 'Aphis gossypii' } }),
    'entomologist'
  );
});

test('plant-only pollination → horticulturist (no arthropod marker)', () => {
  // wind pollination, no animal involved
  assert.strictEqual(
    pickDomainCritic({ interaction_category: 'pollination', subject: { name: 'Zea mays' } }),
    'horticulturist'
  );
});

test('animal pollinator → entomologist', () => {
  assert.strictEqual(
    pickDomainCritic({ interaction_category: 'pollination', subject: { name: 'Apis mellifera' } }),
    'entomologist'
  );
});

test('crop_vulnerabilities target_table → horticulturist when no other signal', () => {
  assert.strictEqual(
    pickDomainCritic({ crop: 'Tomato' }, 'crop_vulnerabilities'),
    'horticulturist'
  );
});

test('crop trait body terms → horticulturist', () => {
  assert.strictEqual(
    pickDomainCritic({ source_quote: 'days to harvest is reduced under high light' }),
    'horticulturist'
  );
});

test('empty payload → horticulturist (broadest fallback)', () => {
  assert.strictEqual(pickDomainCritic({}), 'horticulturist');
});

test('null/undefined payload does not throw', () => {
  assert.strictEqual(pickDomainCritic(null), 'horticulturist');
  assert.strictEqual(pickDomainCritic(undefined), 'horticulturist');
});

test('entity_trait: plantae → horticulturist', () => {
  assert.equal(pickDomainCritic({ bio_category: 'plantae' }, 'entity_trait'), 'horticulturist');
});

test('entity_trait: invertebrate → entomologist', () => {
  assert.equal(pickDomainCritic({ bio_category: 'invertebrate' }, 'entity_trait'), 'entomologist');
});

test('entity_trait: vertebrate → wildlife-ecologist', () => {
  assert.equal(pickDomainCritic({ bio_category: 'vertebrate' }, 'entity_trait'), 'wildlife-ecologist');
});

test('entity_trait: fungi → plant-pathologist', () => {
  assert.equal(pickDomainCritic({ bio_category: 'fungi' }, 'entity_trait'), 'plant-pathologist');
});

test('entity_trait: microbe + soil_health_function → soil-scientist', () => {
  assert.equal(pickDomainCritic({ bio_category: 'microbe', trait_name: 'soil_health_function' }, 'entity_trait'),
    'soil-scientist');
});

test('entity_trait: microbe + nitrogen_fixation_rate_kg_per_ha_per_yr → soil-scientist', () => {
  assert.equal(pickDomainCritic({ bio_category: 'microbe', trait_name: 'nitrogen_fixation_rate_kg_per_ha_per_yr' }, 'entity_trait'),
    'soil-scientist');
});

test('entity_trait: microbe (other / pathogen) → plant-pathologist', () => {
  assert.equal(pickDomainCritic({ bio_category: 'microbe', trait_name: 'transmission_mode' }, 'entity_trait'),
    'plant-pathologist');
});

test('attractor_relationship → entomologist (object always beneficial arthropod)', () => {
  assert.equal(pickDomainCritic({}, 'attractor_relationship'), 'entomologist');
});

// --- Pass-13 mis-route fixes (docs/phase-3-passlog.md Pass 13 post-mortem #3) ---

test('plant-parasitic nematodes → plant-pathologist (not entomologist)', () => {
  // a 'parasitism' interaction otherwise grabs the entomologist
  assert.equal(pickDomainCritic({ subject_name: 'Meloidogyne incognita', object_name: 'Solanum lycopersicum', interaction_category: 'parasitism' }, 'interactions'), 'plant-pathologist');
  assert.equal(pickDomainCritic({ pest_name: 'Radopholus similis', crop_name: 'banana', interaction_category: 'pest_pressure' }, 'crop_vulnerabilities'), 'plant-pathologist');
  assert.equal(pickDomainCritic({ pest_name: 'Rotylenchulus reniformis', crop_name: 'pepper' }, 'crop_vulnerabilities'), 'plant-pathologist');
  // even when the extractor mis-tags the nematode as an invertebrate trait
  assert.equal(pickDomainCritic({ scientific_name: 'Meloidogyne javanica', trait_name: 'host_range', bio_category: 'invertebrate' }, 'entity_trait'), 'plant-pathologist');
});

test('parasitic plants (dodder) → plant-pathologist (not entomologist)', () => {
  assert.equal(pickDomainCritic({ subject_name: 'Cuscuta campestris', object_name: 'tomato', interaction_category: 'parasitism' }, 'interactions'), 'plant-pathologist');
  assert.equal(pickDomainCritic({ subject_name: 'Cassytha filiformis', object_name: 'eggplant', interaction_category: 'parasitism' }, 'interactions'), 'plant-pathologist');
});

test('insect crop_vulnerability with off-list genus → entomologist (not horticulturist fallback)', () => {
  assert.equal(pickDomainCritic({ pest_name: 'Halticus tibialis', crop_name: 'cabbage', interaction_category: 'pest_pressure' }, 'crop_vulnerabilities'), 'entomologist');
  assert.equal(pickDomainCritic({ pest_name: 'Aulacophora foveicollis', crop_name: 'cucumber', interaction_category: 'pest_pressure' }, 'crop_vulnerabilities'), 'entomologist');
  assert.equal(pickDomainCritic({ pest_name: 'Nezara viridula', crop_name: 'tomato', interaction_category: 'pest_pressure' }, 'crop_vulnerabilities'), 'entomologist');
  assert.equal(pickDomainCritic({ pest_name: 'Leptoglossus gonagra', crop_name: 'cucumber', interaction_category: 'pest_pressure' }, 'crop_vulnerabilities'), 'entomologist');
});

test('REGRESSION: pathogen still wins; nematode override is additive not destructive', () => {
  // microbe biocontrol of a nematode — pseudomonas already routed to pathology; stays.
  assert.equal(pickDomainCritic({ subject_name: 'Pseudomonas fluorescens', object_name: 'Meloidogyne incognita', interaction_category: 'biocontrol' }, 'interactions'), 'plant-pathologist');
  // plain crop_vuln with no pest taxon still falls to horticulturist
  assert.equal(pickDomainCritic({ crop: 'Tomato' }, 'crop_vulnerabilities'), 'horticulturist');
});

// --- Pass-13 follow-ups: entity_trait name safety-nets ---

test('entity_trait: arthropod-named (wrong/missing bio_category) → entomologist, not horticulturist', () => {
  // spider family habitat trait, bio_category mislabeled 'other'
  assert.equal(pickDomainCritic({ scientific_name: 'Salticidae', trait_name: 'habitat_type', bio_category: 'other' }, 'entity_trait'), 'entomologist');
  assert.equal(pickDomainCritic({ scientific_name: 'Lycosidae', trait_name: 'habitat_type' }, 'entity_trait'), 'entomologist');
});

test('entity_trait: entomopathogen microbe (Bt) → entomologist, not plant-pathologist', () => {
  assert.equal(pickDomainCritic({ scientific_name: 'Bacillus thuringiensis', trait_name: 'target_pest_range', bio_category: 'microbe' }, 'entity_trait'), 'entomologist');
  assert.equal(pickDomainCritic({ scientific_name: 'Beauveria bassiana', trait_name: 'commercial_biocontrol', bio_category: 'microbe' }, 'entity_trait'), 'entomologist');
});

test('REGRESSION: entity_trait plant/fungus/soil-microbe routing unchanged', () => {
  // plant trait still horticulturist (name net only fires when bio_category gives no answer)
  assert.equal(pickDomainCritic({ scientific_name: 'tomato', trait_name: 'ph_min', bio_category: 'plantae' }, 'entity_trait'), 'horticulturist');
  // non-entomopathogen microbe trait still plant-pathologist
  assert.equal(pickDomainCritic({ scientific_name: 'Ralstonia solanacearum', trait_name: 'host_range', bio_category: 'microbe' }, 'entity_trait'), 'plant-pathologist');
  // N-fixing soil microbe still soil-scientist
  assert.equal(pickDomainCritic({ scientific_name: 'Bradyrhizobium', trait_name: 'soil_health_function', bio_category: 'microbe' }, 'entity_trait'), 'soil-scientist');
  // plain plant entity_trait with no arthropod mention still horticulturist
  assert.equal(pickDomainCritic({ scientific_name: 'Cucurbita pepo', trait_name: 'days_to_harvest', bio_category: 'other' }, 'entity_trait'), 'horticulturist');
});

// --- wildlife-ecologist critic (2026-06-13): vertebrate actor-taxon-owns ---

test('vertebrate pest → wildlife-ecologist (interactions + crop_vulnerabilities)', () => {
  assert.equal(pickDomainCritic({ subject_name: 'Rattus rattus', object_name: 'Oryza sativa', interaction_category: 'pest_pressure' }, 'interactions'), 'wildlife-ecologist');
  assert.equal(pickDomainCritic({ pest_name: 'Rattus argentiventer', crop_name: 'rice', interaction_category: 'pest_pressure' }, 'crop_vulnerabilities'), 'wildlife-ecologist');
  // Quelea — major granivorous bird pest of cereals
  assert.equal(pickDomainCritic({ pest_name: 'Quelea quelea', crop_name: 'sorghum', interaction_category: 'pest_pressure' }, 'crop_vulnerabilities'), 'wildlife-ecologist');
  // deer browsing
  assert.equal(pickDomainCritic({ subject_name: 'Odocoileus virginianus', object_name: 'Glycine max', interaction_category: 'herbivory' }, 'interactions'), 'wildlife-ecologist');
});

test('vertebrate-on-arthropod → wildlife-ecologist (actor-taxon owns, NOT entomologist)', () => {
  // insectivorous bird preying on aphids — the vertebrate actor owns it
  assert.equal(pickDomainCritic({ subject_name: 'Sturnus vulgaris', object_name: 'Aphis gossypii', interaction_category: 'predation' }, 'interactions'), 'wildlife-ecologist');
  // insectivorous bat biocontrol of a moth
  assert.equal(pickDomainCritic({ subject_name: 'Tadarida brasiliensis', object_name: 'Helicoverpa zea', interaction_category: 'biocontrol' }, 'interactions'), 'wildlife-ecologist');
});

test('vertebrate pollination / seed dispersal → wildlife-ecologist', () => {
  // the Pteropus → Ficus case that motivated the critic
  assert.equal(pickDomainCritic({ subject_name: 'Pteropus dasymallus', object_name: 'Ficus variegata', interaction_category: 'seed_dispersal' }, 'interactions'), 'wildlife-ecologist');
  // nectarivorous bat pollination
  assert.equal(pickDomainCritic({ subject_name: 'Leptonycteris yerbabuenae', object_name: 'Agave tequilana', interaction_category: 'pollination' }, 'interactions'), 'wildlife-ecologist');
});

test('attractor supporting a vertebrate beneficial → wildlife-ecologist', () => {
  assert.equal(pickDomainCritic({ subject_organism: 'hedgerow', object_organism: 'insectivorous birds', interaction_category: 'provides_refuge' }, 'attractor_relationship'), 'wildlife-ecologist');
  // arthropod-supported attractor still entomologist
  assert.equal(pickDomainCritic({ subject_organism: 'Fagopyrum esculentum', object_organism: 'Chrysoperla carnea', interaction_category: 'nectar_provision' }, 'attractor_relationship'), 'entomologist');
});

test('REGRESSION: vertebrate HOST of a pathogen still → plant-pathologist', () => {
  // a vertebrate reservoir of a virus — the disease call dominates, not wildlife
  assert.equal(pickDomainCritic({ subject_name: 'Pteropus', object_name: 'Nipah virus', interaction_category: 'pathogen' }, 'interactions'), 'plant-pathologist');
});

test('REGRESSION: arthropod & wind-pollination routing unaffected by vertebrate gate', () => {
  assert.equal(pickDomainCritic({ interaction_category: 'predation', subject: { name: 'Coccinella septempunctata' }, object: { name: 'Aphis gossypii' } }), 'entomologist');
  assert.equal(pickDomainCritic({ interaction_category: 'pollination', subject: { name: 'Apis mellifera' } }), 'entomologist');
  assert.equal(pickDomainCritic({ interaction_category: 'pollination', subject: { name: 'Zea mays' } }), 'horticulturist');
});
