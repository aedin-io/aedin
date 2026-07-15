#!/usr/bin/env node
/**
 * vouch-multi-critic.js — Phase 2.5
 *
 * Fans out each pending extraction_staging row to two independent specialty
 * critics (agroecologist + 1 domain specialist routed by claim content) and
 * writes their verdicts to `claim_critic_verdicts`. The promote-staged-claims
 * gate then picks up rows with ≥2 plausible / 0 implausible as the
 * `ai_reviewed` tier.
 *
 * Sources of truth:
 *   - critic identity:  .claude/agents/{name}.md  (frontmatter description)
 *   - prompt envelope:  backend/lib/critic-prompts.js
 *   - domain routing:   backend/lib/critic-router.js
 *   - schema:           backend/migrations/025_claim_critic_verdicts.js
 *
 * Eligibility:
 *   By default, dispatches only on rows whose extractor-vouch first-pass
 *   verdict was 'plausible' or 'uncertain'. Rows already marked 'implausible'
 *   or 'out_of_scope' by Haiku skip Sonnet (saves cost; the consensus gate
 *   couldn't promote them anyway). Use --include-all to bypass.
 *
 * Idempotent: UNIQUE (staging_id, critic_name) on the verdicts table means a
 * re-run skips already-recorded (claim, critic) pairs. Use --redo to force a
 * re-vouch (delete + insert). The default workflow assumes verdicts are
 * stable and only fills in the missing ones.
 *
 * Usage:
 *   node vouch-multi-critic.js
 *   node vouch-multi-critic.js --limit=50
 *   node vouch-multi-critic.js --source-id=9
 *   node vouch-multi-critic.js --concurrency=4
 *   node vouch-multi-critic.js --include-all          # also vouch implausible/oos rows
 *   node vouch-multi-critic.js --include-promoted     # also vouch already-promoted rows
 *                                                     # (use to gather verdicts on rows whose
 *                                                     #  claims sit at review_status='ai_vouched'
 *                                                     #  so upgrade-claim-tier.js can bump them
 *                                                     #  to 'ai_reviewed')
 *   node vouch-multi-critic.js --redo                 # force re-vouch existing pairs
 *   node vouch-multi-critic.js --dry-run              # preview, no API calls, no writes
 *
 * Cost: ~$0.005-0.008 per claim (2 Sonnet calls). 1000 claims ≈ $5-8.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const Anthropic = require('@anthropic-ai/sdk');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const { buildCriticPrompt } = require('./lib/critic-prompts');
const { pickDomainCritic } = require('./lib/critic-router');
const { parseFlags: parseGuardFlags, preflightConfirm, createBudgetGuard, isFatalGuardError } = require('./lib/cost-guard');

const DB_PATH = CORPUS_DB;
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
const MIN_ID = parseInt(flag('min-id', '0'), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '4'), 10) || 4);
const INCLUDE_ALL = flag('include-all', false) === true;
const INCLUDE_PROMOTED = flag('include-promoted', false) === true;
const REDO = flag('redo', false) === true;
const DRY_RUN = flag('dry-run', false) === true;

// Cost-guard flags: --max-spend (default $2), --max-consecutive-failures (default 5), --yes
const GUARD_FLAGS = parseGuardFlags(args);
// guard is assigned in main() so dispatchCritic can reach it via closure
let guard = null;

// ── Verdict parser (shared shape with vouch-staged-claims) ────────────────────
function parseVerdictResponse(raw) {
  if (!raw) return null;
  let txt = raw.trim();
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
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

// ── Dispatch one (claim, critic) pair ─────────────────────────────────────────
async function dispatchCritic(criticName, claimEnriched) {
  const spec = buildCriticPrompt(criticName, { targetTable: 'interactions', payload: claimEnriched });
  const userPrompt = spec.body;
  if (DRY_RUN) {
    return { verdict: 'plausible', reasoning: '(dry-run; no API call)', model: spec.model };
  }
  const delays = [0, 2000, 8000, 20000];
  let lastErr;
  for (const delay of delays) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    // Re-check guard before each attempt so a circuit-trip mid-row stops the next retry.
    if (guard) guard.checkBeforeCall();
    try {
      const msg = await client.messages.create({
        model: spec.model,
        max_tokens: 400,
        system: spec.systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      if (guard) guard.recordSuccess(spec.model, msg.usage?.input_tokens, msg.usage?.output_tokens);
      const raw = msg.content[0]?.text || '';
      const parsed = parseVerdictResponse(raw);
      return parsed
        ? { ...parsed, model: spec.model }
        : { verdict: 'uncertain', reasoning: `[parse failure: ${raw.slice(0, 100)}]`, model: spec.model };
    } catch (e) {
      // Guard-thrown errors are fatal — re-raise immediately, no retries.
      if (isFatalGuardError(e)) throw e;
      if (guard) guard.recordFailure();
      lastErr = e;
      const detail = e?.status ? `${e.status} ${e.name}: ${e.message}` : `${e.name || 'Error'}: ${e.message}`;
      console.error(`  [${criticName}] dispatch error (delay=${delay}ms): ${detail}`);
      // Auth/bad-request/not-found errors will never succeed on retry — fail fast.
      if (guard && guard.isNonRetryable(e)) {
        console.error(`  [${criticName}] non-retryable error class — skipping remaining retries for this row.`);
        throw e;
      }
    }
  }
  throw lastErr;
}

// ── Concurrency-limited mapper ────────────────────────────────────────────────
// Fatal guard errors short-circuit ALL workers via a shared abort flag; per-row
// errors are caught and returned as { error } so the mapper can keep going.
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

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout = 30000');

  // Build the candidate-row query. We want rows that:
  //   - have a non-implausible first-pass vouch (unless --include-all)
  //   - are not already promoted/rejected (review_status filter)
  //   - need at least one of {agroecologist, domain_critic} verdict written.
  // We can't pre-compute domain_critic in SQL (it's payload-dependent), so we
  // pre-fetch all candidate rows and filter client-side after routing.
  const filters = [];
  const params = [];
  if (!INCLUDE_ALL) {
    filters.push(`s.ai_vouch_status IN ('plausible', 'uncertain', 'pending')`);
  }
  if (!INCLUDE_PROMOTED) {
    filters.push(`(s.review_status IS NULL OR s.review_status NOT IN ('promoted', 'rejected'))`);
  } else {
    filters.push(`(s.review_status IS NULL OR s.review_status NOT IN ('rejected'))`);
  }
  if (SOURCE_ID) { filters.push(`s.source_id = ?`); params.push(SOURCE_ID); }
  if (MIN_ID) { filters.push(`s.id >= ?`); params.push(MIN_ID); }

  let sql = `
    SELECT s.id, s.source_id, s.target_table, s.payload, s.ai_vouch_status
    FROM extraction_staging s
    ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
    ORDER BY s.id
  `;
  if (LIMIT) sql += ` LIMIT ${LIMIT * 4}`; // overshoot; client-side filter trims
  const candidates = await db.all(sql, params);

  // Find which (staging_id, critic) pairs already have verdicts.
  const existing = await db.all(`SELECT staging_id, critic_name FROM claim_critic_verdicts`);
  const haveVerdict = new Set(existing.map(r => `${r.staging_id}:${r.critic_name}`));

  // Build the actual work list: (row, critic) pairs that need dispatching.
  const workItems = [];
  for (const row of candidates) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = { _payload: row.payload }; }
    const enriched = { target_table: row.target_table, ...payload };
    const domain = pickDomainCritic(payload, row.target_table);
    for (const critic of ['agroecologist', domain]) {
      const key = `${row.id}:${critic}`;
      if (!REDO && haveVerdict.has(key)) continue;
      workItems.push({ stagingId: row.id, targetTable: row.target_table, sourceId: row.source_id, critic, enriched });
    }
    if (LIMIT && workItems.length >= LIMIT * 2) break;
  }

  console.log(
    `Multi-critic dispatch plan: ${workItems.length} (claim, critic) pairs across ${new Set(workItems.map(w => w.stagingId)).size} claims` +
    `${SOURCE_ID ? ` (source_id=${SOURCE_ID})` : ''}` +
    `${LIMIT ? ` (limit=${LIMIT} claims, ${LIMIT * 2} dispatches)` : ''}` +
    (DRY_RUN ? ' — DRY RUN' : '')
  );

  if (workItems.length === 0) { await db.close(); console.log('Nothing to do.'); return; }

  // Routing-distribution sanity print before we dispatch.
  const criticTally = {};
  for (const w of workItems) criticTally[w.critic] = (criticTally[w.critic] || 0) + 1;
  console.log('Per-critic dispatch counts:', criticTally);

  // Cost-guard pre-flight + guard creation. Skipped on --dry-run since
  // no real API calls fire and the workItems[0] model isn't authoritative
  // (each critic builds its own spec). For pre-flight we just sample one.
  if (!DRY_RUN) {
    const sampleSpec = buildCriticPrompt(workItems[0].critic, { targetTable: workItems[0].targetTable, payload: workItems[0].enriched });
    await preflightConfirm({ rowCount: workItems.length, model: sampleSpec.model, flags: GUARD_FLAGS });
    guard = createBudgetGuard({ ...GUARD_FLAGS, mode: 'api' });
  }

  const t0 = Date.now();
  const results = await mapWithConcurrency(workItems, async (w) => {
    const verdict = await dispatchCritic(w.critic, w.enriched);
    if (verdict.error) return { ...w, ...verdict };
    if (!DRY_RUN) {
      const sql = REDO
        ? `INSERT OR REPLACE INTO claim_critic_verdicts (staging_id, critic_name, verdict, reasoning, model, vouched_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`
        : `INSERT OR IGNORE INTO claim_critic_verdicts (staging_id, critic_name, verdict, reasoning, model, vouched_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`;
      await db.run(sql, [w.stagingId, w.critic, verdict.verdict, verdict.reasoning, verdict.model]);
    }
    return { ...w, ...verdict };
  }, CONCURRENCY);
  const elapsed = (Date.now() - t0) / 1000;

  // Per-critic verdict tally + per-claim consensus tally.
  const verdictByCritic = {};
  for (const r of results) {
    if (r.error || !r.verdict) continue;
    const k = `${r.critic}:${r.verdict}`;
    verdictByCritic[k] = (verdictByCritic[k] || 0) + 1;
  }
  console.log(`\n=== per-critic verdict tally (${elapsed.toFixed(1)}s, concurrency=${CONCURRENCY}) ===`);
  for (const [k, n] of Object.entries(verdictByCritic).sort()) {
    console.log(`  ${k}: ${n}`);
  }

  // Compute consensus per claim (only meaningful for claims that had BOTH critics dispatched in this run; otherwise call the live JOIN).
  if (!DRY_RUN) {
    const claimIds = [...new Set(workItems.map(w => w.stagingId))];
    const placeholders = claimIds.map(() => '?').join(',');
    const consensus = await db.all(
      `SELECT staging_id,
              SUM(CASE WHEN verdict='plausible'   THEN 1 ELSE 0 END) AS p,
              SUM(CASE WHEN verdict='implausible' THEN 1 ELSE 0 END) AS i,
              SUM(CASE WHEN verdict='uncertain'   THEN 1 ELSE 0 END) AS u,
              SUM(CASE WHEN verdict='out_of_scope' THEN 1 ELSE 0 END) AS o,
              COUNT(*) AS total
       FROM claim_critic_verdicts
       WHERE staging_id IN (${placeholders})
       GROUP BY staging_id`, claimIds
    );

    const tally = { ai_reviewed: 0, ai_disputed: 0, ai_partial: 0, ai_oos: 0 };
    for (const c of consensus) {
      if (c.p >= 2 && c.i === 0) tally.ai_reviewed++;
      else if (c.p >= 1 && c.i >= 1) tally.ai_disputed++;
      else if (c.o >= 1 && c.p === 0 && c.i === 0) tally.ai_oos++;
      else tally.ai_partial++;
    }
    console.log('\n=== consensus rollup over the claims touched in this run ===');
    for (const [k, n] of Object.entries(tally)) console.log(`  ${k}: ${n}`);
  }

  console.log('\n=== first 6 verdicts ===');
  for (const r of results.slice(0, 6)) {
    if (r.error) console.log(`  [${r.stagingId}] (${r.critic}) ERROR — ${r.error}`);
    else console.log(`  [${r.stagingId}] (${r.critic}) ${r.verdict.toUpperCase()} — ${r.reasoning}`);
  }

  await db.close();
  if (guard) {
    const report = guard.getReport();
    console.log('\n[cost-guard] final report:');
    console.log(`  cumulative spend:      $${report.cumulativeCostUSD.toFixed(4)} / ceiling $${report.maxSpend.toFixed(2)}`);
    console.log(`  successes / failures:  ${report.totalSuccesses} / ${report.totalFailures}`);
    console.log(`  total tokens (in/out): ${report.totalInputTokens} / ${report.totalOutputTokens}`);
  }

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
