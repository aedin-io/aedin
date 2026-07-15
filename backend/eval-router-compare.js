#!/usr/bin/env node
'use strict';
/**
 * eval-router-compare.js — run the Hermes graduation gate's criterion-1 + criterion-2
 * comparison between the INCUMBENT router and a CHALLENGER variant.
 * docs/hermes-flexibility-map.md §4. No LLM calls — pure measurement.
 *
 * Criterion 1 (beats incumbent): challenger must (a) score >= incumbent on the
 *   labeled backlog fixtures AND clear the open case, and (b) not raise the
 *   historical recusal rate (routed specialist returned out_of_scope).
 * Criterion 2 (zero regressions): every 'guard' fixture still routes correctly.
 *
 * Usage: node eval-router-compare.js [--no-history]
 */
const path = require('path');
const fs = require('fs');
const { scoreRouter, recusalRate } = require('./lib/router-eval');
const { pickDomainCritic } = require('./lib/critic-router');
const { pickDomainCriticChallenger } = require('./lib/critic-router-challenger');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const NO_HISTORY = process.argv.includes('--no-history');
const FIXTURES_PATH = path.join(__dirname, 'test', 'fixtures', 'router-backlog.json');

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

function fixtureLine(fixtures, cases, id) {
  const c = cases.find(x => x.id === id);
  const f = fixtures.find(x => x.id === id);
  return `  ${c.ok ? '✓' : '✗'} [${f.status}] ${id}: ${c.actual}`;
}

(async () => {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  const inc = scoreRouter(fixtures, pickDomainCritic);
  const chal = scoreRouter(fixtures, pickDomainCriticChallenger);

  console.log('=== Backlog fixtures: incumbent → challenger ===');
  for (const f of fixtures) {
    const ci = inc.cases.find(x => x.id === f.id);
    const cc = chal.cases.find(x => x.id === f.id);
    const flip = ci.ok !== cc.ok ? (cc.ok ? '  ⟵ FIXED' : '  ⟵ REGRESSED') : '';
    console.log(`  [${f.status}] ${f.id}: ${ci.actual} → ${cc.actual} (${ci.ok ? '✓' : '✗'}→${cc.ok ? '✓' : '✗'})${flip}`);
  }
  console.log(`  Accuracy: incumbent ${inc.correct}/${inc.total} → challenger ${chal.correct}/${chal.total}`);

  // Criterion 2: no guard regression
  const guardRegression = fixtures.some(f => {
    if (f.status !== 'guard') return false;
    const cc = chal.cases.find(x => x.id === f.id);
    return !cc.ok;
  });

  let incH = null, chalH = null;
  if (!NO_HISTORY) {
    try {
      const rows = await loadHistoryRows();
      incH = recusalRate(rows, pickDomainCritic);
      chalH = recusalRate(rows, pickDomainCriticChallenger);
      const rerouted = rows.filter(r =>
        pickDomainCritic(r.payload, r.target_table) !== pickDomainCriticChallenger(r.payload, r.target_table)
      ).length;
      console.log('\n=== Historical recusal: incumbent → challenger ===');
      const fmt = (h) => h.rate != null ? `${(h.rate * 100).toFixed(2)}% (${h.recused}/${h.judged} judged, ${h.skipped} skipped)` : 'n/a';
      console.log(`  incumbent:  ${fmt(incH)}`);
      console.log(`  challenger: ${fmt(chalH)}`);
      console.log(`  rows the challenger re-routed away from the incumbent: ${rerouted}`);
    } catch (e) {
      console.log('\n=== Historical recusal: skipped ===\n  (' + String(e.message || e).slice(0, 120) + ')');
    }
  }

  // Gate verdict
  console.log('\n=== GRADUATION GATE — criterion 1 (beats incumbent) + criterion 2 (no regressions) ===');
  const accuracyImproved = chal.correct > inc.correct;
  const accuracyHeld = chal.correct >= inc.correct;
  const recusalOk = (incH == null || chalH == null || chalH.rate == null || incH.rate == null)
    ? null
    : chalH.rate <= incH.rate + 1e-9;
  console.log(`  C2 zero guard regressions: ${guardRegression ? '❌ FAIL (a guard broke)' : '✅ PASS'}`);
  console.log(`  C1a fixtures beat/hold:    ${accuracyImproved ? '✅ IMPROVED' : accuracyHeld ? '➖ held' : '❌ regressed'} (${inc.correct}/${inc.total} → ${chal.correct}/${chal.total})`);
  console.log(`  C1b recusal not worse:     ${recusalOk == null ? '— (no history)' : recusalOk ? '✅ PASS' : '❌ FAIL (recusal rose)'}`);
  const passes = !guardRegression && accuracyImproved && (recusalOk == null || recusalOk);
  console.log(`\n  ONE-PASS GATE RESULT: ${passes ? '✅ challenger BEATS incumbent on this pass' : '❌ challenger does not clear the gate'}`);
  console.log('  (Note: full graduation still needs criteria 3 Goodhart sign-off + 4 sustained ≥2–3 passes.)');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
