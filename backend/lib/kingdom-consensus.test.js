'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consensusFor } = require('./kingdom-consensus.js');

const v = (verdict, correct_value, confidence = 'high') => ({ verdict, correct_value, confidence });

test('a majority naming the SAME value confirms it', () => {
  const r = consensusFor({ ours: 'plantae', ottProposes: 'fungi' },
    [v('ott_correct', 'fungi'), v('ott_correct', 'fungi'), v('abstain', null)]);
  assert.deepEqual(r, { outcome: 'confirmed', value: 'fungi', votes: 2, dissent: 0 });
});

test('ANY dissent naming a different value blocks, even with a majority', () => {
  // Ambiguity beats false identification: a critic actively naming a different
  // organism is evidence of a genus collision, not noise to be outvoted.
  const r = consensusFor({ ours: 'invertebrate', ottProposes: 'fungi' },
    [v('ott_correct', 'fungi'), v('ott_correct', 'fungi'), v('ours_correct', 'invertebrate')]);
  assert.equal(r.outcome, 'disputed');
  assert.equal(r.dissent, 1);
});

test('critics agreeing on a THIRD value confirm that value, not OTT', () => {
  const r = consensusFor({ ours: 'plantae', ottProposes: 'fungi' },
    [v('neither', 'microbe'), v('neither', 'microbe'), v('abstain', null)]);
  assert.deepEqual(r, { outcome: 'confirmed', value: 'microbe', votes: 2, dissent: 0 });
});

test('one lone vote is not a majority', () => {
  const r = consensusFor({ ours: 'plantae', ottProposes: 'fungi' },
    [v('ott_correct', 'fungi'), v('abstain', null), v('abstain', null)]);
  assert.equal(r.outcome, 'insufficient');
});

test('all abstain yields no action', () => {
  const r = consensusFor({ ours: 'plantae', ottProposes: 'fungi' },
    [v('abstain', null), v('abstain', null), v('abstain', null)]);
  assert.equal(r.outcome, 'insufficient');
});

test('a majority confirming OUR value needs no write', () => {
  const r = consensusFor({ ours: 'invertebrate', ottProposes: 'fungi' },
    [v('ours_correct', 'invertebrate'), v('ours_correct', 'invertebrate'), v('abstain', null)]);
  assert.equal(r.outcome, 'confirmed');
  assert.equal(r.value, 'invertebrate', 'caller must skip the UPDATE when value === ours');
});

test('low-confidence votes do not count toward a majority', () => {
  const r = consensusFor({ ours: 'plantae', ottProposes: 'fungi' },
    [v('ott_correct', 'fungi', 'low'), v('ott_correct', 'fungi'), v('abstain', null)]);
  assert.equal(r.outcome, 'insufficient');
});
