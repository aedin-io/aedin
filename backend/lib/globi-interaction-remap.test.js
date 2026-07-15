'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { remapRow, POLLINATOR_FAMILIES, isLepidopteraFamily } = require('./globi-interaction-remap');

// ── Rule 1: pollinator feeding → pollination ──────────────────────────────────

test('Apidae eats plant (herbivory) → pollination — the canonical bug', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Apidae',
    object_bio_category: 'plantae', object_family: 'Asteraceae',
    raw_interaction_type: 'eats', interaction_category: 'herbivory',
  });
  assert.ok(r);
  assert.equal(r.action, 'recategorize');
  assert.equal(r.category, 'pollination');
  assert.equal(r.effect_direction, 'beneficial');
  assert.equal(r.rule_name, 'pollinator_feeding_to_pollination');
});

test('Nymphalidae (butterfly) eats plant → NO change — Lepidoptera "eats" is ambiguous (likely larval herbivory)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Nymphalidae',
    object_bio_category: 'plantae', object_family: 'Asteraceae',
    raw_interaction_type: 'eats', interaction_category: 'herbivory',
  });
  assert.equal(r, null, 'Lepidoptera excluded from eats→pollination; left as herbivory');
});

test('Geometridae (e.g. magpie moth, larval defoliator) eats plant → NO change', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Geometridae',
    object_bio_category: 'plantae', object_family: 'Rosaceae',
    raw_interaction_type: 'eats', interaction_category: 'herbivory',
  });
  assert.equal(r, null, 'real-world false-positive caught in Phase-A dry-run (Abraxas grossulariata)');
});

test('Apidae visitsFlowersOf plant already pollination → no change (no-op guard)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Apidae',
    object_bio_category: 'plantae', object_family: 'Asteraceae',
    raw_interaction_type: 'visitsFlowersOf', interaction_category: 'pollination',
  });
  assert.equal(r, null, 'already-correct rows are not touched');
});

test('non-pollinator invertebrate eats plant → no rule (stays herbivory)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Curculionidae', // weevils — real herbivores
    object_bio_category: 'plantae', object_family: 'Fabaceae',
    raw_interaction_type: 'eats', interaction_category: 'herbivory',
  });
  assert.equal(r, null, 'genuine herbivores are not reclassified');
});

test('bee bio-category present but no family → no rule (need family to confirm pollinator)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: null,
    object_bio_category: 'plantae', object_family: 'Asteraceae',
    raw_interaction_type: 'eats', interaction_category: 'herbivory',
  });
  assert.equal(r, null);
});

// ── Rule 2: gall family → gall_formation ──────────────────────────────────────

test('Cynipidae on plant → gall_formation', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Cynipidae',
    object_bio_category: 'plantae', object_family: 'Fagaceae',
    raw_interaction_type: 'eats', interaction_category: 'herbivory',
  });
  assert.equal(r.category, 'gall_formation');
  assert.equal(r.effect_direction, 'harmful');
});

// ── preysOn handling (Rule 3 was removed — all GloBI preysOn+herbivory rows
//    turned out to be fish grazing algae/seagrass = genuine herbivory) ─────────

test('preysOn+herbivory on a PLANT object → NO change (fish grazing algae is herbivory)', () => {
  const r = remapRow({
    subject_bio_category: 'vertebrate', subject_family: 'Pomacentridae', // damselfish
    object_bio_category: 'plantae', object_family: 'Rhodomelaceae',      // red algae
    raw_interaction_type: 'preysOn', interaction_category: 'herbivory',
  });
  assert.equal(r, null, 'grazing on algae/seagrass is correctly herbivory, not predation');
});

// ── Rule 3 (renumbered): plant-as-subject inversions → flip ───────────────────

test('plant visitsFlowersOf invertebrate-pollinator → flip to pollination', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Asteraceae',
    object_bio_category: 'invertebrate', object_family: 'Apidae',
    raw_interaction_type: 'visitsFlowersOf', interaction_category: 'pollination',
  });
  assert.equal(r.action, 'flip');
  assert.equal(r.category, 'pollination');
});

