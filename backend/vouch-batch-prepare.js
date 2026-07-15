#!/usr/bin/env node
/**
 * vouch-batch-prepare.js — subscription-only first-pass Haiku-equivalent vouch (Pass 8+)
 *
 * Pulls eligible staging rows (ai_vouch_status='pending'), builds one prompt per
 * claim from .claude/agents/extractor-vouch.md (frontmatter + body with {{CLAIM}}
 * substituted), and writes batch JSON files to /tmp/claude/vouch-batches/batch-NNN.json.
 * A general-purpose Agent (subscription tokens) reads each batch, evaluates each
 * claim against the extractor-vouch contract, writes verdict JSONs to
 * /tmp/claude/vouch-verdicts/, and vouch-batch-import.js writes them back into
 * extraction_staging.ai_vouch_status / ai_vouch_note.
 *
 * Replaces the Anthropic-API-direct path in vouch-staged-claims.js for the
 * duration of subscription-only mode (see memory/feedback_subscription_only_mode.md).
 *
 * Usage:
 *   node vouch-batch-prepare.js [--batch-size=30] [--max-rows=N] [--source-id=N]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const VOUCH_AGENT_PATH = path.resolve(__dirname, '../.claude/agents/extractor-vouch.md');
const OUT_DIR = process.env.VOUCH_BATCH_OUT_DIR || path.join(__dirname, 'vouch-batches');

const argv = process.argv.slice(2);
function flag(name, def) {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=', 2)[1] : def;
}
const BATCH_SIZE = parseInt(flag('batch-size', '30'), 10) || 30;
const MAX_ROWS = parseInt(flag('max-rows', '999999'), 10) || 999999;
const SOURCE_ID = parseInt(flag('source-id', '0'), 10) || 0;

function loadVouchPrompt() {
  const raw = fs.readFileSync(VOUCH_AGENT_PATH, 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fm) throw new Error(`vouch agent at ${VOUCH_AGENT_PATH} missing frontmatter`);
  const [, frontmatter, body] = fm;
  function fmField(key, fallback) {
    const re = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|(.+))$`, 'm');
    const m = frontmatter.match(re);
    if (!m) return fallback;
    return (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim();
  }
  const spec = {
    name: fmField('name', 'extractor-vouch'),
    systemPrompt: fmField('system_prompt', ''),
    model: fmField('model', 'claude-haiku-4-5-20251001'),
    body,
  };
  if (!spec.systemPrompt) throw new Error('vouch agent missing system_prompt');
  if (!spec.body.includes('{{CLAIM}}')) throw new Error('vouch agent body missing {{CLAIM}} placeholder');
  return spec;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.startsWith('batch-') && f.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const spec = loadVouchPrompt();
  console.log(`Loaded vouch prompt: name=${spec.name}, model=${spec.model}`);

  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  let sql = `
    SELECT id, source_id, target_table, payload
    FROM extraction_staging
    WHERE ai_vouch_status = 'pending'
  `;
  const params = [];
  if (SOURCE_ID) { sql += ` AND source_id = ?`; params.push(SOURCE_ID); }
  sql += ` ORDER BY id LIMIT ${MAX_ROWS}`;

  const rows = await db.all(sql, params);
  await db.close();
  console.log(`Eligible pending rows: ${rows.length}`);

  if (rows.length === 0) { console.log('Nothing to prepare.'); return; }

  // Shape: each batch carries the vouch template ONCE at the top level, then
  // bare claims. Subagent applies the template (with {{CLAIM}} → JSON.stringify(claim))
  // to each claim. ~30% smaller per batch than the old per-claim-body_prompt layout.
  let batchIdx = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const batch = {
      batch_id: batchIdx,
      vouch_agent: spec.name,
      vouch_model: spec.model,
      vouch_template: {
        system_prompt: spec.systemPrompt,
        body_template: spec.body, // contains {{CLAIM}} placeholder; subagent substitutes
      },
      claims: slice.map(r => {
        let payload;
        try { payload = JSON.parse(r.payload); } catch { payload = { _payload: r.payload }; }
        return {
          staging_id: r.id,
          target_table: r.target_table,
          claim: { target_table: r.target_table, ...payload },
        };
      }),
    };
    const fname = `batch-${String(batchIdx).padStart(3, '0')}.json`;
    fs.writeFileSync(path.join(OUT_DIR, fname), JSON.stringify(batch, null, 2));
    batchIdx++;
  }
  console.log(`Wrote ${batchIdx} batches to ${OUT_DIR}`);
  console.log(`Per-batch: up to ${BATCH_SIZE} claims × 1 verdict each = ${BATCH_SIZE} verdicts`);
  console.log(`Shape: shared vouch_template + bare claims (no per-claim body_prompt duplication).`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
