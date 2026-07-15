#!/usr/bin/env node
/**
 * calibrate-critics.js — Phase 2.5
 *
 * Dispatches every staged-claim sample through ALL 5 specialty critics
 * (agroecologist + entomologist + plant-pathologist + soil-scientist +
 * horticulturist), then computes the pairwise critic-vs-critic agreement
 * matrix. Surfaces low-agreement domain pairs as "needs eventual human
 * arbitration" — but does not block promotion.
 *
 * Per docs/phased-roadmap-ai-only.md "Phase 2.5":
 *   "Calibration: dispatch the same 200-claim sample through each critic,
 *    build a critic-vs-critic agreement matrix, and surface low-agreement
 *    domains as 'need a human eventually' — but don't block on it."
 *
 * Sources of truth:
 *   - prompts:  backend/lib/critic-prompts.js
 *   - schema:   backend/migrations/025_claim_critic_verdicts.js
 *
 * Usage:
 *   node calibrate-critics.js                     # 200-claim sample, all 5 critics
 *   node calibrate-critics.js --sample-size=50    # smaller pilot
 *   node calibrate-critics.js --concurrency=6
 *   node calibrate-critics.js --source-id=9       # restrict to one source
 *   node calibrate-critics.js --out=calibration-2026-05-02.json
 *   node calibrate-critics.js --dry-run
 *
 * Cost: ~$0.02 per claim (5 Sonnet calls). 200 claims ≈ $4.
 *
 * Sampling strategy:
 *   Default: deterministic by id (ORDER BY s.id LIMIT N). Reproducible across
 *   runs against the same DB state. Use --random for a fresh sample
 *   (uses SQLite's RANDOM()). The deterministic mode is preferred for
 *   regenerating the same matrix after critic-prompt changes — apples-to-apples.
 */
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const Anthropic = require('@anthropic-ai/sdk');

const { buildCriticPrompt } = require('./lib/critic-prompts');
const { ALL_CRITICS } = require('./lib/critic-router');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const client = new Anthropic();

const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find(s => s.startsWith(`--${name}=`));
  if (!a) return args.includes(`--${name}`) ? true : def;
  return a.split('=', 2)[1];
}
const SAMPLE_SIZE = parseInt(flag('sample-size', '200'), 10) || 200;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '6'), 10) || 6);
const SOURCE_ID = parseInt(flag('source-id', '0'), 10) || 0;
const OUT_PATH = flag('out', `calibration-${new Date().toISOString().slice(0, 10)}.json`);
const RANDOM = flag('random', false) === true;
const DRY_RUN = flag('dry-run', false) === true;

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

