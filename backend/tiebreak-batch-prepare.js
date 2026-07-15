#!/usr/bin/env node
/**
 * tiebreak-batch-prepare.js — recover "one-plausible-short" held staging rows.
 *
 * Context: the consensus gate needs >=2 plausible, 0 implausible. A large class of
 * held rows has EXACTLY 1 plausible + 0 implausible — the agroecologist synthesizer
 * affirmed them but the router assigned a WRONG specialty critic who returned
 * out_of_scope/uncertain (a known lib/critic-router.js mis-routing, see CLAUDE.md
 * "Open router-tuning backlog"). These claims are not doubtful, just mis-judged.
 *
 * This tool selects those rows and emits batches for a SELF-ROUTED tiebreak: the
 * dispatched agent picks the correct specialist by claim content (NOT via the buggy
 * router) and returns that critic's verdict. A single honest second opinion — if the
 * correct specialist also says plausible, the row hits 2 plausible / 0 implausible.
 *
 * Writes batch files only (no DB mutation). Import + promote are the existing paths.
 *
 * Usage:
 *   node tiebreak-batch-prepare.js [--limit=N] [--batch-size=12]
 *   BATCH_OUT_DIR=tiebreak-batches node tiebreak-batch-prepare.js --limit=24
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { buildCriticPrompt } = require('./lib/critic-prompts');
const { criticPromptSha } = require('./lib/prompt-fingerprint');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=', 2)[1] : def;
};
const LIMIT = parseInt(flag('limit', '999999'), 10) || 999999;
const BATCH_SIZE = parseInt(flag('batch-size', '12'), 10) || 12;
const OUT_DIR = process.env.BATCH_OUT_DIR || path.join(__dirname, 'tiebreak-batches');

// Specialists a tiebreak may route to (NOT agroecologist — it already voted plausible).
const SPECIALISTS = ['entomologist', 'plant-pathologist', 'soil-scientist', 'horticulturist', 'wildlife-ecologist'];
const TARGET_TABLES = ['interactions', 'crop_vulnerabilities', 'entity_trait', 'attractor_relationship'];

const db = new Database(CORPUS_DB, { readonly: true });

// one-plausible-short: pending, vouched plausible/uncertain, has verdicts totaling
// exactly 1 plausible and 0 implausible.
const ttList = TARGET_TABLES.map(t => `'${t}'`).join(',');
const rows = db.prepare(`
  WITH cand AS (
    SELECT es.id, es.target_table, es.payload FROM extraction_staging es
    WHERE es.review_status='pending' AND es.ai_vouch_status IN ('plausible','uncertain')
      AND es.target_table IN (${ttList})
  ),
  vc AS (
    SELECT c.id, c.target_table, c.payload,
      SUM(CASE WHEN v.verdict='plausible'   THEN 1 ELSE 0 END) pl,
      SUM(CASE WHEN v.verdict='implausible' THEN 1 ELSE 0 END) im,
      COUNT(v.staging_id) n
    FROM cand c JOIN claim_critic_verdicts v ON v.staging_id=c.id
    GROUP BY c.id
  )
  -- n=2 restricts to the un-tiebroken routed pair (agroecologist + 1 specialist).
  -- A row that already got a tiebreak has n>=3 and is excluded — idempotent, no
  -- verdict-shopping on rows a tiebreak already left uncertain/implausible.
  SELECT id, target_table, payload FROM vc WHERE pl=1 AND im=0 AND n=2
  ORDER BY id LIMIT ?`).all(LIMIT);

console.log(`One-plausible-short rows selected: ${rows.length}`);
if (rows.length === 0) { console.log('Nothing to prepare.'); process.exit(0); }

// prompt sha per specialist (provenance); all 5 shipped so importer maps whichever the agent uses.
const repoRoot = path.join(__dirname, '..');
const specialistShas = {};
for (const c of SPECIALISTS) specialistShas[c] = criticPromptSha(repoRoot, c) || null;

// specialist templates (source-of-truth via critic-prompts.js)
const criticTemplates = {};
for (const c of SPECIALISTS) {
  const spec = buildCriticPrompt(c);
  criticTemplates[c] = { system_prompt: spec.systemPrompt, body_template: spec.body, model: spec.model };
}

const alreadyStmt = db.prepare('SELECT critic_name, verdict FROM claim_critic_verdicts WHERE staging_id=?');

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.startsWith('batch-') && f.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, f));
}

let batchIdx = 0;
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const slice = rows.slice(i, i + BATCH_SIZE);
  const claims = slice.map(r => {
    let payload;
    try { payload = JSON.parse(r.payload); } catch { payload = { _payload: r.payload }; }
    const prior = alreadyStmt.all(r.id).map(v => `${v.critic_name}:${v.verdict}`);
    return {
      staging_id: r.id,
      target_table: r.target_table,
      claim: { target_table: r.target_table, ...payload },
      already_judged_by: prior,           // e.g. ["agroecologist:plausible","horticulturist:out_of_scope"]
      critic_prompt_shas: { ...specialistShas },
    };
  });
  const batch = { batch_id: batchIdx, mode: 'tiebreak_self_route', critic_templates: criticTemplates, claims };
  fs.writeFileSync(path.join(OUT_DIR, `batch-${String(batchIdx).padStart(3, '0')}.json`),
                   JSON.stringify(batch, null, 2));
  batchIdx++;
}
console.log(`Wrote ${batchIdx} tiebreak batches to ${OUT_DIR} (batch-size ${BATCH_SIZE})`);
