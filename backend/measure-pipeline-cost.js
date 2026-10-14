#!/usr/bin/env node
/**
 * measure-pipeline-cost.js — Phase 0 of docs/business-model.md.
 *
 * Runs real PDFs through the full paid pipeline (extract → Haiku first-pass
 * vouch → multi-critic) one document at a time, reads the exact spend of each
 * step from the CLIs' --report-json output, and writes a cost-per-page /
 * cost-per-claim report used to set the credit prices.
 *
 * It drives the existing CLIs rather than re-implementing them, so the numbers
 * are what production ingestion actually costs. Staged claims land in the
 * normal corpus DB and continue through the normal pipeline — nothing is
 * thrown away.
 *
 * Usage:
 *   node measure-pipeline-cost.js --dry-run --sample=manifest      # page counts only, $0
 *   node measure-pipeline-cost.js --sample=manifest --max-total-spend=15
 *   node measure-pipeline-cost.js --source-type=paper a.pdf b.pdf  # your own sample
 *
 * Flags:
 *   --sample=manifest     use downloaded PDFs from literature/sources-manifest.json,
 *                         smallest first (up to --limit)
 *   --limit=N             max documents (default 20)
 *   --max-total-spend=X   hard ceiling across the whole run in USD (default 15).
 *                         Each step's --max-spend is the remaining budget, so the
 *                         cost-guard preflight (which over-estimates on purpose)
 *                         can't abort a step that the real budget would allow.
 *   --max-pages=N         skip documents longer than N pages (default 120)
 *   --source-type=T       passed to extract-source-cli (default paper)
 *   --dry-run             count pages/chars and print the plan; no API calls
 *
 * Output: backend/cost-measurements/<timestamp>.json and .md (gitignored).
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { spawnSync } = require('child_process');
const pdfParse = require('pdf-parse');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'cost-measurements');
// Must match extract-source.js MAX_CONTENT (characters per extraction chunk).
const CHUNK_CHARS = 80000;

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const DRY_RUN = argv.includes('--dry-run');
const SAMPLE = flag('sample', null);
const LIMIT = parseInt(flag('limit', '20'), 10);
const MAX_TOTAL = parseFloat(flag('max-total-spend', '15'));
const MAX_PAGES = parseInt(flag('max-pages', '120'), 10);
const SOURCE_TYPE = flag('source-type', 'paper');
const explicitFiles = argv.filter(a => !a.startsWith('--'));

function manifestFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'literature', 'sources-manifest.json'), 'utf8'));
  return manifest.entries
    .map(e => path.join(REPO_ROOT, 'literature', e.category, e.filename || `${e.id}.pdf`))
    .filter(f => f.endsWith('.pdf') && fs.existsSync(f));
}

async function inspect(file) {
  const parsed = await pdfParse(fs.readFileSync(file));
  const chars = parsed.text.length;
  return { file, pages: parsed.numpages, chars, chunks: Math.max(1, Math.ceil(chars / CHUNK_CHARS)) };
}

// Runs a paid CLI with --report-json and returns the parsed report (or null).
function runStep(script, args, reportPath) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args, '--yes', `--report-json=${reportPath}`],
    { cwd: __dirname, stdio: 'inherit' });
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  return { status: r.status, report };
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };
const usd = x => `$${x.toFixed(4)}`;

(async () => {
  let files = explicitFiles.map(f => path.resolve(f));
  if (SAMPLE === 'manifest') files = files.concat(manifestFiles());
  if (!files.length) {
    console.error('No PDFs. Pass file paths, or --sample=manifest after downloading the manifest PDFs into literature/<category>/.');
    process.exit(1);
  }

  const docs = [];
  for (const f of files) {
    try { docs.push(await inspect(f)); } catch (e) { console.error(`[skip] ${path.basename(f)}: ${e.message}`); }
  }
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });

  // Skip documents already extracted: re-running them would spend money and
  // measure the dedup path, not a fresh extraction.
  const queue = [];
  for (const d of docs.sort((a, b) => a.pages - b.pages)) {
    const done = await db.get(`SELECT id FROM extraction_queue WHERE file_path = ? AND status = 'done'`, d.file);
    if (done) { console.log(`[skip] already extracted: ${path.basename(d.file)}`); continue; }
    if (d.pages > MAX_PAGES) { console.log(`[skip] ${d.pages} pages > --max-pages: ${path.basename(d.file)}`); continue; }
    queue.push(d);
    if (queue.length >= LIMIT) break;
  }

  console.log(`\n${queue.length} document(s), ${queue.reduce((s, d) => s + d.pages, 0)} pages, ${queue.reduce((s, d) => s + d.chunks, 0)} extraction chunks`);
  for (const d of queue) console.log(`  ${String(d.pages).padStart(4)} pp  ${d.chunks} chunk(s)  ${path.basename(d.file)}`);
  if (DRY_RUN) { await db.close(); console.log('\n--dry-run: no API calls made.'); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set (backend/.env).'); process.exit(1); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OUT_DIR, stamp);
  fs.mkdirSync(runDir, { recursive: true });

  const results = [];
  let total = 0;
  for (const [i, d] of queue.entries()) {
    if (total >= MAX_TOTAL) { console.log(`\n[stop] --max-total-spend ${usd(MAX_TOTAL)} reached`); break; }
    const remaining = () => (MAX_TOTAL - total).toFixed(2);
    const name = path.basename(d.file);
    console.log(`\n=== [${i + 1}/${queue.length}] ${name} ===`);

    const ex = runStep('extract-source-cli.js',
      [d.file, `--source-type=${SOURCE_TYPE}`, `--max-chunks=${d.chunks}`, `--max-spend=${remaining()}`],
      path.join(runDir, `${i}-extract.json`));
    const extractCost = ex.report?.cumulativeCostUSD ?? 0;
    total += extractCost;
    const q = await db.get(`SELECT source_id FROM extraction_queue WHERE file_path = ? AND status = 'done'`, d.file);
    if (!q?.source_id) { results.push({ ...d, error: 'extraction failed', extractCost }); continue; }

    const v1 = runStep('vouch-staged-claims.js', [`--source-id=${q.source_id}`, `--max-spend=${remaining()}`],
      path.join(runDir, `${i}-vouch.json`));
    const vouchCost = v1.report?.cumulativeCostUSD ?? 0;
    total += vouchCost;

    const v2 = runStep('vouch-multi-critic.js', [`--source-id=${q.source_id}`, `--max-spend=${remaining()}`],
      path.join(runDir, `${i}-critic.json`));
    const criticCost = v2.report?.cumulativeCostUSD ?? 0;
    total += criticCost;

    // Same consensus gate as vouch-multi-critic.js: ≥2 plausible, 0 implausible.
    const counts = await db.get(
      `SELECT COUNT(*) AS staged,
              SUM(CASE WHEN c.p >= 2 AND c.i = 0 THEN 1 ELSE 0 END) AS passed
         FROM extraction_staging s
         LEFT JOIN (SELECT staging_id,
                           SUM(verdict = 'plausible') AS p, SUM(verdict = 'implausible') AS i
                      FROM claim_critic_verdicts GROUP BY staging_id) c ON c.staging_id = s.id
        WHERE s.source_id = ?`, q.source_id);

    const docCost = extractCost + vouchCost + criticCost;
    results.push({
      ...d, sourceId: q.source_id,
      claimsStaged: counts.staged || 0, claimsPassed: counts.passed || 0,
      extractCost, vouchCost, criticCost, totalCost: docCost,
      perPage: docCost / d.pages,
      perPassedClaim: counts.passed ? docCost / counts.passed : null,
      tokens: {
        extract: [ex.report?.totalInputTokens, ex.report?.totalOutputTokens],
        vouch: [v1.report?.totalInputTokens, v1.report?.totalOutputTokens],
        critic: [v2.report?.totalInputTokens, v2.report?.totalOutputTokens],
      },
    });
    console.log(`[cost] ${name}: ${usd(docCost)} (${usd(docCost / d.pages)}/page), ${counts.passed || 0}/${counts.staged || 0} claims passed — running total ${usd(total)}`);
  }
  await db.close();

  const ok = results.filter(r => !r.error);
  const perPage = ok.map(r => r.perPage);
  const perClaim = ok.map(r => r.perPassedClaim).filter(x => x != null);
  const pages = ok.reduce((s, r) => s + r.pages, 0);
  const okCost = ok.reduce((s, r) => s + r.totalCost, 0) || 1;
  const summary = ok.length ? {
    documents: ok.length, failed: results.length - ok.length, pages,
    totalCost: total,
    perPage: { median: median(perPage), p90: p90(perPage), pooled: okCost / pages },
    perPassedClaim: perClaim.length ? { median: median(perClaim), p90: p90(perClaim) } : null,
    claimsPerPage: ok.reduce((s, r) => s + r.claimsPassed, 0) / pages,
    stepShare: {
      extract: ok.reduce((s, r) => s + r.extractCost, 0) / okCost,
      vouch: ok.reduce((s, r) => s + r.vouchCost, 0) / okCost,
      critic: ok.reduce((s, r) => s + r.criticCost, 0) / okCost,
    },
  } : null;

  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.json`), JSON.stringify({ summary, results }, null, 2));

  const md = [`# Pipeline cost measurement — ${stamp}`, ''];
  if (summary) {
    // Credit = $0.01 retail; suggested price is 5× the P90 cost per page so
    // long-tail documents stay profitable.
    const suggested = Math.ceil(summary.perPage.p90 * 5 * 100);
    md.push(
      `- Documents: ${summary.documents} (${summary.failed} failed), ${summary.pages} pages, total spend ${usd(summary.totalCost)}`,
      `- **Cost per page:** median ${usd(summary.perPage.median)}, P90 ${usd(summary.perPage.p90)}, pooled ${usd(summary.perPage.pooled)}`,
      summary.perPassedClaim ? `- **Cost per passed claim:** median ${usd(summary.perPassedClaim.median)}, P90 ${usd(summary.perPassedClaim.p90)}` : '- No claims passed consensus.',
      `- Passed claims per page: ${summary.claimsPerPage.toFixed(2)}`,
      `- Spend share: extract ${(summary.stepShare.extract * 100).toFixed(0)}%, first-pass ${(summary.stepShare.vouch * 100).toFixed(0)}%, multi-critic ${(summary.stepShare.critic * 100).toFixed(0)}%`,
      `- Suggested extraction price at 5× P90: **${suggested} credits/page** ($${(suggested / 100).toFixed(2)})`,
      '');
  }
  md.push('| Document | Pages | Claims passed/staged | Extract | Vouch | Critics | Total | $/page |', '|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    md.push(r.error
      ? `| ${path.basename(r.file)} | ${r.pages} | — | ${usd(r.extractCost)} | — | — | — | ${r.error} |`
      : `| ${path.basename(r.file)} | ${r.pages} | ${r.claimsPassed}/${r.claimsStaged} | ${usd(r.extractCost)} | ${usd(r.vouchCost)} | ${usd(r.criticCost)} | ${usd(r.totalCost)} | ${usd(r.perPage)} |`);
  }
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.md`), md.join('\n') + '\n');
  console.log('\n' + md.join('\n'));
  console.log(`\nReport: ${path.relative(REPO_ROOT, path.join(OUT_DIR, stamp + '.md'))}`);
})().catch(e => { console.error(e); process.exit(1); });