async function dispatchCritic(criticName, claimEnriched) {
  const spec = buildCriticPrompt(criticName);
  const userPrompt = spec.body.replace('{{CLAIM}}', JSON.stringify(claimEnriched, null, 2));
  if (DRY_RUN) {
    return { verdict: 'plausible', reasoning: '(dry-run)', model: spec.model };
  }
  const msg = await client.messages.create({
    model: spec.model,
    max_tokens: 400,
    system: spec.systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const raw = msg.content[0]?.text || '';
  const parsed = parseVerdictResponse(raw);
  return parsed
    ? { ...parsed, model: spec.model }
    : { verdict: 'uncertain', reasoning: `[parse failure: ${raw.slice(0, 80)}]`, model: spec.model };
}

async function mapWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { error: String(e).slice(0, 200) }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/**
 * pairwiseAgreement(verdicts)
 *   verdicts: { stagingId → { criticName → verdict } }
 * Returns:
 *   { criticA: { criticB: { agree, disagree, abstain, pct } } }
 *
 * Excludes pairs where either critic returned out_of_scope (treated as
 * "abstain" — they explicitly declined to evaluate). Agreement % is
 * computed over non-abstaining overlaps.
 */
function pairwiseAgreement(verdicts, critics) {
  const matrix = {};
  for (const a of critics) {
    matrix[a] = {};
    for (const b of critics) {
      matrix[a][b] = { agree: 0, disagree: 0, abstain: 0 };
    }
  }
  for (const claimVerdicts of Object.values(verdicts)) {
    for (let i = 0; i < critics.length; i++) {
      for (let j = 0; j < critics.length; j++) {
        const a = critics[i], b = critics[j];
        const va = claimVerdicts[a], vb = claimVerdicts[b];
        if (!va || !vb) continue;
        if (va === 'out_of_scope' || vb === 'out_of_scope') {
          matrix[a][b].abstain++;
        } else if (va === vb) {
          matrix[a][b].agree++;
        } else {
          matrix[a][b].disagree++;
        }
      }
    }
  }
  for (const a of critics) {
    for (const b of critics) {
      const cell = matrix[a][b];
      const total = cell.agree + cell.disagree;
      cell.pct = total === 0 ? null : Math.round((cell.agree / total) * 100);
    }
  }
  return matrix;
}

function renderMatrix(matrix, critics) {
  const colWidth = 14;
  const rowLabel = (s) => s.padEnd(20);
  const cell = (s) => String(s).padStart(colWidth);
  const lines = [];
  lines.push(rowLabel('') + critics.map(c => cell(c.slice(0, 12))).join(''));
  for (const a of critics) {
    const row = critics.map(b => {
      const v = matrix[a][b];
      if (v.pct === null) return cell('—');
      const total = v.agree + v.disagree;
      return cell(`${v.pct}% (${total})`);
    });
    lines.push(rowLabel(a) + row.join(''));
  }
  return lines.join('\n');
}

(async () => {
  if (!process.env.ANTHROPIC_API_KEY && !DRY_RUN) {
    console.error('ERROR: ANTHROPIC_API_KEY not set. Run with --dry-run to preview.');
    process.exit(2);
  }

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  const where = [`s.target_table IN ('interactions', 'crop_vulnerabilities')`];
  const params = [];
  if (SOURCE_ID) { where.push(`s.source_id = ?`); params.push(SOURCE_ID); }
  // Prefer claims already vouched plausible/uncertain by extractor-vouch
  // (filters out non-claim payloads and obvious garbage).
  where.push(`s.ai_vouch_status IN ('plausible', 'uncertain')`);

  const orderBy = RANDOM ? 'ORDER BY RANDOM()' : 'ORDER BY s.id';
  const sql = `
    SELECT s.id, s.source_id, s.target_table, s.payload
    FROM extraction_staging s
    WHERE ${where.join(' AND ')}
    ${orderBy}
    LIMIT ?
  `;
  const sample = await db.all(sql, [...params, SAMPLE_SIZE]);
  console.log(`Calibration sample: ${sample.length} claims (mode=${RANDOM ? 'random' : 'deterministic'})`);

  if (sample.length === 0) {
    console.error('No eligible staging rows. Run vouch-staged-claims first.');
    await db.close();
    return;
  }

  const work = [];
  for (const row of sample) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = { _payload: row.payload }; }
    const enriched = { target_table: row.target_table, ...payload };
    for (const critic of ALL_CRITICS) {
      work.push({ stagingId: row.id, critic, enriched });
    }
  }
  console.log(`Total dispatches: ${work.length} (${sample.length} claims × ${ALL_CRITICS.length} critics)`);

  const t0 = Date.now();
  const results = await mapWithConcurrency(work, async (w) => {
    const verdict = await dispatchCritic(w.critic, w.enriched);
    if (verdict.error) return { ...w, ...verdict };
    if (!DRY_RUN) {
      await db.run(
        `INSERT OR REPLACE INTO claim_critic_verdicts (staging_id, critic_name, verdict, reasoning, model, vouched_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [w.stagingId, w.critic, verdict.verdict, verdict.reasoning, verdict.model]
      );
    }
    return { ...w, ...verdict };
  }, CONCURRENCY);
  const elapsed = (Date.now() - t0) / 1000;

  // Build verdict map: stagingId → { critic → verdict }
  const verdictMap = {};
  for (const r of results) {
    if (r.error || !r.verdict) continue;
    if (!verdictMap[r.stagingId]) verdictMap[r.stagingId] = {};
    verdictMap[r.stagingId][r.critic] = r.verdict;
  }

  const matrix = pairwiseAgreement(verdictMap, ALL_CRITICS);

  console.log(`\n=== Pairwise agreement matrix (${elapsed.toFixed(1)}s, concurrency=${CONCURRENCY}) ===`);
  console.log(renderMatrix(matrix, ALL_CRITICS));
  console.log('\n(% = agreement on non-abstain overlap; (n) = number of overlapping non-abstain claims)');

  // Per-claim consensus rollup.
  const tally = { ai_reviewed: 0, ai_disputed: 0, ai_partial: 0, ai_all_oos: 0 };
  for (const cv of Object.values(verdictMap)) {
    const counts = { p: 0, i: 0, u: 0, o: 0 };
    for (const v of Object.values(cv)) {
      if (v === 'plausible') counts.p++;
      else if (v === 'implausible') counts.i++;
      else if (v === 'uncertain') counts.u++;
      else if (v === 'out_of_scope') counts.o++;
    }
    if (counts.p >= 2 && counts.i === 0) tally.ai_reviewed++;
    else if (counts.p >= 1 && counts.i >= 1) tally.ai_disputed++;
    else if (counts.o === Object.keys(cv).length) tally.ai_all_oos++;
    else tally.ai_partial++;
  }
  console.log('\n=== Consensus tier rollup ===');
  for (const [k, n] of Object.entries(tally)) console.log(`  ${k}: ${n}`);

  // Identify low-agreement critic pairs (< 70% agreement, ≥ 10 overlapping samples).
  const lowAgreement = [];
  for (let i = 0; i < ALL_CRITICS.length; i++) {
    for (let j = i + 1; j < ALL_CRITICS.length; j++) {
      const a = ALL_CRITICS[i], b = ALL_CRITICS[j];
      const cell = matrix[a][b];
      const total = cell.agree + cell.disagree;
      if (total >= 10 && cell.pct !== null && cell.pct < 70) {
        lowAgreement.push({ pair: `${a} ↔ ${b}`, pct: cell.pct, n: total });
      }
    }
  }
  if (lowAgreement.length > 0) {
    console.log('\n=== Low-agreement pairs (< 70%, n ≥ 10) — flag for eventual human review ===');
    for (const p of lowAgreement) console.log(`  ${p.pair}: ${p.pct}% (n=${p.n})`);
  } else {
    console.log('\nAll critic pairs ≥ 70% agreement (or insufficient overlap).');
  }

  // Persist to disk for the dashboard.
  if (!DRY_RUN) {
    const outFull = path.isAbsolute(OUT_PATH) ? OUT_PATH : path.join(__dirname, OUT_PATH);
    fs.writeFileSync(outFull, JSON.stringify({
      ranAt: new Date().toISOString(),
      sampleSize: sample.length,
      sourceIdFilter: SOURCE_ID || null,
      sampleMode: RANDOM ? 'random' : 'deterministic',
      critics: ALL_CRITICS,
      matrix,
      consensusTally: tally,
      lowAgreementPairs: lowAgreement,
    }, null, 2));
    console.log(`\nWrote ${outFull}`);
  }

  await db.close();
  console.log('\nDone.');
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
