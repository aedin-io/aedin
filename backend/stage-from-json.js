#!/usr/bin/env node
/**
 * stage-from-json.js — insert staging rows from an extractor agent's JSON output.
 *
 * Usage:
 *   node stage-from-json.js <json-file> <pdf-file-path> [--source-type=book] [--run-id=N]
 *
 * - Reads the extractor JSON (six top-level keys per .claude/agents/extractor.md).
 * - Upserts a sources row keyed on file_path (creates if absent).
 * - Upserts an extraction_queue row keyed on file_path.
 * - Inserts staging rows: interactions, crop_vulnerabilities, biocontrol,
 *   crop_enrichment. Stays consistent with extract-source.js's payload shape
 *   so the existing Haiku/multi-critic/promote pipeline runs unchanged.
 *
 * Idempotent: re-running with the same json file appends fresh staging rows
 * (the dedup happens at the source/queue level, not per claim — this matches
 * the API-path behavior).
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const { loadVocabulary, validateClaimAgainstVocab } = require('./lib/trait-vocabulary');
const { ATTRACTOR_CATEGORIES, IMPACT_CLASSES } = require('./lib/interaction-vocabulary');

const DB_PATH = CORPUS_DB;

const argv = process.argv.slice(2);
let sourceType = 'book';
let runId = null;
const positional = [];
for (const a of argv) {
  if (a.startsWith('--source-type=')) sourceType = a.split('=', 2)[1];
  else if (a.startsWith('--run-id=')) runId = parseInt(a.split('=', 2)[1], 10) || null;
  else positional.push(a);
}
const [jsonFile, pdfPath] = positional;

if (!jsonFile || !pdfPath) {
  console.error('Usage: node stage-from-json.js <extractor-json-output> <pdf-file-path> [--source-type=book]');
  process.exit(1);
}

(async () => {
  const raw = fs.readFileSync(jsonFile, 'utf8');
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!cleaned.startsWith('{')) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
  }
  const extracted = JSON.parse(cleaned);
  const {
    source_meta = {},
    interactions = [],
    crop_vulnerabilities = [],
    biocontrol = [],
    entity_traits = [],
    attractor_relationships = [],
    crop_enrichment = [],
    new_crops = []
  } = extracted;

  const file_path = path.resolve(pdfPath);
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  const vocab = await loadVocabulary(db);

  // Upsert queue row
  let queueRow = await db.get('SELECT * FROM extraction_queue WHERE file_path = ?', file_path);
  if (!queueRow) {
    const r = await db.run(
      `INSERT INTO extraction_queue (file_path, source_type, status, added_at) VALUES (?, ?, 'running', datetime('now'))`,
      [file_path, sourceType]
    );
    queueRow = await db.get('SELECT * FROM extraction_queue WHERE id = ?', r.lastID);
  }

  // Upsert source row keyed on file_path
  let sourceRow = await db.get('SELECT * FROM sources WHERE file_path = ?', file_path);
  if (!sourceRow) {
    const authorsValue = Array.isArray(source_meta.authors)
      ? source_meta.authors.join(', ')
      : (source_meta.authors && typeof source_meta.authors === 'object')
        ? JSON.stringify(source_meta.authors)
        : (source_meta.authors || null);
    const r = await db.run(
      `INSERT INTO sources (title, authors, publication, year, source_type, url, file_path, region_focus, crop_focus, ingested_at, extraction_model, extraction_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 1)`,
      [
        source_meta.title || file_path.split('/').pop(),
        authorsValue,
        source_meta.publication || null,
        source_meta.year || null,
        source_meta.source_type || sourceType || 'unknown',
        null,
        file_path,
        source_meta.region_focus || null,
        source_meta.crop_focus || null,
        'claude-code-extractor-agent'
      ]
    );
    sourceRow = await db.get('SELECT * FROM sources WHERE id = ?', r.lastID);
  }

  // Update queue with source_id
  if (!queueRow.source_id) {
    await db.run('UPDATE extraction_queue SET source_id = ? WHERE id = ?', [sourceRow.id, queueRow.id]);
  }

  // Resolve organism names: keep what extractor provided; the existing
  // load-globi-claims promotion step handles binomial dedup.
  let staged = 0;
  const stage = async (table, item) => {
    try {
      await db.run(
        `INSERT INTO extraction_staging (queue_id, source_id, target_table, payload, run_id) VALUES (?, ?, ?, ?, ?)`,
        [queueRow.id, sourceRow.id, table, JSON.stringify(item), runId]
      );
      staged++;
    } catch (err) {
      console.warn(`  ⚠ staging ${table} failed: ${err.message}`);
    }
  };

  for (const item of interactions) {
    // Normalize: interactions in extractor JSON use subject_organism / object_organism;
    // staging payload mirrors the API path which writes subject_crop / object_crop.
    item.subject_crop = item.subject_organism || item.subject_crop;
    item.object_crop = item.object_organism || item.object_crop;
    await stage('interactions', item);
  }
  for (const item of crop_vulnerabilities) await stage('crop_vulnerabilities', item);
  for (const item of biocontrol) {
    const mapped = {
      subject_crop: item.beneficial_organism,
      subject_common_name: item.beneficial_common_name,
      object_crop: item.target_pest,
      object_common_name: item.target_pest_common_name,
      object_variety: item.target_pest_variety || null,
      interaction_type: 'biocontrol',
      effect_direction: 'beneficial',
      mechanism: item.mechanism || item.control_type,
      confidence_score: item.confidence_score,
      evidence_tier: item.evidence_tier,
      extracted_claim: item.extracted_claim,
      source_quote: item.source_quote,
      source_page: item.source_page,
      regional_context: item.regional_context,
    };
    await stage('interactions', mapped);
  }
  for (const item of crop_enrichment) {
    if (!item.scientific_name) continue;
    const ent = await db.get('SELECT data_completeness FROM entities WHERE scientific_name = ? COLLATE NOCASE', item.scientific_name);
    if (ent && ent.data_completeness === 'full') continue;
    await stage('crops', item);
  }

  for (const item of entity_traits) {
    const v = validateClaimAgainstVocab(vocab, item);
    if (!v.ok) {
      console.warn(`[stage-from-json] entity_traits row rejected: ${v.error}`);
      continue;
    }
    await stage('entity_trait', item);
  }

  for (const item of attractor_relationships) {
    if (!ATTRACTOR_CATEGORIES.has(item.interaction_category)) {
      console.warn(`[stage-from-json] attractor_relationships row rejected: bad interaction_category ${item.interaction_category}`);
      continue;
    }
    if (item.impact_class && !IMPACT_CLASSES.has(item.impact_class)) {
      console.warn(`[stage-from-json] attractor_relationships row rejected: bad impact_class ${item.impact_class}`);
      continue;
    }
    await stage('attractor_relationship', item);
  }

  // new_crops handling: same as extract-source.js
  let newCrops = 0;
  for (const entry of new_crops) {
    const sciName = entry.scientific_name || entry;
    if (!sciName) continue;
    const existing = await db.get('SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE', sciName);
    if (!existing) {
      try {
        await db.run(
          `INSERT OR IGNORE INTO entities (scientific_name, common_name, bio_category, primary_role, source_table, data_completeness)
           VALUES (?, ?, 'plantae', 'crop', 'llm_extraction', 'manual')`,
          [sciName, entry.common_name || null]
        );
        await db.run(
          `INSERT OR IGNORE INTO pending_crops (scientific_name, common_name, region_context, source_id)
           VALUES (?, ?, ?, ?)`,
          [sciName, entry.common_name || null, entry.region_context || entry.region || null, sourceRow.id]
        );
        newCrops++;
      } catch (err) {
        console.warn(`  ⚠ inserting new crop ${sciName} failed: ${err.message}`);
      }
    }
  }

  await db.run(`UPDATE extraction_queue SET status='running' WHERE id = ?`, queueRow.id);
  console.log(JSON.stringify({ source_id: sourceRow.id, queue_id: queueRow.id, staged, newCrops }));
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
