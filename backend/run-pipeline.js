#!/usr/bin/env node
/**
 * run-pipeline.js
 *
 * Orchestrates the full AgroEco data pipeline in 9 stages.
 * All steps are incremental by default — they skip already-processed data.
 *
 * Usage:
 *   node run-pipeline.js                      # incremental (default)
 *   node run-pipeline.js --force              # full rebuild (destructive)
 *   node run-pipeline.js --from 6             # start from step 6
 *   node run-pipeline.js --only 9             # run only step 9
 *   node run-pipeline.js --skip-api           # skip API-dependent steps (4, 5)
 *   node run-pipeline.js --no-limit           # uncap API step limits
 *   node run-pipeline.js --dry-run            # preview without executing
 *   node run-pipeline.js --continue-on-error  # don't stop on step failure
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const STEPS = [
  {
    step: 1,
    name: 'Raw interactions',
    scripts: [{ cmd: 'sync-globi.js' }],
    forceArgs: ['--force'],
  },
  {
    step: 2,
    name: 'Entity creation',
    scripts: [{ cmd: 'migrate-entities.js' }],
    forceArgs: ['--force'],
  },
  {
    step: 3,
    name: 'Data cleaning',
    scripts: [
      { cmd: 'cleanup-garbage.js' },
      { cmd: 'cleanup-genus.js' },
      { cmd: 'fix-trailing-periods-and-varieties.js' },
    ],
  },
  {
    step: 4,
    name: 'GBIF taxonomy',
    scripts: [{ cmd: 'sync-gbif.js', defaultArgs: ['--limit', '500'] }],
    forceArgs: ['--force'],
    api: true,
  },
  {
    step: 5,
    name: 'Trefle botanical',
    scripts: [{ cmd: 'sync-trefle-entities.js' }],
    forceArgs: ['--force'],
    api: true,
  },
  {
    step: 6,
    name: 'Bio reclassification',
    scripts: [{ cmd: 'reclassify-bio.js' }],
  },
  {
    step: 7,
    name: 'Role assignment',
    scripts: [
      { cmd: 'seed-role-rules.js' },
      { cmd: 'apply-role-rules.js', defaultArgs: ['--respect-corrections'] },
    ],
    forceArgs: ['--all', '--respect-corrections'],
  },
  {
    step: 8,
    name: 'Build claims',
    scripts: [{ cmd: 'load-globi-claims.js' }],
    forceArgs: ['--force'],
  },
  {
    step: 9,
    name: 'Scoring + chains',
    scripts: [{ cmd: 'build-scores.js' }],
  },
];

// ── Parse CLI flags ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const skipApi = argv.includes('--skip-api');
const noLimit = argv.includes('--no-limit');
const dryRun = argv.includes('--dry-run');
const continueOnError = argv.includes('--continue-on-error');

function getArgValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

const fromStep = getArgValue('--from') ? parseInt(getArgValue('--from'), 10) : null;
const onlyStep = getArgValue('--only') ? parseInt(getArgValue('--only'), 10) : null;

// ── Filter steps ────────────────────────────────────────────────────────────

let stepsToRun = STEPS;

if (onlyStep) {
  stepsToRun = STEPS.filter(s => s.step === onlyStep);
  if (stepsToRun.length === 0) {
    console.error(`No step ${onlyStep}. Valid steps: ${STEPS.map(s => s.step).join(', ')}`);
    process.exit(1);
  }
} else if (fromStep) {
  stepsToRun = STEPS.filter(s => s.step >= fromStep);
}

if (skipApi) {
  stepsToRun = stepsToRun.filter(s => !s.api);
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log('=== AgroEco Data Pipeline ===');
console.log(`Mode: ${force ? 'FULL REBUILD' : 'incremental'}${dryRun ? ' (dry run)' : ''}`);
if (skipApi) console.log('Skipping API steps (4, 5)');
if (fromStep) console.log(`Starting from step ${fromStep}`);
if (onlyStep) console.log(`Running only step ${onlyStep}`);
console.log(`Steps: ${stepsToRun.map(s => s.step).join(', ')}\n`);

const results = [];

for (const step of stepsToRun) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[Step ${step.step}] ${step.name}`);
  console.log('─'.repeat(60));

  const startTime = Date.now();
  let status = 'ok';

  for (const script of step.scripts) {
    // Build args
    let args = [];

    if (force && step.forceArgs) {
      args = [...step.forceArgs];
    } else if (script.defaultArgs) {
      if (noLimit) {
        // Strip --limit from defaultArgs when --no-limit is set
        const filtered = [];
        for (let i = 0; i < script.defaultArgs.length; i++) {
          if (script.defaultArgs[i] === '--limit') {
            i++; // skip the value too
          } else {
            filtered.push(script.defaultArgs[i]);
          }
        }
        args = filtered;
      } else {
        args = [...script.defaultArgs];
      }
    }

    const scriptPath = path.join(__dirname, script.cmd);
    const cmdStr = `node ${script.cmd} ${args.join(' ')}`.trim();

    if (dryRun) {
      console.log(`  Would run: ${cmdStr}`);
      continue;
    }

    console.log(`  Running: ${cmdStr}\n`);

    try {
      execFileSync('node', [scriptPath, ...args], {
        stdio: 'inherit',
        cwd: __dirname,
        timeout: 600000, // 10 minutes per script
      });
    } catch (err) {
      status = 'FAILED';
      console.error(`\n  FAILED: ${script.cmd} exited with code ${err.status || 'unknown'}`);
      if (!continueOnError) {
        console.error(`\nPipeline stopped at step ${step.step}. Use --continue-on-error to keep going.`);
        results.push({ step: step.step, name: step.name, status, elapsed: Date.now() - startTime });
        printSummary(results);
        process.exit(1);
      }
      break;
    }
  }

  const elapsed = Date.now() - startTime;
  results.push({ step: step.step, name: step.name, status, elapsed });
}

printSummary(results);

function printSummary(results) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Pipeline Summary');
  console.log('═'.repeat(60));
  console.log(`${'Step'.padEnd(6)}${'Name'.padEnd(25)}${'Status'.padEnd(10)}${'Time'.padEnd(10)}`);
  console.log('─'.repeat(51));
  for (const r of results) {
    const secs = (r.elapsed / 1000).toFixed(1) + 's';
    console.log(`${String(r.step).padEnd(6)}${r.name.padEnd(25)}${r.status.padEnd(10)}${secs}`);
  }
  console.log('─'.repeat(51));
  const total = results.reduce((s, r) => s + r.elapsed, 0);
  console.log(`${''.padEnd(31)}Total: ${(total / 1000).toFixed(1)}s`);
  const failed = results.filter(r => r.status === 'FAILED');
  if (failed.length > 0) {
    console.log(`\n${failed.length} step(s) failed: ${failed.map(f => f.step).join(', ')}`);
  }
}