test('plant visitsFlowersOf non-pollinator → flip but unclassify (avoid wrong assertion)', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Asteraceae',
    object_bio_category: 'invertebrate', object_family: 'Formicidae', // ants — nectar thieves, poor pollinators
    raw_interaction_type: 'visitsFlowersOf', interaction_category: 'pollination',
  });
  assert.equal(r.action, 'flip');
  assert.equal(r.category, 'unclassified');
});

test('plant visitsFlowersOf Scoliidae → flip to pollination (anthophilous wasp; Phase-E correction)', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Araliaceae',
    object_bio_category: 'invertebrate', object_family: 'Scoliidae',
    raw_interaction_type: 'visitsFlowersOf', interaction_category: 'pollination',
  });
  assert.equal(r.action, 'flip');
  assert.equal(r.category, 'pollination', 'scoliid wasps are documented flower visitors');
});

test('plant pathogenOf invertebrate → NO flip (entomopathogenic algae like Helicosporidium are real)', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Chlorellaceae',
    object_bio_category: 'invertebrate', object_family: 'Pyralidae',
    raw_interaction_type: 'pathogenOf', interaction_category: 'pathogen_pressure',
  });
  assert.equal(r, null, 'pathogenOf removed from inversion verbs — Helicosporidium parasiticum is a genuine insect pathogen');
});

test('carnivorous plant preysOn insect → NO flip (Dionaea/Drosera genuinely prey)', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Droseraceae',
    object_bio_category: 'invertebrate', object_family: 'Calliphoridae',
    raw_interaction_type: 'preysOn', interaction_category: 'facilitation',
  });
  assert.equal(r, null, 'preysOn removed from inversion verbs — carnivorous plants are correct as plant-subject');
});

test('plant hasDispersalVector vertebrate → NO change (legitimate plant-subject framing)', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Rosaceae',
    object_bio_category: 'vertebrate', object_family: 'Turdidae',
    raw_interaction_type: 'hasDispersalVector', interaction_category: 'facilitation',
  });
  assert.equal(r, null, 'hasDispersalVector is correctly plant-as-subject');
});

test('plant hasVector vertebrate → NO change (canonical plant-virology framing)', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Solanaceae',
    object_bio_category: 'invertebrate', object_family: 'Aphididae',
    raw_interaction_type: 'hasVector', interaction_category: 'disease_vector',
  });
  assert.equal(r, null);
});

// ── No-match cases ─────────────────────────────────────────────────────────────

test('fungus hasHost plant → no change (already correct pathogen_pressure)', () => {
  const r = remapRow({
    subject_bio_category: 'fungi', subject_family: 'Erysiphaceae',
    object_bio_category: 'plantae', object_family: 'Cucurbitaceae',
    raw_interaction_type: 'hasHost', interaction_category: 'pathogen_pressure',
  });
  assert.equal(r, null);
});

test('vertebrate eats plant → no change (genuine herbivory: deer, etc.)', () => {
  const r = remapRow({
    subject_bio_category: 'vertebrate', subject_family: 'Cervidae',
    object_bio_category: 'plantae', object_family: 'Fabaceae',
    raw_interaction_type: 'eats', interaction_category: 'herbivory',
  });
  assert.equal(r, null);
});

// ── Phase-G rules ────────────────────────────────────────────────────────────

test('Rule 4: AMF (Glomeromycota) hasHost plant labeled pathogen → mycorrhizal [sign-inversion]', () => {
  const r = remapRow({
    subject_bio_category: 'fungi', subject_family: 'Glomeraceae',
    subject_scientific_name: 'Paraglomus occultum',
    object_bio_category: 'plantae', object_family: 'Poaceae',
    raw_interaction_type: 'hasHost', interaction_category: 'pathogen_pressure',
  });
  assert.ok(r);
  assert.equal(r.category, 'mycorrhizal');
  assert.equal(r.effect_direction, 'beneficial');
  assert.equal(r.rule_name, 'amf_haspathogen_to_mycorrhizal');
});

