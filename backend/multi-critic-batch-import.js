#!/usr/bin/env node
/**
 * multi-critic-batch-import.js — pure-SQL importer for subagent-produced critic verdicts.
 *
 * Reads /tmp/claude/critic-verdicts/batch-NNN.json (one file per batch processed by
 * a general-purpose Agent), validates each verdict, and writes them to
 * claim_critic_verdicts via INSERT OR IGNORE (idempotent on UNIQUE
 * (staging_id, critic_name)).
 *
 * Verdict file shape:
 *   [
 *     { staging_id: 5601, critic: 'agroecologist', verdict: 'plausible',
 *       reasoning: '...', model: 'claude-code-subagent' },
 *     ...
 *   ]
 *
 * No Anthropic API calls. Subscription-mode safe.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const VERDICTS_DIR = process.env.VERDICTS_DIR || '/tmp/claude/critic-verdicts';
const BATCHES_DIR  = process.env.BATCH_OUT_DIR || '/tmp/claude/critic-batches';
const VALID_VERDICTS = new Set(['plausible', 'implausible', 'uncertain', 'out_of_scope']);

(async () => {
  if (!fs.existsSync(VERDICTS_DIR)) {
    console.error(`No verdicts directory at ${VERDICTS_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(VERDICTS_DIR).filter(f => f.startsWith('batch-') && f.endsWith('.json')).sort();
  console.log(`Found ${files.length} verdict files in ${VERDICTS_DIR}`);

  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout = 30000');

  const VALID_EVIDENCE_STRENGTHS = new Set(['strong', 'moderate', 'weak', 'none']);

  let inserted = 0, skipped = 0, malformed = 0;
  const stmt = await db.prepare(
    `INSERT OR REPLACE INTO claim_critic_verdicts
      (staging_id, critic_name, verdict, reasoning, model, critic_confidence, evidence_strength, critic_prompt_sha, vouched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  for (const f of files) {
    // Build shaMap from the matching batch file (Task 7 writes critic_prompt_shas there).
    // key = `${staging_id}::${critic_name}` → sha string
    let shaMap = {};
    const batchFile = path.join(BATCHES_DIR, f);
    try {
      const batchJson = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
      for (const c of batchJson.claims || []) {
        for (const [name, sha] of Object.entries(c.critic_prompt_shas || {})) {
          shaMap[`${c.staging_id}::${name}`] = sha;
        }
      }
    } catch (e) {
      console.warn(`[import] no batch file alongside ${f}: ${e.message}`);
    }

    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(VERDICTS_DIR, f), 'utf8')); }
    catch (e) { console.warn(`  ⚠ ${f}: parse error: ${e.message}`); continue; }
    if (!Array.isArray(arr)) {
      console.warn(`  ⚠ ${f}: not an array`);
      continue;
    }
    for (const v of arr) {
      if (!v || !v.staging_id || !v.critic || !v.verdict) { malformed++; continue; }
      const verdict = String(v.verdict).toLowerCase().trim();
      if (!VALID_VERDICTS.has(verdict)) { malformed++; continue; }
      const critic_confidence = typeof v.critic_confidence === 'number' ? v.critic_confidence : null;
      const evidence_strength = VALID_EVIDENCE_STRENGTHS.has(v.evidence_strength)
        ? v.evidence_strength : null;
      const critic_prompt_sha = shaMap[`${v.staging_id}::${v.critic}`] || null;
      const r = await stmt.run([
        v.staging_id,
        v.critic,
        verdict,
        (v.reasoning || '').slice(0, 500),
        v.model || 'claude-code-subagent',
        critic_confidence,
        evidence_strength,
        critic_prompt_sha,
      ]);
      if (r.changes > 0) inserted++; else skipped++;
    }
  }
  await stmt.finalize();
  await db.close();
  console.log(`Inserted: ${inserted} verdicts | Skipped (already present): ${skipped} | Malformed: ${malformed}`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
