import test from 'node:test';
import assert from 'node:assert/strict';
import { composeClaimSentence } from './claim-sentence.ts';

test('maps known categories to natural verbs', () => {
  assert.equal(composeClaimSentence('pest_pressure', 'Pumpkin beetle', 'Bottle gourd'),
    'Pumpkin beetle is a pest of Bottle gourd');
  assert.equal(composeClaimSentence('pathogen_pressure', 'Botrytis', 'Lettuce'),
    'Botrytis is a pathogen of Lettuce');
  assert.equal(composeClaimSentence('mutualism', 'Ant', 'Mealybug'),
    'Ant has a mutualistic relationship with Mealybug');
});

test('falls back to de-underscored category for unknown categories', () => {
  assert.equal(composeClaimSentence('some_new_category', 'A', 'B'), 'A some new category B');
});

test('handles a missing category', () => {
  assert.equal(composeClaimSentence(null, 'A', 'B'), 'A interacts with B');
});

test('handles a missing object', () => {
  assert.equal(composeClaimSentence('pest_pressure', 'Pumpkin beetle', null),
    'Pumpkin beetle — is a pest of');
});

test('handles a missing subject', () => {
  assert.equal(composeClaimSentence('herbivory', null, 'Cabbage'),
    'This organism feeds on Cabbage');
});
