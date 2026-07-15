'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCriticPrompt, getRecentCorrectionsForPrompt, renderResolutionAnnotation } = require('./critic-prompts');

// ── buildCriticPrompt ────────────────────────────────────────────────────────

test('buildCriticPrompt: unknown critic throws', () => {
  assert.throws(() => buildCriticPrompt('not-a-critic'), /unknown critic/);
});

test('buildCriticPrompt: returns expected shape for agroecologist', () => {
  const spec = buildCriticPrompt('agroecologist');
  assert.ok(spec.systemPrompt.length > 0, 'systemPrompt non-empty');
  assert.ok(spec.body.includes('{{CLAIM}}'), 'body contains {{CLAIM}} placeholder');
  assert.ok(spec.model, 'model set');
  assert.strictEqual(spec.name, 'agroecologist');
});

test('buildCriticPrompt: recentCorrections opt injected into body', () => {
  const corrections = '\nRECENT REVIEWER CORRECTIONS (from prior verification work — use these as guidance for similar judgments):\n  - Field "crop": "tomatto" rejected — typo\n';
  const spec = buildCriticPrompt('agroecologist', { recentCorrections: corrections });
  assert.ok(spec.body.includes('RECENT REVIEWER CORRECTIONS'), 'corrections block present in body');
  assert.ok(spec.body.includes('tomatto'), 'correction detail present');
});

test('buildCriticPrompt: no recentCorrections opt → corrections section absent', () => {
  const spec = buildCriticPrompt('agroecologist');
  assert.ok(!spec.body.includes('RECENT REVIEWER CORRECTIONS'), 'no corrections block without opt');
});

// ── getRecentCorrectionsForPrompt ────────────────────────────────────────────

test('getRecentCorrectionsForPrompt: empty DB returns empty string', async () => {
  // Provide a mock db that returns an empty array (simulates empty table)
  const mockDb = {
    all: async () => []
  };
  const result = await getRecentCorrectionsForPrompt(mockDb);
  assert.strictEqual(result, '', 'empty array → empty string');
});

test('getRecentCorrectionsForPrompt: missing table returns empty string (no throw)', async () => {
  const mockDb = {
    all: async () => { throw new Error('no such table: staging_field_corrections'); }
  };
  const result = await getRecentCorrectionsForPrompt(mockDb);
  assert.strictEqual(result, '', 'DB error → empty string, no throw');
});

test('getRecentCorrectionsForPrompt: edited row → includes original and corrected', async () => {
  const mockDb = {
    all: async () => [{
      field_path: 'crop',
      action: 'edited',
      original_value: 'tomatto',
      corrected_value: 'tomato',
      note: null,
      created_at: '2026-05-08 10:00:00'
    }]
  };
  const result = await getRecentCorrectionsForPrompt(mockDb);
  assert.ok(result.includes('RECENT REVIEWER CORRECTIONS'), 'header present');
  assert.ok(result.includes('"crop"'), 'field_path present');
  assert.ok(result.includes('tomatto'), 'original_value present');
  assert.ok(result.includes('tomato'), 'corrected_value present');
});

test('getRecentCorrectionsForPrompt: rejected row with note → includes note', async () => {
  const mockDb = {
    all: async () => [{
      field_path: 'interaction_category',
      action: 'rejected',
      original_value: 'parasitism',
      corrected_value: null,
      note: 'source says competition not parasitism',
      created_at: '2026-05-08 10:00:00'
    }]
  };
  const result = await getRecentCorrectionsForPrompt(mockDb);
  assert.ok(result.includes('RECENT REVIEWER CORRECTIONS'), 'header present');
  assert.ok(result.includes('source says competition not parasitism'), 'note present');
});

test('getRecentCorrectionsForPrompt: rejected row without note → default fallback', async () => {
  const mockDb = {
    all: async () => [{
      field_path: 'interaction_category',
      action: 'rejected',
      original_value: 'parasitism',
      corrected_value: null,
      note: null,
      created_at: '2026-05-08 10:00:00'
    }]
  };
  const result = await getRecentCorrectionsForPrompt(mockDb);
  assert.ok(result.includes('correct answer unknown / not stated in source'), 'default fallback note present');
});

test('getRecentCorrectionsForPrompt: correct row → confirmed correct', async () => {
  const mockDb = {
    all: async () => [{
      field_path: 'subject_organism',
      action: 'correct',
      original_value: 'Apis mellifera',
      corrected_value: null,
      note: null,
      created_at: '2026-05-08 10:00:00'
    }]
  };
  const result = await getRecentCorrectionsForPrompt(mockDb);
  assert.ok(result.includes('confirmed correct'), 'confirmed correct label');
  assert.ok(result.includes('Apis mellifera'), 'organism name present');
});

test('getRecentCorrectionsForPrompt: maxChars cap truncates long list', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    field_path: `field_${i}`,
    action: 'edited',
    original_value: 'x'.repeat(80),
    corrected_value: 'y'.repeat(80),
    note: null,
    created_at: '2026-05-08 10:00:00'
  }));
  const mockDb = { all: async () => rows };
  // With maxChars=300 only a handful of rows should fit
  const result = await getRecentCorrectionsForPrompt(mockDb, { maxChars: 300 });
  const lineCount = (result.match(/^  - /gm) || []).length;
  assert.ok(lineCount < 20, `should be fewer than 20 lines (got ${lineCount})`);
  assert.ok(lineCount >= 1, 'at least one line should appear');
});

// ── renderResolutionAnnotation ───────────────────────────────────────────────

test('renders both-sides annotation', () => {
  const line = renderResolutionAnnotation('unverified', { subject: null, object: 42 });
  assert.match(line, /Entity resolution/);
  assert.match(line, /overall=unverified/);
  assert.match(line, /subject=unresolved/);
  assert.match(line, /object=resolved\(#42\)/);
});

test('returns empty string when status is null (pre-Grounding rows)', () => {
  assert.equal(renderResolutionAnnotation(null, { subject: null, object: null }), '');
});
