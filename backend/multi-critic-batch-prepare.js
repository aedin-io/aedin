#!/usr/bin/env node
/**
 * multi-critic-batch-prepare.js — subscription-only multi-critic dispatch (Phase-3, Pass 7+)
 *
 * Pulls eligible staging rows (plausible/uncertain vouch, no critic verdicts yet),
 * routes each to its domain critic via lib/critic-router.js, builds the agroecologist
 * + domain-critic prompts via lib/critic-prompts.js, and writes batch JSON files to
 * /tmp/claude/critic-batches/batch-NNN.json. A general-purpose Agent (subscription
 * tokens) reads each batch, produces verdict JSONs in /tmp/claude/critic-verdicts/,
 * and multi-critic-batch-import.js writes them back into claim_critic_verdicts.
 *
 * Replaces the Anthropic-API-direct path in vouch-multi-critic.js / multi-critic-drain.js
 * for the duration of the subscription-only mode (see memory/feedback_subscription_only_mode.md).
 *
 * Usage:
 *   node multi-critic-batch-prepare.js [--batch-size=15] [--max-rows=N] [--source-id=N]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { pickDomainCritic } = require('./lib/critic-router');
const { buildCriticPrompt, renderResolutionAnnotation } = require('./lib/critic-prompts');
const { criticPromptSha } = require('./lib/prompt-fingerprint');

const argv = process.argv.slice(2);
function flag(name, def) {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=', 2)[1] : def;
}
const BATCH_SIZE = parseInt(flag('batch-size', '12'), 10) || 12;
const MAX_ROWS = parseInt(flag('max-rows', '999999'), 10) || 999999;
const SOURCE_ID = parseInt(flag('source-id', '0'), 10) || 0;
// Optional exact-id scoping (comma-separated). Used by the router-recovery run to
// re-prepare only the rows a router fix re-routes. Parsed ints -> no injection.
const IDS = (flag('ids', '') || '').split(',').map(s => parseInt(s, 10)).filter(Number.isInteger);
const OUT_DIR = process.env.BATCH_OUT_DIR || '/tmp/claude/critic-batches';

// All target_tables eligible for multi-critic review
const TARGET_TABLES = ['interactions', 'crop_vulnerabilities', 'entity_trait', 'attractor_relationship'];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Wipe any stale batches from previous runs
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.startsWith('batch-') && f.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const ttPlaceholders = TARGET_TABLES.map(() => '?').join(', ');
  let sql = `
    SELECT es.id, es.source_id, es.target_table, es.payload, es.ai_vouch_status,
           es.entity_resolution_status, es.resolved_subject_entity_id, es.resolved_object_entity_id,
           e.bio_category, e.kingdom AS entity_kingdom
    FROM extraction_staging es
    LEFT JOIN entities e
      ON e.scientific_name = json_extract(es.payload, '$.scientific_name') COLLATE NOCASE
    WHERE es.ai_vouch_status IN ('plausible', 'uncertain')
      AND (es.review_status IS NULL OR es.review_status NOT IN ('promoted', 'rejected'))
      AND es.target_table IN (${ttPlaceholders})
      AND NOT EXISTS (SELECT 1 FROM claim_critic_verdicts ccv WHERE ccv.staging_id = es.id)
  `;
  const params = [...TARGET_TABLES];
  if (SOURCE_ID) { sql += ` AND es.source_id = ?`; params.push(SOURCE_ID); }
  if (IDS.length) { sql += ` AND es.id IN (${IDS.join(',')})`; }
  sql += ` ORDER BY es.id LIMIT ${MAX_ROWS}`;

  const rows = await db.all(sql, params);
  await db.close();
  console.log(`Eligible rows: ${rows.length}`);

  if (rows.length === 0) { console.log('Nothing to prepare.'); return; }

  // Build per-critic SHA map once at start (Phase Provenance).
  const repoRoot = path.join(__dirname, '..');
  const CRITIC_SHAS = {};
  const allCritics = ['agroecologist', 'entomologist', 'plant-pathologist', 'soil-scientist', 'horticulturist', 'wildlife-ecologist'];
  for (const critic of allCritics) {
    CRITIC_SHAS[critic] = criticPromptSha(repoRoot, critic);
  }

  // Master critic-template map (built once per run). Each batch picks only the
  // SUBSET of these that its claims actually reference (agroecologist + 1-N domain
  // critics) — trims unused 2-3 of the 5 templates per batch vs. shipping all 5,
  // a ~40-60% reduction in the shared-template block on top of the per-claim
  // dedup. Default batch size bumped 8 → 12 after the body-template trim (~40%
  // smaller) reduced watchdog-stall pressure.
  const criticTemplates = {};
  for (const c of allCritics) {
    const spec = buildCriticPrompt(c);
    criticTemplates[c] = {
      system_prompt: spec.systemPrompt,
      body_template: spec.body, // contains {{CLAIM}} placeholder
      model: spec.model,
    };
  }

  let batchIdx = 0;
  const usedHistogram = {}; // diagnostic: which critics did this run actually reference
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const claims = slice.map(r => {
      let payload;
      try { payload = JSON.parse(r.payload); } catch { payload = { _payload: r.payload }; }
      // For entity_trait rows, route by the entities-table bio_category — but
      // ONLY when the entity is taxonomically RESOLVED (kingdom not null, i.e.
      // GBIF-backfilled or GloBI-native). A resolved entity's bio_category is
      // authoritative and fixes the extractor's payload guess (tomato→
      // invertebrate, Bt→plantae). An UNresolved entity (kingdom null, abstained
      // or a synonym-duplicate) still carries the old guess — no better than the
      // payload — so keep the payload routing there. [GBIF backfill follow-on]
      if (r.target_table === 'entity_trait' && r.bio_category && r.entity_kingdom) {
        payload = { ...payload, bio_category: r.bio_category };
      } else if (r.target_table === 'entity_trait' && r.bio_category && !payload.bio_category) {
        payload = { ...payload, bio_category: r.bio_category };
      }
      const domain = pickDomainCritic(payload, r.target_table);
      const assignedCritics = ['agroecologist', domain];
      const critic_prompt_shas = {};
      for (const c of assignedCritics) {
        critic_prompt_shas[c] = CRITIC_SHAS[c] || null;
      }
      // Phase Grounding: surface PostRAG entity-resolution status to critics so
      // they weight an unresolved organism appropriately. Empty for pre-Grounding
      // rows (status null), so existing batch shape is unchanged.
      const resolutionNote = renderResolutionAnnotation(r.entity_resolution_status, {
        subject: r.resolved_subject_entity_id,
        object: r.resolved_object_entity_id,
      });
      return {
        staging_id: r.id,
        target_table: r.target_table,
        claim: {
          target_table: r.target_table,
          ...payload,
          ...(resolutionNote ? { entity_resolution: resolutionNote } : {}),
        },
        critics: assignedCritics, // names only; subagent looks up template
        critic_prompt_shas, // Phase Provenance: per-critic SHA fingerprint
      };
    });
    // Only include critic templates actually referenced by THIS batch's claims.
    // A homogeneous batch ships 2 templates instead of 5; a diverse batch 3-4.
    const usedCritics = new Set();
    for (const c of claims) for (const cn of c.critics) usedCritics.add(cn);
    for (const cn of usedCritics) usedHistogram[cn] = (usedHistogram[cn] || 0) + 1;
    const batchCriticTemplates = {};
    for (const cn of usedCritics) batchCriticTemplates[cn] = criticTemplates[cn];

    const batch = { batch_id: batchIdx, critic_templates: batchCriticTemplates, claims };
    const fname = `batch-${String(batchIdx).padStart(3, '0')}.json`;
    fs.writeFileSync(path.join(OUT_DIR, fname), JSON.stringify(batch, null, 2));
    batchIdx++;
  }
  console.log(`Wrote ${batchIdx} batches to ${OUT_DIR}`);
  console.log(`Per-batch: up to ${BATCH_SIZE} claims × 2 critics = ${BATCH_SIZE * 2} verdicts`);
  console.log(`Shape: shared critic_templates (per-batch, used-only) + bare claims.`);
  console.log(`Critics referenced this run:`, usedHistogram);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
