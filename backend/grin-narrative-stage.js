'use strict';
/**
 * grin-narrative-stage.js — stage resistance and trait claims extracted from GRIN narratives.
 *
 * Pure builders:
 *   buildResistanceStagingPayload(c) — resolve the attacker (abstain-or-build), shape a
 *     staging payload that promote-staged-claims.js already understands (resistance_level,
 *     the two resistance categories). Resistance is region-independent →
 *     regional_context='Global' (passes the promote-time locality gate).
 *   buildTraitStagingPayload(claim, vocab) — dispatches the polymorphic `value` into the
 *     kind-correct column (value_numeric/value_text/value_json) per the trait's value_kind,
 *     validates via validateClaimAgainstVocab, returns {hold,reason} or {hold:false,payload}.
 *
 * ai_vouch_status='uncertain' so rows are eligible for multi-critic-batch-prepare without
 * a single-critic pre-filter.
 *
 * CLI:
 *   node grin-narrative-stage.js [--in-dir=DIR] [--run-id=N] [--phase=resistance|traits]
 * reads claims-*.json from --in-dir (default backend/grin-batches), ensures one
 * GRIN source + queue row, inserts extraction_staging rows, and reports held items.
 */
const { resolveAttackerName } = require('./lib/attacker-name-resolve');
const { validateClaimAgainstVocab } = require('./lib/trait-vocabulary');

const RESISTANCE_LEVELS = new Set(['complete', 'strong', 'partial', 'tolerant']);
const COEVOLUTION_VALUES = new Set(['gene_for_gene', 'quantitative']);

function buildResistanceStagingPayload(c) {
  const resolved = resolveAttackerName(c.attacker_name);
  if (!resolved) {
    return { hold: true, reason: 'attacker_unresolved', attacker: c.attacker_name };
  }
  const level = typeof c.resistance_level === 'string'
    ? c.resistance_level.trim().toLowerCase() : null;
  const coev = typeof c.coevolution_structure === 'string'
    ? c.coevolution_structure.trim().toLowerCase() : null;

  const payload = {
    subject_organism: c.parent_scientific_name,
    subject_variety: c.variety_name,
    object_organism: resolved.scientificName,
    interaction_type: resolved.category,    // resolver is authoritative
    effect_direction: 'beneficial',
    resistance_level: RESISTANCE_LEVELS.has(level) ? level : null,
    source_quote: c.source_quote || null,
    regional_context: 'Global',
    confidence_score: 0.85,
  };
  if (COEVOLUTION_VALUES.has(coev)) payload.coevolution_structure = coev;
  return { hold: false, payload };
}

// Build an entity_trait staging payload from an extractor trait claim. Dispatches
// the polymorphic `value` into the kind-correct column per traits_vocabulary, lowercases
// categoricals (only growth_habit/nitrogen_fixation have canonicalizers), validates,
// and returns a payload promoteEntityTraitRow understands — or holds on any failure.
function buildTraitStagingPayload(claim, vocab) {
  const v = vocab[claim.trait_name];
  if (!v) return { hold: true, reason: `unknown_trait:${claim.trait_name}` };

  const candidate = { trait_name: claim.trait_name, value_numeric: null, value_text: null, value_json: null,
    unit: claim.unit || v.expected_unit || null };
  if (v.value_kind === 'numeric') candidate.value_numeric = Number(claim.value);
  else if (v.value_kind === 'categorical' || v.value_kind === 'boolean') candidate.value_text = String(claim.value).toLowerCase().trim();
  else if (v.value_kind === 'range') candidate.value_json = claim.value;       // expect {min,max}
  else if (v.value_kind === 'list') candidate.value_json = Array.isArray(claim.value) ? claim.value : [claim.value];

  const valid = validateClaimAgainstVocab(vocab, candidate);   // may canonicalize candidate.value_text
  if (!valid.ok) return { hold: true, reason: valid.error };

  return {
    hold: false,
    payload: {
      scientific_name: claim.parent_scientific_name,
      variety_name: claim.variety_name,
      trait_name: claim.trait_name,
      value_numeric: candidate.value_numeric,
      value_text: candidate.value_text,
      value_json: candidate.value_json,
      unit: candidate.unit,
      source_quote: claim.source_quote || null,
      confidence_score: 0.85,
      evidence_tier: 'direct',
    },
  };
}

