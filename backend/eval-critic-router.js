#!/usr/bin/env node
'use strict';
/**
 * eval-critic-router.js — baseline fitness report for critic-router.js.
 * Hermes flexibility map §3–§5: fills graduation-gate criterion 1 (measure the
 * incumbent router so a future evolved variant has something to beat). No LLM calls.
 *
 * Signals:
 *   (1) LABELED backlog fixtures (test/fixtures/router-backlog.json) — accuracy
 *       vs. the desired domain critic.
 *   (2) UNLABELED history — recusal rate (routed specialist returned out_of_scope)
 *       over claim_critic_verdicts. Skipped if the DB/table is unavailable.
 *
 * Usage:
 *   node eval-critic-router.js                 # fixtures + history
 *   node eval-critic-router.js --no-history    # fixtures only (no DB)
 *   node eval-critic-router.js --out=foo.json  # also write JSON for the ledger
 */
const path = require('path');
const fs = require('fs');
const { pickDomainCritic } = require('./lib/critic-router');
const { scoreRouter, recusalRate } = require('./lib/router-eval');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const args = process.argv.slice(2);
const NO_HISTORY = args.includes('--no-history');
const outArg = args.find(a => a.startsWith('--out='));
const OUT = outArg ? outArg.slice('--out='.length) : null;
const FIXTURES_PATH = path.join(__dirname, 'test', 'fixtures', 'router-backlog.json');

function loadFixtures() {
  return JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
}

async function loadHistoryRows() {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  try {
    const rows = await db.all(`
      SELECT v.staging_id AS id, v.critic_name, v.verdict, s.payload, s.target_table
      FROM claim_critic_verdicts v
      JOIN extraction_staging s ON s.id = v.staging_id
    `);
    const byId = new Map();
    for (const r of rows) {
      let rec = byId.get(r.id);
      if (!rec) {
        let payload;
        try { payload = JSON.parse(r.payload); } catch { payload = {}; }
        rec = { id: r.id, payload, target_table: r.target_table, verdicts: {} };
        byId.set(r.id, rec);
      }
      rec.verdicts[r.critic_name] = r.verdict;
    }
    return [...byId.values()];
  } finally {
    await db.close();
  }
}

(async () => {
  const fixtures = loadFixtures();
  const fx = scoreRouter(fixtures, pickDomainCritic);

  console.log('=== Backlog fixtures (labeled) ===');
  for (const c of fx.cases) {
    const f = fixtures.find(x => x.id === c.id);
    console.log(`  ${c.ok ? '✓' : '✗'} [${f.status}] ${c.id}: expected ${c.expected}, got ${c.actual}`);
  }
  console.log(`Accuracy: ${fx.correct}/${fx.total}` + (fx.accuracy != null ? ` (${(fx.accuracy * 100).toFixed(0)}%)` : ''));

  let hist = null;
  if (!NO_HISTORY) {
    try {
      const rows = await loadHistoryRows();
      hist = recusalRate(rows, pickDomainCritic);
      console.log('\n=== Historical recusal (unlabeled) ===');
      console.log(`  rows=${hist.total} judged=${hist.judged} skipped=${hist.skipped} recused=${hist.recused}` +
        (hist.rate != null ? ` rate=${(hist.rate * 100).toFixed(1)}%` : ''));
    } catch (e) {
      console.log('\n=== Historical recusal: skipped ===');
      console.log(`  (${String(e.message || e).slice(0, 120)})`);
    }
  }

  if (OUT) {
    const outFull = path.isAbsolute(OUT) ? OUT : path.join(__dirname, OUT);
    fs.writeFileSync(outFull, JSON.stringify({ ranAt: new Date().toISOString(), fixtures: fx, history: hist }, null, 2));
    console.log(`\nWrote ${outFull}`);
  }
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
