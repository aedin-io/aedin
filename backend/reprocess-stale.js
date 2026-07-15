#!/usr/bin/env node
'use strict';

/**
 * reprocess-stale.js — admin CLI surfacing stale extractor_runs.
 *
 * Reads current extractor.md SHA + bundle SHA from disk/DB. Compares
 * against every row in extractor_runs. Classifies each into up_to_date,
 * re_vouch_only, or re_extract_needed via lib/staleness.js. Reports
 * counts + suggested per-source commands. Also lists graduation
 * candidates (approved lessons frequency>=5 + last_seen_at>30 days).
 *
 * The script does NOT execute anything — admin runs the suggested
 * commands manually.
 */

const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { classifyRun } = require('./lib/staleness');
const { extractorMdSha, promptBundleSha, graduationCandidates } = require('./lib/prompt-fingerprint');

async function classifyAll(db, current) {
  const runs = await db.all(
    `SELECT r.id, r.source_id, r.extractor_md_sha, r.prompt_bundle_sha, s.title
     FROM extractor_runs r
     LEFT JOIN sources s ON s.id = r.source_id
     ORDER BY r.id`
  );
  const report = { up_to_date: [], re_vouch_only: [], re_extract_needed: [] };
  for (const r of runs) {
    const c = classifyRun(current, r);
    report[c].push(r);
  }
  return report;
}

function formatRunLine(r) {
  return `  - run ${r.id} src ${r.source_id} ${r.title || ''}` +
         ` (sha ${(r.extractor_md_sha || '').slice(0, 8)}…, bundle ${(r.prompt_bundle_sha || '').slice(0, 8)}…)`;
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const DB_PATH = CORPUS_DB;
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout = 30000');

  const current = {
    extractor_md: extractorMdSha(repoRoot),
    bundle: await promptBundleSha(repoRoot, db),
  };
  console.log(`[reprocess-stale] current extractor.md SHA: ${current.extractor_md.slice(0, 12)}…`);
  console.log(`[reprocess-stale] current bundle SHA: ${current.bundle.slice(0, 12)}…`);

  const report = await classifyAll(db, current);
  console.log(`\nStale extractor runs: ${report.re_extract_needed.length + report.re_vouch_only.length}`);
  console.log(`  re_extract_needed: ${report.re_extract_needed.length} runs (extractor.md changed)`);
  for (const r of report.re_extract_needed) console.log(formatRunLine(r));
  console.log(`  re_vouch_only: ${report.re_vouch_only.length} runs (bundle drift only)`);
  for (const r of report.re_vouch_only) console.log(formatRunLine(r));
  console.log(`  up_to_date: ${report.up_to_date.length} runs`);

  // Stale critic verdicts
  const staleVerdicts = await db.all(`
    SELECT critic_name, critic_prompt_sha, COUNT(*) AS n
    FROM claim_critic_verdicts
    WHERE critic_prompt_sha IS NOT NULL AND critic_prompt_sha != 'legacy'
    GROUP BY critic_name, critic_prompt_sha
    ORDER BY n DESC
  `);
  console.log(`\nClaim_critic_verdicts with stored SHA: ${staleVerdicts.reduce((a, r) => a + r.n, 0)} rows`);
  // (a precise stale-vs-fresh comparison per critic could be added here)

  // Graduation candidates
  const cands = await graduationCandidates(db);
  console.log(`\nGraduation candidates: ${cands.length} approved lessons`);
  for (const l of cands) {
    console.log(`  - lesson ${l.id} (field=${l.field}, "${l.original_pattern}"→"${l.corrected_pattern}", frequency=${l.frequency}, last_seen ${l.last_seen_at})`);
  }

  const sourcesWithRe = new Set(report.re_extract_needed.map(r => r.source_id));
  const sourcesWithVouch = new Set(report.re_vouch_only.map(r => r.source_id));
  if (sourcesWithRe.size + sourcesWithVouch.size > 0) {
    console.log(`\nSuggested actions:`);
    if (sourcesWithRe.size > 0) {
      console.log(`\n  RE-EXTRACT NEEDED (extractor.md changed since these were extracted):`);
      console.log(`  For each source, find its PDF and re-ingest:`);
      for (const id of sourcesWithRe) {
        const src = await db.get(`SELECT file_path, title FROM sources WHERE id = ?`, id);
        const pdf = src && src.file_path ? src.file_path : '<no file_path on sources row>';
        console.log(`    src ${id} "${(src && src.title || '').slice(0, 60)}" → node extract-source-cli.js ${pdf}`);
      }
    }
    if (sourcesWithVouch.size > 0) {
      console.log(`\n  RE-VOUCH NEEDED (critic prompts changed; payloads still valid):`);
      console.log(`  For each source, delete its verdicts then re-prepare critic batches:`);
      for (const id of sourcesWithVouch) {
        if (sourcesWithRe.has(id)) continue;  // re-extract path supersedes
        console.log(`    src ${id}:`);
        console.log(`      DELETE FROM claim_critic_verdicts WHERE staging_id IN (SELECT id FROM extraction_staging WHERE source_id = ${id});`);
        console.log(`      node multi-critic-batch-prepare.js --source-id=${id}`);
        console.log(`      # then dispatch the resulting batches via subagent + node multi-critic-batch-import.js`);
      }
    }
  }
  if (cands.length > 0) {
    console.log(`\nTo graduate a lesson:`);
    console.log(`  1. Paste the lesson's pattern into .claude/agents/extractor.md's body.`);
    console.log(`  2. UPDATE extractor_lessons SET status='graduated', graduated_at=datetime('now') WHERE id=<id>;`);
  }

  await db.close();
}

module.exports = { classifyAll, main };

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
