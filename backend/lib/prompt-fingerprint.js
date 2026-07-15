'use strict';

/**
 * Phase Provenance: pure functions for prompt-version pinning.
 *
 * Computes deterministic SHA-256 fingerprints of the extractor pipeline's
 * prompt surface. Used by extract-source.js to record extractor_runs
 * rows and by multi-critic-batch-prepare.js to tag each critic verdict
 * with the prompt SHA used to produce it.
 *
 * Bundle SHA design: a hash-of-hashes over a deterministic set of
 * member files + DB tables. Members are sorted before joining so order
 * of computation doesn't affect the result.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function fileSha(absPath) {
  try {
    return sha256(fs.readFileSync(absPath, 'utf8'));
  } catch (e) {
    return sha256('MISSING:' + path.basename(absPath));
  }
}

function extractorMdSha(repoRoot) {
  return fileSha(path.join(repoRoot, '.claude/agents/extractor.md'));
}

function criticPromptSha(repoRoot, criticName) {
  return fileSha(path.join(repoRoot, `.claude/agents/${criticName}.md`));
}

const BUNDLE_FILES = [
  '.claude/agents/extractor-vouch.md',
  '.claude/agents/agroecologist.md',
  '.claude/agents/entomologist.md',
  '.claude/agents/plant-pathologist.md',
  '.claude/agents/soil-scientist.md',
  '.claude/agents/horticulturist.md',
  '.claude/agents/wildlife-ecologist.md',
  'backend/lib/interaction-vocabulary.js',
  'backend/lib/critic-prompts.js',
  'backend/lib/critic-router.js',
];

async function promptBundleSha(repoRoot, db) {
  const memberShas = [];
  for (const rel of BUNDLE_FILES) {
    memberShas.push(fileSha(path.join(repoRoot, rel)));
  }
  // Canonical serialization of traits_vocabulary
  const vocabRows = await db.all('SELECT trait_name, value_kind FROM traits_vocabulary ORDER BY trait_name');
  memberShas.push(sha256(JSON.stringify(vocabRows)));
  // Canonical serialization of approved (NOT graduated) lessons
  const lessonRows = await db.all(
    `SELECT id, field, original_pattern, corrected_pattern, frequency
     FROM extractor_lessons
     WHERE status = 'approved'
     ORDER BY id`
  );
  memberShas.push(sha256(JSON.stringify(lessonRows)));
  memberShas.sort();
  return sha256(memberShas.join('\n'));
}

async function renderCorrectionLessons(db) {
  const rows = await db.all(
    `SELECT field, original_pattern, corrected_pattern, frequency
     FROM extractor_lessons
     WHERE status = 'approved'
     ORDER BY frequency DESC, id ASC
     LIMIT 20`
  );
  if (rows.length === 0) {
    return '(No lessons yet — this section is auto-populated as reviewers correct extractions over time.)';
  }
  const lines = [
    '| field | original | corrected | frequency |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.field} | ${r.original_pattern ?? ''} | ${r.corrected_pattern} | ${r.frequency} |`);
  }
  return lines.join('\n');
}

async function graduationCandidates(db) {
  return db.all(
    `SELECT id, field, original_pattern, corrected_pattern, frequency, last_seen_at
     FROM extractor_lessons
     WHERE status = 'approved'
       AND frequency >= 5
       AND julianday('now') - julianday(last_seen_at) > 30
     ORDER BY frequency DESC, last_seen_at ASC`
  );
}

module.exports = {
  extractorMdSha,
  criticPromptSha,
  promptBundleSha,
  renderCorrectionLessons,
  graduationCandidates,
  BUNDLE_FILES,
};
