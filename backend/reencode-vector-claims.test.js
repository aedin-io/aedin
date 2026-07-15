'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planActions } = require('./reencode-vector-claims');

const rows = [
  { id: 1, interaction_category: 'pathogen_pressure', interaction_type_globi: 'vectorOf', review_status: 'ai_reviewed', subject_entity_id: 10, object_entity_id: 20 },
  { id: 2, interaction_category: 'pest_pressure', interaction_type_globi: 'vectorOf', review_status: 'ai_reviewed', subject_entity_id: 11, object_entity_id: 21 },
  { id: 3, interaction_category: 'pathogen_pressure', interaction_type_globi: 'vectorOf', review_status: 'ai_reviewed', subject_entity_id: 12, object_entity_id: 22 },
  { id: 4, interaction_category: 'disease_vector', interaction_type_globi: 'vectorOf', review_status: 'ai_reviewed', subject_entity_id: 13, object_entity_id: 23 },
  { id: 5, interaction_category: 'pathogen_pressure', interaction_type_globi: 'pathogenOf', review_status: 'ai_reviewed', subject_entity_id: 14, object_entity_id: 24 },
  { id: 6, interaction_category: 'disease_vector', interaction_type_globi: 'vectorOf', review_status: 'ai_reviewed', subject_entity_id: 15, object_entity_id: 99 },
];

test('flip sets disease_vector + vectorOf and records before-state', () => {
  const { updates } = planActions(rows, { 1: { action: 'flip' } });
  const u = updates.find(x => x.id === 1);
  assert.equal(u.set.interaction_category, 'disease_vector');
  assert.equal(u.set.interaction_type_globi, 'vectorOf');
  assert.equal(u.before.interaction_category, 'pathogen_pressure');
});

test('quarantine sets review_status from the reason', () => {
  const { updates } = planActions(rows, { 3: { action: 'quarantine', reason: 'negated' } });
  assert.equal(updates.find(x => x.id === 3).set.review_status, 'quarantined_negated');
});

test('already-disease_vector is skipped (idempotent)', () => {
  const { updates, skipped } = planActions(rows, { 4: { action: 'flip' } });
  assert.equal(updates.length, 0);
  assert.ok(skipped.some(s => s.id === 4));
});

test('a decision id absent from rows is skipped, not thrown', () => {
  const { skipped } = planActions(rows, { 999: { action: 'flip' } });
  assert.ok(skipped.some(s => s.id === 999));
});

test('unknown action is skipped with a reason', () => {
  const { skipped } = planActions(rows, { 2: { action: 'frobnicate' } });
  assert.ok(skipped.some(s => s.id === 2 && /unknown action/i.test(s.why)));
});

// Phase 2b: repoint + repurpose
test('repoint sets object_entity_id→pathogenId + disease_vector + vectorOf and records before-state', () => {
  const { updates, skipped } = planActions(rows, { 1: { action: 'repoint', pathogenId: 55 } });
  assert.equal(skipped.length, 0);
  const u = updates.find(x => x.id === 1);
  assert.ok(u, 'should produce an update');
  assert.equal(u.set.object_entity_id, 55);
  assert.equal(u.set.interaction_category, 'disease_vector');
  assert.equal(u.set.interaction_type_globi, 'vectorOf');
  assert.equal(u.before.object_entity_id, 20);
  assert.equal(u.before.interaction_category, 'pathogen_pressure');
  assert.equal(u.before.interaction_type_globi, 'vectorOf');
});

test('repurpose sets subject_entity_id→pathogenId + pathogen_pressure + pathogenOf and records before-state', () => {
  const { updates, skipped } = planActions(rows, { 2: { action: 'repurpose', pathogenId: 77 } });
  assert.equal(skipped.length, 0);
  const u = updates.find(x => x.id === 2);
  assert.ok(u, 'should produce an update');
  assert.equal(u.set.subject_entity_id, 77);
  assert.equal(u.set.interaction_category, 'pathogen_pressure');
  assert.equal(u.set.interaction_type_globi, 'pathogenOf');
  assert.equal(u.before.subject_entity_id, 11);
  assert.equal(u.before.interaction_category, 'pest_pressure');
  assert.equal(u.before.interaction_type_globi, 'vectorOf');
});

test('repoint with missing pathogenId is skipped with a reason', () => {
  const { updates, skipped } = planActions(rows, { 1: { action: 'repoint' } });
  assert.equal(updates.length, 0);
  assert.ok(skipped.some(s => s.id === 1 && /pathogenId/i.test(s.why)));
});

test('repurpose with non-number pathogenId is skipped with a reason', () => {
  const { updates, skipped } = planActions(rows, { 2: { action: 'repurpose', pathogenId: 'bad' } });
  assert.equal(updates.length, 0);
  assert.ok(skipped.some(s => s.id === 2 && /pathogenId/i.test(s.why)));
});

test('repoint is idempotent when object_entity_id already equals pathogenId and category already disease_vector', () => {
  // row 6: object_entity_id=99, interaction_category='disease_vector'
  const { updates, skipped } = planActions(rows, { 6: { action: 'repoint', pathogenId: 99 } });
  assert.equal(updates.length, 0);
  assert.ok(skipped.some(s => s.id === 6));
});

test('repurpose is idempotent when subject_entity_id already equals pathogenId and category already pathogen_pressure', () => {
  // row 5: subject_entity_id=14, interaction_category='pathogen_pressure'
  const { updates, skipped } = planActions(rows, { 5: { action: 'repurpose', pathogenId: 14 } });
  assert.equal(updates.length, 0);
  assert.ok(skipped.some(s => s.id === 5));
});
