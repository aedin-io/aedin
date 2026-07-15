#!/usr/bin/env node
/**
 * multi-critic-drain.js — minimal multi-critic driver.
 *
 * Drains all extraction_staging rows that lack claim_critic_verdicts entries.
 * Mirrors the standalone-test pattern that works (fresh client per call, no
 * pre-loaded haveVerdict set, sequential per-row processing) instead of the
 * full-batch approach in vouch-multi-critic.js, which hangs with persistent
 * "Connection error" responses on multi-row batches.
 *
 * Usage:
 *   node multi-critic-drain.js [--min-id=N] [--max-rows=N] [--source-id=N]
 *
 * Idempotent. Uses INSERT OR IGNORE on claim_critic_verdicts.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const Anthropic = require('@anthropic-ai/sdk');
const { buildCriticPrompt } = require('./lib/critic-prompts');
const { pickDomainCritic } = require('./lib/critic-router');
const { parseFlags: parseGuardFlags, preflightConfirm, createBudgetGuard, isFatalGuardError } = require('./lib/cost-guard');

const DB_PATH = CORPUS_DB;

const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=', 2)[1] : def;
}
const MIN_ID = parseInt(flag('min-id', '0'), 10) || 0;
const MAX_ROWS = parseInt(flag('max-rows', '999999'), 10) || 999999;
const SOURCE_ID = parseInt(flag('source-id', '0'), 10) || 0;

// Cost-guard flags: --max-spend (default $2), --max-consecutive-failures (default 5), --yes
const GUARD_FLAGS = parseGuardFlags(args);
let guard = null;

function parseVerdict(raw) {
  if (!raw) return null;
  let txt = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!txt.startsWith('{')) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) txt = m[0];
  }
  try {
    const obj = JSON.parse(txt);
    const verdict = (obj.verdict || '').toLowerCase().trim();
    const reasoning = (obj.reasoning || '').trim();
    if (!['plausible', 'implausible', 'uncertain', 'out_of_scope'].includes(verdict)) return null;
    return { verdict, reasoning };
  } catch { return null; }
}

async function dispatchOne(criticName, enriched) {
  const c = new Anthropic();
  const spec = buildCriticPrompt(criticName, { targetTable: 'interactions', payload: enriched });
  const body = spec.body;
  if (guard) guard.checkBeforeCall();
  try {
    const msg = await c.messages.create({
      model: spec.model,
      max_tokens: 400,
      system: spec.systemPrompt,
      messages: [{ role: 'user', content: body }],
    });
    if (guard) guard.recordSuccess(spec.model, msg.usage?.input_tokens, msg.usage?.output_tokens);
    const raw = msg.content[0]?.text || '';
    const parsed = parseVerdict(raw);
    return parsed
      ? { ...parsed, model: spec.model }
      : { verdict: 'uncertain', reasoning: `[parse failure: ${raw.slice(0, 100)}]`, model: spec.model };
  } catch (e) {
    if (isFatalGuardError(e)) throw e;
    if (guard) guard.recordFailure();
    throw e;
  }
}

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout = 30000');

  let sql = `
    SELECT s.id, s.source_id, s.target_table, s.payload
    FROM extraction_staging s
    WHERE s.ai_vouch_status IN ('plausible', 'uncertain')
      AND (s.review_status IS NULL OR s.review_status NOT IN ('promoted', 'rejected'))
      AND NOT EXISTS (SELECT 1 FROM claim_critic_verdicts ccv WHERE ccv.staging_id = s.id)
  `;
  const params = [];
  if (MIN_ID) { sql += ` AND s.id >= ?`; params.push(MIN_ID); }
  if (SOURCE_ID) { sql += ` AND s.source_id = ?`; params.push(SOURCE_ID); }
  sql += ` ORDER BY s.id LIMIT ${MAX_ROWS}`;

  const rows = await db.all(sql, params);
  console.log(`Drain plan: ${rows.length} rows × 2 critics = ${rows.length * 2} dispatches`);
  if (rows.length === 0) { await db.close(); return; }

  // Sample one critic build to discover the model for pre-flight estimate.
  const sampleClaim = JSON.parse(rows[0].payload);
  const sampleSpec = buildCriticPrompt('agroecologist', { targetTable: rows[0].target_table, payload: sampleClaim });
  await preflightConfirm({ rowCount: rows.length * 2, model: sampleSpec.model, flags: GUARD_FLAGS });
  guard = createBudgetGuard({ ...GUARD_FLAGS, mode: 'api' });

  let done = 0, errors = 0;
  const t0 = Date.now();
  outer: for (const row of rows) {
    let claim;
    try { claim = JSON.parse(row.payload); } catch { claim = { _payload: row.payload }; }
    const enriched = { target_table: row.target_table, ...claim };
    const domain = pickDomainCritic(claim, row.target_table);
    for (const critic of ['agroecologist', domain]) {
      try {
        const v = await dispatchOne(critic, enriched);
        await db.run(
          `INSERT OR IGNORE INTO claim_critic_verdicts (staging_id, critic_name, verdict, reasoning, model, vouched_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          [row.id, critic, v.verdict, v.reasoning, v.model]
        );
        done++;
      } catch (e) {
        if (isFatalGuardError(e)) {
          console.error('\n' + e.message);
          break outer;
        }
        errors++;
        console.error(`  [${row.id}/${critic}] error: ${e.name || 'Error'}: ${e.message}`);
        if (guard.isNonRetryable(e)) {
          console.error(`  [${row.id}/${critic}] non-retryable error class — continuing to next dispatch.`);
        }
      }
    }
    if ((done + errors) % 10 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  progress: ${done} ok / ${errors} err (${elapsed}s)`);
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s. Total: ${done} verdicts, ${errors} errors.`);
  if (guard) {
    const report = guard.getReport();
    console.log('[cost-guard] final report:');
    console.log(`  cumulative spend:      $${report.cumulativeCostUSD.toFixed(4)} / ceiling $${report.maxSpend.toFixed(2)}`);
    console.log(`  successes / failures:  ${report.totalSuccesses} / ${report.totalFailures}`);
    console.log(`  total tokens (in/out): ${report.totalInputTokens} / ${report.totalOutputTokens}`);
  }
  await db.close();
})().catch(e => {
  if (isFatalGuardError(e)) {
    console.error('\n' + e.message);
    process.exit(2);
  }
  console.error('Fatal:', e.message);
  process.exit(1);
});
