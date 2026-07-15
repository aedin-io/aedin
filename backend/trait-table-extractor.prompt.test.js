'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MD = path.resolve(__dirname, '../.claude/agents/trait-table-extractor.md');

test('trait-table-extractor.md exists with frontmatter', () => {
  assert.ok(fs.existsSync(MD), 'prompt file missing');
  const raw = fs.readFileSync(MD, 'utf8');
  assert.match(raw, /^---\r?\n[\s\S]*?\r?\n---\r?\n/, 'missing YAML frontmatter');
});

test('trait-table-extractor.md carries all 5 placeholders', () => {
  const raw = fs.readFileSync(MD, 'utf8');
  for (const ph of ['{{TARGET_TRAITS}}', '{{TRAITS_VOCABULARY}}', '{{BINOMIAL_GLOSSARY}}', '{{CANDIDATE_ENTITIES}}', '{{DOCUMENT}}']) {
    assert.ok(raw.includes(ph), `missing placeholder ${ph}`);
  }
});

test('trait-table-extractor.md states the entity_traits contract + value-typing', () => {
  const raw = fs.readFileSync(MD, 'utf8');
  assert.match(raw, /entity_traits/, 'no entity_traits key');
  assert.match(raw, /trait_name/);
  assert.match(raw, /value_numeric/);
  assert.match(raw, /value_text/);
  assert.match(raw, /value_json/);
  // focus discipline: extract ONLY the target traits
  assert.match(raw, /ONLY the target traits/i);
  // output contract: a single JSON object with source_meta + entity_traits
  assert.match(raw, /source_meta/);
});
