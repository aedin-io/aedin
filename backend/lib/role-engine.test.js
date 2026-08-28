'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preloadRules, evaluateRules } = require('./role-engine.js');

// evaluateRules only ever calls db.all via preloadRules, so a list stands in.
const fakeDb = (rules) => ({ all: async () => rules });
let nextId = 1;
const rule = (rule_type, match_value, assigned_role, priority) => ({
  id: nextId++, rule_type, match_value, assigned_role, secondary_role: null,
  confidence: 1, priority, reason: 'test', enabled: 1, match_bio_category: null,
});

// Rules arrive from SQL already sorted by priority DESC, so mirror that.
const load = async (rules) => preloadRules(fakeDb([...rules].sort((a, b) => b.priority - a.priority)));

test('a subfamily rule matches an entity by its subfamily', async () => {
  const cache = await load([rule('taxonomy_subfamily', 'lymantriinae', 'pest_insect', 60)]);
  const r = await evaluateRules(null, { scientific_name: 'Orgyia leucostigma', family: 'Erebidae', subfamily: 'Lymantriinae' }, null, cache);
  assert.equal(r.assignedRole, 'pest_insect');
});

test('subfamily BEATS family — it is the finer, contradicting fact', async () => {
  // Miletinae larvae are predators inside herbivorous Lycaenidae. If family won,
  // the rule store could never express the correction at all.
  const cache = await load([
    rule('taxonomy_family', 'lycaenidae', 'pest_insect', 50),
    rule('taxonomy_subfamily', 'miletinae', 'biocontrol', 60),
  ]);
  const r = await evaluateRules(null, { scientific_name: 'Spalgis epius', family: 'Lycaenidae', subfamily: 'Miletinae' }, null, cache);
  assert.equal(r.assignedRole, 'biocontrol');
});

test('genus still beats subfamily', async () => {
  const cache = await load([
    rule('taxonomy_subfamily', 'miletinae', 'biocontrol', 60),
    rule('taxonomy_genus', 'spalgis', 'beneficial_predator', 70),
  ]);
  const r = await evaluateRules(null, { scientific_name: 'Spalgis epius', genus: 'Spalgis', family: 'Lycaenidae', subfamily: 'Miletinae' }, null, cache);
  assert.equal(r.assignedRole, 'beneficial_predator');
});

test('an entity with no subfamily falls through to its family rule', async () => {
  // subfamily is NULL for ~94k entities because OTT carries none for them. That
  // must not suppress the family rule they would otherwise have matched.
  const cache = await load([
    rule('taxonomy_family', 'lycaenidae', 'pest_insect', 50),
    rule('taxonomy_subfamily', 'miletinae', 'biocontrol', 60),
  ]);
  const r = await evaluateRules(null, { scientific_name: 'Some lycaenid', family: 'Lycaenidae', subfamily: null }, null, cache);
  assert.equal(r.assignedRole, 'pest_insect');
});

test('a subfamily rule matching nothing leaves the entity unmatched', async () => {
  const cache = await load([rule('taxonomy_subfamily', 'miletinae', 'biocontrol', 60)]);
  const r = await evaluateRules(null, { scientific_name: 'Random beetle', family: 'Carabidae', subfamily: 'Carabinae' }, null, cache);
  assert.equal(r, null, 'no rule should be invented');
});

test('subfamily matching is case-insensitive, like every other tier', async () => {
  const cache = await load([rule('taxonomy_subfamily', 'scolytinae', 'pest_insect', 60)]);
  const r = await evaluateRules(null, { scientific_name: 'Hypothenemus hampei', family: 'Curculionidae', subfamily: 'SCOLYTINAE' }, null, cache);
  assert.equal(r.assignedRole, 'pest_insect');
});
