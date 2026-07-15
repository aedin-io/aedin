import { test, expect } from 'vitest';
import { summarizeTrait, summarizeTraits } from './trait-summary.ts';

function claim(v: { num?: number; text?: string; json?: string; unit?: string }) {
  return {
    value_numeric: v.num ?? null,
    value_text: v.text ?? null,
    value_json: v.json ?? null,
    unit: v.unit ?? null,
  };
}

test('numeric: multiple values become a min–max range with unit', () => {
  const s = summarizeTrait('ph_min', [claim({ num: 5.5 }), claim({ num: 6 }), claim({ num: 6 })]);
  expect(s?.kind).toBe('numeric');
  expect(s?.display).toBe('5.5–6');
  expect(s?.count).toBe(3);
});

test('numeric: a single value shows without a dash', () => {
  const s = summarizeTrait('in_row_spacing_cm', [claim({ num: 30, unit: 'cm' })]);
  expect(s?.display).toBe('30 cm');
});

test('numeric: a value_json {min,max} range is folded into the envelope', () => {
  const s = summarizeTrait('favorable_humidity', [claim({ json: '{"min":70,"max":95}' }), claim({ json: '{"min":60,"max":90}' })]);
  expect(s?.kind).toBe('numeric');
  expect(s?.display).toBe('60–95');
});

test('list: arrays union their members', () => {
  const s = summarizeTrait('edible_part', [claim({ json: '["fruit"]' }), claim({ json: '["fruit","leaf","stem"]' })]);
  expect(s?.kind).toBe('list');
  expect(s?.display).toBe('fruit, leaf, stem');
});

test('categorical: distinct value_texts are joined', () => {
  const s = summarizeTrait('life_cycle', [claim({ text: 'woody_perennial' }), claim({ text: 'woody_perennial' })]);
  expect(s?.kind).toBe('categorical');
  expect(s?.display).toBe('woody_perennial');
  const t = summarizeTrait('produce_shape', [claim({ text: 'oblate' }), claim({ text: 'round' })]);
  expect(t?.display).toBe('oblate / round');
});

test('label humanizes _cm and _kg_t suffixes', () => {
  expect(summarizeTrait('between_row_spacing_cm', [claim({ num: 50 })])?.label).toBe('between row spacing (cm)');
  expect(summarizeTrait('n_removal_kg_t', [claim({ num: 2.2 })])?.label).toBe('n removal (kg/t)');
});

test('summarizeTraits sorts by label and skips empty traits', () => {
  const m = new Map<string, ReturnType<typeof claim>[]>([
    ['life_cycle', [claim({ text: 'annual' })]],
    ['edible_part', [claim({ json: '["seed"]' })]],
    ['empty', [claim({})]],
  ]);
  const out = summarizeTraits(m);
  expect(out.map((s) => s.trait)).toEqual(['edible_part', 'life_cycle']);
});