test('Rule 4 negative: a genuine fungal pathogen hasHost → NO change', () => {
  const r = remapRow({
    subject_bio_category: 'fungi', subject_family: 'Nectriaceae',
    subject_scientific_name: 'Fusarium oxysporum',
    object_bio_category: 'plantae', object_family: 'Solanaceae',
    raw_interaction_type: 'hasHost', interaction_category: 'pathogen_pressure',
  });
  assert.equal(r, null, 'non-AMF genus stays pathogen_pressure');
});

test('Rule 5: plant hasVector fruit-bat labeled disease_vector → seed_dispersal [sign-inversion]', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Piperaceae',
    subject_scientific_name: 'Piper amalago',
    object_bio_category: 'vertebrate', object_family: 'Phyllostomidae',
    raw_interaction_type: 'hasVector', interaction_category: 'disease_vector',
  });
  assert.equal(r.category, 'seed_dispersal');
  assert.equal(r.effect_direction, 'beneficial');
  assert.equal(r.action, 'recategorize', 'plant-subject framing is correct — no flip');
});

test('Rule 5 negative: plant hasVector INVERTEBRATE stays disease_vector (aphid→virus)', () => {
  const r = remapRow({
    subject_bio_category: 'plantae', subject_family: 'Solanaceae',
    object_bio_category: 'invertebrate', object_family: 'Aphididae',
    raw_interaction_type: 'hasVector', interaction_category: 'disease_vector',
  });
  assert.equal(r, null, 'invertebrate hasVector is a genuine disease vector');
});

test('Rule 6: fungi labeled pollination → unclassified (impossible)', () => {
  const r = remapRow({
    subject_bio_category: 'fungi', subject_family: 'Mycosphaerellaceae',
    object_bio_category: 'plantae', object_family: 'Asteraceae',
    raw_interaction_type: 'visitsFlowersOf', interaction_category: 'pollination',
  });
  assert.equal(r.category, 'unclassified');
});

test('Rule 7: bee mutualistOf plant → pollination (precise category)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Halictidae',
    object_bio_category: 'plantae', object_family: 'Crassulaceae',
    raw_interaction_type: 'mutualistOf', interaction_category: 'mutualism',
  });
  assert.equal(r.category, 'pollination');
});

test('Rule 8: non-pollinator visits plant → flower_visitor (demote over-credited pollination)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Formicidae', // ants
    object_bio_category: 'plantae', object_family: 'Cactaceae',
    raw_interaction_type: 'visits', interaction_category: 'pollination',
  });
  assert.equal(r.category, 'flower_visitor');
});

test('Rule 8 negative: bee visits plant stays pollination (recognized pollinator family)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Apidae',
    object_bio_category: 'plantae', object_family: 'Asteraceae',
    raw_interaction_type: 'visits', interaction_category: 'pollination',
  });
  assert.equal(r, null, 'bee visits → keep pollination');
});

test('Rule 8 negative: butterfly visits plant stays pollination (broad pollinator set)', () => {
  const r = remapRow({
    subject_bio_category: 'invertebrate', subject_family: 'Nymphalidae',
    object_bio_category: 'plantae', object_family: 'Asteraceae',
    raw_interaction_type: 'visits', interaction_category: 'pollination',
  });
  assert.equal(r, null, 'Lepidoptera are in POLLINATOR_FAMILIES — visits stays pollination');
});

// ── Helper sanity ───────────────────────────────────────────────────────────────

test('POLLINATOR_FAMILIES includes core bee + butterfly families', () => {
  ['Apidae', 'Halictidae', 'Syrphidae', 'Nymphalidae', 'Hesperiidae'].forEach(f =>
    assert.ok(POLLINATOR_FAMILIES.has(f), `${f} should be a pollinator family`));
});

test('isLepidopteraFamily discriminates Lep from bees', () => {
  assert.equal(isLepidopteraFamily('Nymphalidae'), true);
  assert.equal(isLepidopteraFamily('Apidae'), false);
});
