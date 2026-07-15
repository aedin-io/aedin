#!/usr/bin/env node
/**
 * vouch-staged-claims.js
 *
 * For each extraction_staging row with ai_vouch_status='pending', dispatch the
 * extractor-vouch agent (.claude/agents/extractor-vouch.md) over the Anthropic
 * API and capture a 4-class verdict (plausible / implausible / uncertain /
 * out_of_scope) plus one-sentence reasoning.
 *
 * Sources of truth:
 *   - prompt:    .claude/agents/extractor-vouch.md (frontmatter + body)
 *   - schema:    backend/migrations/021_ai_vouch_columns.js
 *
 * Usage:
 *   node vouch-staged-claims.js                       # vouch all pending claims
 *   node vouch-staged-claims.js --limit=10            # vouch only N claims
 *   node vouch-staged-claims.js --source-id=9         # restrict to one source
 *   node vouch-staged-claims.js --concurrency=4       # parallel API calls (default 4)
 *   node vouch-staged-claims.js --dry-run             # show what would be sent, no API calls
 *
 * Cost estimate: ~$0.001 per claim with Haiku 4.5. 60 claims ≈ $0.06.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const Anthropic = require('@anthropic-ai/sdk');
const { parseFlags: parseGuardFlags, preflightConfirm, createBudgetGuard, isFatalGuardError } = require('./lib/cost-guard');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const VOUCH_AGENT_PATH = path.resolve(__dirname, '../.claude/agents/extractor-vouch.md');

const client = new Anthropic();

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find(s => s.startsWith(`--${name}=`));
  if (!a) return args.includes(`--${name}`) ? true : def;
  return a.split('=', 2)[1];
}
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const SOURCE_ID = parseInt(flag('source-id', '0'), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '4'), 10) || 4);
const DRY_RUN = flag('dry-run', false) === true;

// Cost-guard flags: --max-spend (default $2), --max-consecutive-failures (default 5), --yes
const GUARD_FLAGS = parseGuardFlags(args);
let guard = null;

// ── Load vouch prompt from agent file ─────────────────────────────────────────
let _cached = null;
function loadVouchPrompt() {
  if (_cached) return _cached;
  const raw = fs.readFileSync(VOUCH_AGENT_PATH, 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fm) throw new Error(`vouch agent file at ${VOUCH_AGENT_PATH} missing frontmatter`);
  const [, frontmatter, body] = fm;
  function fmField(key, fallback) {
    const re = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|(.+))$`, 'm');
    const m = frontmatter.match(re);
    if (!m) return fallback;
    return (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim();
  }
  _cached = {
    name: fmField('name', 'extractor-vouch'),
    systemPrompt: fmField('system_prompt', ''),
    model: fmField('model', 'claude-haiku-4-5-20251001'),
    body,
  };
  if (!_cached.systemPrompt) throw new Error('vouch agent: missing system_prompt');
  if (!_cached.body.includes('{{CLAIM}}')) throw new Error('vouch agent: body missing {{CLAIM}} placeholder');
  return _cached;
}

// ── Parse Claude response (forgiving) ─────────────────────────────────────────
function parseVerdictResponse(raw) {
  if (!raw) return null;
  let txt = raw.trim();
  // Strip markdown fences if present
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Extract first {...} if there's preamble
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

// ── Vouch a single claim ──────────────────────────────────────────────────────
async function vouchOne(spec, claim) {
  const userPrompt = spec.body.replace('{{CLAIM}}', JSON.stringify(claim, null, 2));
  if (DRY_RUN) {
    return { verdict: 'plausible', reasoning: '(dry-run; no API call)' };
  }
  if (guard) guard.checkBeforeCall();
  try {
    const msg = await client.messages.create({
      model: spec.model,
      max_tokens: 300,
      system: spec.systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (guard) guard.recordSuccess(spec.model, msg.usage?.input_tokens, msg.usage?.output_tokens);
    const raw = msg.content[0]?.text || '';
    const parsed = parseVerdictResponse(raw);
    return parsed || { verdict: 'uncertain', reasoning: `[parse failure: ${raw.slice(0, 100)}]` };
  } catch (e) {
    if (isFatalGuardError(e)) throw e;
    if (guard) guard.recordFailure();
    throw e;
  }
}

// ── Concurrency-limited mapper ────────────────────────────────────────────────
// Fatal guard errors short-circuit all workers; per-row errors are captured.
async function mapWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  let fatal = null;
  async function worker() {
    while (true) {
      if (fatal) return;
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (e) {
        if (isFatalGuardError(e)) { fatal = e; return; }
        results[i] = { error: String(e).slice(0, 200) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (fatal) throw fatal;
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.ANTHROPIC_API_KEY && !DRY_RUN) {
    console.error('ERROR: ANTHROPIC_API_KEY not set. Run with --dry-run to preview.');
    process.exit(2);
  }

  const spec = loadVouchPrompt();
  console.log(`Loaded vouch prompt: name=${spec.name}, model=${spec.model}`);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout = 30000');

  let sql = `SELECT id, source_id, target_table, payload FROM extraction_staging WHERE ai_vouch_status = 'pending'`;
  const params = [];
  if (SOURCE_ID) { sql += ` AND source_id = ?`; params.push(SOURCE_ID); }
  sql += ` ORDER BY id`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;

  const pending = await db.all(sql, params);
  console.log(`Pending claims to vouch: ${pending.length}${SOURCE_ID ? ` (source_id=${SOURCE_ID})` : ''}${LIMIT ? ` (limit=${LIMIT})` : ''}`);
  if (pending.length === 0) { await db.close(); return; }

  if (!DRY_RUN) {
    await preflightConfirm({ rowCount: pending.length, model: spec.model, flags: GUARD_FLAGS });
    guard = createBudgetGuard({ ...GUARD_FLAGS, mode: 'api' });
  }

  const t0 = Date.now();
  const results = await mapWithConcurrency(pending, async (row) => {
    let claim;
    try { claim = JSON.parse(row.payload); } catch { claim = { _payload: row.payload }; }
    const enriched = { target_table: row.target_table, ...claim };
    const verdict = await vouchOne(spec, enriched);
    if (!DRY_RUN) {
      await db.run(
        `UPDATE extraction_staging
         SET ai_vouch_status = ?, ai_vouch_note = ?, ai_vouched_by = ?, ai_vouched_at = datetime('now')
         WHERE id = ?`,
        [verdict.verdict, verdict.reasoning, spec.name, row.id]
      );
    }
    return { id: row.id, target_table: row.target_table, ...verdict };
  }, CONCURRENCY);
  const elapsed = (Date.now() - t0) / 1000;

  // Summary
  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log(`\n=== vouch summary (${elapsed.toFixed(1)}s, concurrency=${CONCURRENCY}) ===`);
  for (const [v, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}: ${n}`);
  }

  console.log('\n=== first 8 verdicts ===');
  for (const r of results.slice(0, 8)) {
    if (r.error) console.log(`  [${r.id}] ERROR: ${r.error}`);
    else console.log(`  [${r.id}] (${r.target_table}) ${r.verdict?.toUpperCase() ?? 'UNDEFINED'} — ${r.reasoning}`);
  }

  if (guard) {
    const report = guard.getReport();
    console.log('\n[cost-guard] final report:');
    console.log(`  cumulative spend:      $${report.cumulativeCostUSD.toFixed(4)} / ceiling $${report.maxSpend.toFixed(2)}`);
    console.log(`  successes / failures:  ${report.totalSuccesses} / ${report.totalFailures}`);
    console.log(`  total tokens (in/out): ${report.totalInputTokens} / ${report.totalOutputTokens}`);
  }

  await db.close();
  console.log('\nDone.');
})().catch(err => {
  if (isFatalGuardError(err)) {
    console.error('\n' + err.message);
    if (guard) {
      const report = guard.getReport();
      console.error(`[cost-guard] spend at abort: $${report.cumulativeCostUSD.toFixed(4)} | failures: ${report.totalFailures} | successes: ${report.totalSuccesses}`);
    }
    process.exit(2);
  }
  console.error('Fatal:', err);
  process.exit(1);
});
