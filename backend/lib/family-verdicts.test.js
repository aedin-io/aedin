'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verdictToRules } = require('./family-verdicts.js');

test('an exception-free assert verdict compiles to one family rule', () => {
  const rules = verdictToRules({
    family: 'Pucciniaceae', verdict: 'assert', role: 'pathogen_fungal',
    exceptions: [], confidence: 'high', reason: 'All members are rust fungi.',
  });

  assert.equal(rules.length, 1);
  assert.equal(rules[0].rule_type, 'taxonomy_family');
  assert.equal(rules[0].match_field, 'family');
  assert.equal(rules[0].match_value, 'pucciniaceae');
  assert.equal(rules[0].assigned_role, 'pathogen_fungal');
  assert.equal(rules[0].reason, 'All members are rust fungi.');
});

test('a verdict carrying exceptions is refused, not silently applied', () => {
  // role_rules cannot express "assert for the family EXCEPT these genera".
  // The only lever is a genus rule, and role-engine.js returns at the genus
  // tier BEFORE consulting claim evidence — so an exception rule would
  // suppress evidence-based classification for that genus. Refusing is
  // correct until the taxonomy graph can represent it as a deeper node.
  assert.throws(
    () => verdictToRules({
      family: 'Peronosporaceae', verdict: 'assert', role: 'pathogen_oomycete',
      exceptions: ['Halophytophthora', 'Nothophytophthora'],
      confidence: 'high', reason: 'Downy mildews are obligate biotrophs.',
    }),
    /cannot express/i,
  );
});

test('a not-assertable verdict yields no rules', () => {
  const rules = verdictToRules({
    family: 'Xylariaceae', verdict: 'not_assertable',
    reason: 'Dominated by wood- and litter-decay saprotrophs.',
  });
  assert.deepEqual(rules, []);
});
