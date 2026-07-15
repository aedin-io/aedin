'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
  extractorMdSha,
  criticPromptSha,
  promptBundleSha,
  renderCorrectionLessons,
  graduationCandidates,
} = require('./prompt-fingerprint');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE traits_vocabulary (trait_name TEXT PRIMARY KEY, value_kind TEXT)`);
  await db.exec(`CREATE TABLE extractor_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field TEXT NOT NULL,
    original_pattern TEXT,
    corrected_pattern TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending',
    graduated_at TEXT,
    auto_approved_at TEXT,
    reviewer_override_at TEXT,
    reviewer_override_by TEXT,
    notes TEXT
  )`);
  return db;
}

function makeTmpRepo() {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pf-'));
  fs.mkdirSync(path.join(root, '.claude/agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backend/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/agents/extractor.md'), '# extractor v1');
  for (const f of ['extractor-vouch','agroecologist','entomologist','plant-pathologist','soil-scientist','horticulturist']) {
    fs.writeFileSync(path.join(root, `.claude/agents/${f}.md`), `# ${f} v1`);
  }
  fs.writeFileSync(path.join(root, 'backend/lib/interaction-vocabulary.js'), '// vocab v1');
  fs.writeFileSync(path.join(root, 'backend/lib/critic-prompts.js'), '// prompts v1');
  fs.writeFileSync(path.join(root, 'backend/lib/critic-router.js'), '// router v1');
  return root;
}

test('extractorMdSha is deterministic + hex', () => {
  const root = makeTmpRepo();
  const sha = extractorMdSha(root);
  assert.match(sha, /^[a-f0-9]{64}$/);
  assert.equal(extractorMdSha(root), sha);
});

test('criticPromptSha is per-critic', () => {
  const root = makeTmpRepo();
  const a = criticPromptSha(root, 'agroecologist');
  const e = criticPromptSha(root, 'entomologist');
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, e);
});

test('promptBundleSha is deterministic + reacts to any member change', async () => {
  const root = makeTmpRepo();
  const db = await freshDb();
  const sha1 = await promptBundleSha(root, db);
  assert.match(sha1, /^[a-f0-9]{64}$/);
  const sha1again = await promptBundleSha(root, db);
  assert.equal(sha1, sha1again);
  // Mutate one critic file → bundle SHA must flip
  fs.writeFileSync(path.join(root, '.claude/agents/agroecologist.md'), '# agroecologist v2');
  const sha2 = await promptBundleSha(root, db);
  assert.notEqual(sha1, sha2);
});

test('promptBundleSha includes approved (not graduated) lessons', async () => {
  const root = makeTmpRepo();
  const db = await freshDb();
  const sha0 = await promptBundleSha(root, db);
  // Insert pending lesson → bundle unchanged
  await db.run(`INSERT INTO extractor_lessons (field, original_pattern, corrected_pattern, frequency, status) VALUES ('foo','x','y',1,'pending')`);
  const sha1 = await promptBundleSha(root, db);
  assert.equal(sha0, sha1, 'pending lesson should not affect bundle');
  // Approve → bundle changes
  await db.run(`UPDATE extractor_lessons SET status='approved', frequency=2 WHERE id=1`);
  const sha2 = await promptBundleSha(root, db);
  assert.notEqual(sha1, sha2, 'approved lesson should flip bundle');
  // Graduate → bundle reverts (graduated lessons excluded)
  await db.run(`UPDATE extractor_lessons SET status='graduated', graduated_at=datetime('now') WHERE id=1`);
  const sha3 = await promptBundleSha(root, db);
  assert.equal(sha0, sha3, 'graduated lesson should be excluded from bundle (same as pre-approval state)');
});

test('renderCorrectionLessons returns markdown table of approved lessons', async () => {
  const root = makeTmpRepo();
  const db = await freshDb();
  await db.run(`INSERT INTO extractor_lessons (field, original_pattern, corrected_pattern, frequency, status) VALUES
    ('effect_direction','harmful','beneficial',5,'approved'),
    ('affected_part','leaves','roots',3,'approved'),
    ('mechanism','generic','specific',1,'pending'),
    ('foo','x','y',8,'graduated')`);
  const md = await renderCorrectionLessons(db);
  assert.match(md, /effect_direction/);
  assert.match(md, /affected_part/);
  assert.doesNotMatch(md, /generic/, 'pending lesson should not render');
  assert.doesNotMatch(md, /graduated/i.test(md) ? /never/ : /graduated/, 'no graduated content');
});

test('renderCorrectionLessons returns placeholder when no approved lessons', async () => {
  const root = makeTmpRepo();
  const db = await freshDb();
  const md = await renderCorrectionLessons(db);
  assert.match(md, /No lessons yet/i);
});

test('renderCorrectionLessons caps at 20', async () => {
  const root = makeTmpRepo();
  const db = await freshDb();
  for (let i = 0; i < 30; i++) {
    await db.run(`INSERT INTO extractor_lessons (field, corrected_pattern, frequency, status) VALUES (?, ?, ?, 'approved')`, [`f${i}`, `c${i}`, 30 - i]);
  }
  const md = await renderCorrectionLessons(db);
  // Top 20 by frequency = f0 (freq 30) ... f19 (freq 11). f20+ excluded.
  assert.match(md, /\| f0 \|/);
  assert.match(md, /\| f19 \|/);
  assert.doesNotMatch(md, /\| f20 \|/);
});

test('graduationCandidates surfaces approved + frequent + old lessons', async () => {
  const root = makeTmpRepo();
  const db = await freshDb();
  await db.run(`INSERT INTO extractor_lessons (field, corrected_pattern, frequency, status, last_seen_at) VALUES
    ('young','x',8,'approved', datetime('now','-5 days')),
    ('ready','y',6,'approved', datetime('now','-40 days')),
    ('rejected_old','z',9,'rejected', datetime('now','-90 days'))`);
  const cands = await graduationCandidates(db);
  const names = cands.map(c => c.field);
  assert.deepEqual(names, ['ready'], 'only the freq>=5 + age>30d + approved one');
});