module.exports = { buildResistanceStagingPayload, buildTraitStagingPayload };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const a = argv.find(s => s.startsWith(`--${n}=`));
    return a ? a.split('=', 2)[1] : d;
  };
  const inDir = flag('in-dir', path.join(__dirname, 'grin-batches'));
  const runId = parseInt(flag('run-id', ''), 10) || null;
  const phase = flag('phase', 'resistance');
  const GRIN_SOURCE_PATH = 'grin://variety-narratives';

  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await db.run('PRAGMA busy_timeout=30000');

    // Ensure the single GRIN source + queue row.
    let src = await db.get('SELECT * FROM sources WHERE file_path = ?', GRIN_SOURCE_PATH);
    if (!src) {
      const r = await db.run(
        `INSERT INTO sources (title, authors, publication, year, source_type, url, file_path, ingested_at, extraction_model, extraction_version)
         VALUES (?, ?, ?, ?, 'database', ?, ?, datetime('now'), 'claude-code-grin-extractor', 1)`,
        ['USDA GRIN-GLOBAL variety narratives', 'USDA ARS GRIN', 'Germplasm Resources Information Network',
         null, 'https://npgsweb.ars-grin.gov', GRIN_SOURCE_PATH]
      );
      src = await db.get('SELECT * FROM sources WHERE id = ?', r.lastID);
    }
    let queue = await db.get('SELECT * FROM extraction_queue WHERE file_path = ?', GRIN_SOURCE_PATH);
    if (!queue) {
      const r = await db.run(
        `INSERT INTO extraction_queue (file_path, source_type, status, source_id, added_at)
         VALUES (?, 'database', 'running', ?, datetime('now'))`,
        [GRIN_SOURCE_PATH, src.id]
      );
      queue = await db.get('SELECT * FROM extraction_queue WHERE id = ?', r.lastID);
    }

    let vocab = null;
    if (phase === 'traits') {
      const { loadVocabulary } = require('./lib/trait-vocabulary');
      vocab = await loadVocabulary(db);
    }

    const files = fs.readdirSync(inDir).filter(f => f.startsWith('claims-') && f.endsWith('.json'));
    let staged = 0;
    const held = {};
    for (const f of files) {
      const claims = JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8'));
      for (const c of claims) {
        const built = phase === 'traits'
          ? buildTraitStagingPayload(c, vocab)
          : buildResistanceStagingPayload(c);
        // Prefer the specific attacker name (resistance path's curated-map worklist signal);
        // fall back to the reason for the trait path (whose builder has no `attacker`).
        if (built.hold) { const hk = built.attacker || built.reason; held[hk] = (held[hk] || 0) + 1; continue; }
        const targetTable = phase === 'traits' ? 'entity_trait' : 'interactions';
        await db.run(
          `INSERT INTO extraction_staging (queue_id, source_id, target_table, payload, ai_vouch_status, run_id)
           VALUES (?, ?, ?, ?, 'uncertain', ?)`,
          [queue.id, src.id, targetTable, JSON.stringify(built.payload), runId]
        );
        staged++;
      }
    }
    await db.close();
    console.log(`[grin-stage] phase=${phase} staged=${staged} held=${Object.values(held).reduce((a, b) => a + b, 0)}`);
    if (Object.keys(held).length) console.log('[grin-stage] held (extend curated map):', held);
  })().catch(e => { console.error('grin-narrative-stage failed:', e.message); process.exit(1); });
}
