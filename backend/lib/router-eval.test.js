'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scoreRouter } = require('./router-eval');

test('scoreRouter counts correct vs incorrect against expected_critic', () => {
  const fixtures = [
    { id: 'a', payload: {}, target_table: 'interactions', expected_critic: 'entomologist' },
    { id: 'b', payload: {}, target_table: 'interactions', expected_critic: 'soil-scientist' },
  ];
  const routeFn = () => 'entomologist'; // always entomologist
  const r = scoreRouter(fixtures, routeFn);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.correct, 1);
  assert.strictEqual(r.incorrect, 1);
  assert.strictEqual(r.accuracy, 0.5);
  assert.deepStrictEqual(r.cases.map(c => c.ok), [true, false]);
});

test('scoreRouter returns null accuracy for empty fixtures', () => {
  const r = scoreRouter([], () => 'horticulturist');
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.accuracy, null);
});

const { recusalRate } = require('./router-eval');

test('recusalRate flags routed critic out_of_scope verdicts, skips unjudged', () => {
  const rows = [
    { id: 1, payload: {}, target_table: 'interactions', verdicts: { entomologist: 'plausible' } },
    { id: 2, payload: {}, target_table: 'interactions', verdicts: { entomologist: 'out_of_scope' } },
    { id: 3, payload: {}, target_table: 'interactions', verdicts: { 'soil-scientist': 'plausible' } }, // no entomologist verdict → skipped
  ];
  const routeFn = () => 'entomologist';
  const r = recusalRate(rows, routeFn);
  assert.strictEqual(r.judged, 2);
  assert.strictEqual(r.recused, 1);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.rate, 0.5);
  assert.deepStrictEqual(r.recusedCases, [{ id: 2, critic: 'entomologist' }]);
});

test('recusalRate returns null rate when nothing is judged', () => {
  const r = recusalRate([], () => 'entomologist');
  assert.strictEqual(r.judged, 0);
  assert.strictEqual(r.rate, null);
});

test('recusalRate integrates with the real router on a clear arthropod claim', () => {
  const { pickDomainCritic } = require('./critic-router');
  const rows = [{
    id: 99,
    payload: { interaction_category: 'herbivory', subject_name: 'Aphis gossypii', object_name: 'Cucumis sativus' },
    target_table: 'interactions',
    verdicts: { entomologist: 'plausible' },
  }];
  const r = recusalRate(rows, pickDomainCritic);
  assert.strictEqual(r.judged, 1);
  assert.strictEqual(r.recused, 0);
});

const fs = require('node:fs');
const path = require('node:path');
const { pickDomainCritic } = require('./critic-router');

const BACKLOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'router-backlog.json'), 'utf8')
);

test('backlog guards route correctly (regression)', () => {
  const guards = BACKLOG.filter(f => f.status === 'guard');
  assert.ok(guards.length >= 3, 'expected at least 3 guard fixtures');
  for (const f of guards) {
    assert.strictEqual(
      pickDomainCritic(f.payload, f.target_table), f.expected_critic,
      `guard ${f.id} should route to ${f.expected_critic}`
    );
  }
});

test('backlog open cases currently misroute (characterization — flip to guard when fixed)', () => {
  const open = BACKLOG.filter(f => f.status === 'open');
  assert.ok(open.length >= 1, 'expected at least one open backlog target for the evolution loop');
  for (const f of open) {
    const actual = pickDomainCritic(f.payload, f.target_table);
    assert.notStrictEqual(
      actual, f.expected_critic,
      `open ${f.id} now routes correctly — the fix landed; reclassify it as a guard and update the graduation ledger`
    );
  }
});
