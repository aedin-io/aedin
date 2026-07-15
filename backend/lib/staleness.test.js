'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyRun } = require('./staleness');

test('matches both SHAs → up_to_date', () => {
  const r = classifyRun(
    { extractor_md: 'aa', bundle: 'bb' },
    { extractor_md_sha: 'aa', prompt_bundle_sha: 'bb' }
  );
  assert.equal(r, 'up_to_date');
});

test('only bundle differs → re_vouch_only', () => {
  const r = classifyRun(
    { extractor_md: 'aa', bundle: 'cc' },
    { extractor_md_sha: 'aa', prompt_bundle_sha: 'bb' }
  );
  assert.equal(r, 're_vouch_only');
});

test('only extractor_md differs → re_extract_needed', () => {
  const r = classifyRun(
    { extractor_md: 'zz', bundle: 'bb' },
    { extractor_md_sha: 'aa', prompt_bundle_sha: 'bb' }
  );
  assert.equal(r, 're_extract_needed');
});

test('both differ → re_extract_needed (more disruptive wins)', () => {
  const r = classifyRun(
    { extractor_md: 'zz', bundle: 'cc' },
    { extractor_md_sha: 'aa', prompt_bundle_sha: 'bb' }
  );
  assert.equal(r, 're_extract_needed');
});

test('legacy SHA (backfilled) classifies as re_extract_needed', () => {
  const r = classifyRun(
    { extractor_md: 'aa', bundle: 'bb' },
    { extractor_md_sha: 'legacy', prompt_bundle_sha: 'legacy' }
  );
  assert.equal(r, 're_extract_needed');
});
