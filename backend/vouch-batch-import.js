#!/usr/bin/env node
/**
 * vouch-batch-import.js — pure-SQL importer for subagent-produced Haiku-equivalent
 * first-pass vouch verdicts.
 *
 * Reads /tmp/claude/vouch-verdicts/batch-NNN.json (one file per batch processed by
 * a general-purpose Agent), validates each verdict, and writes them to
 * extraction_staging.ai_vouch_status / ai_vouch_note / ai_vouched_by / ai_vouched_at
 * via UPDATE WHERE ai_vouch_status='pending' (so already-vouched rows are skipped).
 *
 * Verdict file shape:
 *   [
 *     { staging_id: 5601, verdict: 'plausible',
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

const VERDICTS_DIR = process.env.VOUCH_VERDICTS_DIR || path.join(__dirname, 'vouch-verdicts');
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

  let updated = 0, skipped = 0, malformed = 0;
  for (const f of files) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(VERDICTS_DIR, f), 'utf8')); }
    catch (e) { console.warn(`  ⚠ ${f}: parse error: ${e.message}`); continue; }
    if (!Array.isArray(arr)) {
      console.warn(`  ⚠ ${f}: not an array`);
      continue;
    }
    for (const v of arr) {
      if (!v || !v.staging_id || !v.verdict) { malformed++; continue; }
      const verdict = String(v.verdict).toLowerCase().trim();
      if (!VALID_VERDICTS.has(verdict)) { malformed++; continue; }
      const reasoning = (v.reasoning || '').slice(0, 500);
      const model = v.model || 'claude-code-subagent';
      const r = await db.run(
        `UPDATE extraction_staging
         SET ai_vouch_status = ?, ai_vouch_note = ?, ai_vouched_by = ?, ai_vouched_at = datetime('now')
         WHERE id = ? AND ai_vouch_status = 'pending'`,
        [verdict, reasoning, model, v.staging_id]
      );
      if (r.changes > 0) updated++; else skipped++;
    }
  }

  // Summary tally
  const tally = await db.all(`
    SELECT ai_vouch_status, COUNT(*) AS n
    FROM extraction_staging
    WHERE ai_vouched_by = 'claude-code-subagent'
    GROUP BY ai_vouch_status
    ORDER BY n DESC
  `);
  console.log(`\nUpdated: ${updated} | Skipped (already vouched or no match): ${skipped} | Malformed: ${malformed}`);
  console.log(`\n=== overall subagent-vouched tally ===`);
  for (const t of tally) console.log(`  ${t.ai_vouch_status}: ${t.n}`);

  await db.close();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
