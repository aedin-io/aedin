#!/usr/bin/env node
/**
 * Follow-up C: retrospective exposure sizing for common-name species resolution.
 *
 * Builds the TIGHTENED candidate set (drops case-(b) false alarms detectable
 * without a PDF: abbreviated genus "G. epithet" or bare epithet present in the
 * quote), draws a stratified random sample across distinct source documents,
 * and emits a worksheet for the PDF-grounded (a)/(c) classification step.
 *
 * Read-only. Writes only the worksheet JSON/markdown to docs/ via the caller.
 */
const Database = require('better-sqlite3');
const path = require('path');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const db = new Database(CORPUS_DB, { readonly: true });

// --- Loose candidate pull (subject + object), tag side, carry source file_path
const sql = (side) => {
  const ent = side === 'subject' ? 'subject_entity_id' : 'object_entity_id';
  return `
    SELECT c.id AS claim_id, c.source_id, e.scientific_name AS sci, '${side}' AS side,
           c.source_quote AS quote, c.extracted_claim AS extracted,
           c.interaction_category AS cat, src.file_path AS file_path,
           src.title AS src_title
    FROM claims c
    JOIN entities e ON e.id = c.${ent}
    JOIN sources src ON src.id = c.source_id
    WHERE c.data_tier = 'tier1_paper'
      AND c.source_quote IS NOT NULL AND c.source_quote <> ''
      AND e.scientific_name LIKE '% %'
      AND e.scientific_name NOT LIKE '%(family)%'
      AND e.scientific_name NOT LIKE '% sp.%'
      AND e.scientific_name NOT LIKE '% spp.%'
      AND e.scientific_name NOT LIKE '%''%'
      AND (LENGTH(e.scientific_name) - LENGTH(REPLACE(e.scientific_name, ' ', ''))) = 1
      AND instr(LOWER(c.source_quote), LOWER(e.scientific_name)) = 0`;
};

const rows = [...db.prepare(sql('subject')).all(), ...db.prepare(sql('object')).all()];

// --- Tighten: drop rows where epithet OR "G. epithet" is in the quote (case b)
function isCaseB(sci, quote) {
  const q = quote.toLowerCase();
  const parts = sci.trim().split(/\s+/);
  if (parts.length < 2) return false;
  const genus = parts[0];
  const epithet = parts[1].toLowerCase();
  // bare epithet present (word-boundary-ish)
  if (epithet.length >= 4 && new RegExp(`\\b${epithet}\\b`).test(q)) return true;
  // abbreviated genus "G. epithet" or "G epithet"
  const abbrev = genus[0].toLowerCase();
  if (new RegExp(`\\b${abbrev}\\.?\\s+${epithet}\\b`).test(q)) return true;
  return false;
}

const tightened = rows.filter((r) => !isCaseB(r.sci, r.quote));

// --- Report population sizes
const looseN = rows.length;
const tightN = tightened.length;
const tightBySource = {};
for (const r of tightened) {
  tightBySource[r.source_id] = (tightBySource[r.source_id] || 0) + 1;
}
const distinctSources = Object.keys(tightBySource).length;

// --- file_path landscape (how many tightened rows have a resolvable PDF?)
const pathPrefix = {};
let nullPaths = 0;
for (const r of tightened) {
  if (!r.file_path) { nullPaths++; continue; }
  const pre = r.file_path.split('/').slice(0, 2).join('/');
  pathPrefix[pre] = (pathPrefix[pre] || 0) + 1;
}

// --- Stratified sample: shuffle source order, take 1 row per source until ~50
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260526); // deterministic seed = today's date
const bySource = {};
for (const r of tightened) (bySource[r.source_id] ||= []).push(r);
const sourceIds = Object.keys(bySource);
// shuffle source ids
for (let i = sourceIds.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [sourceIds[i], sourceIds[j]] = [sourceIds[j], sourceIds[i]];
}
const sample = [];
const TARGET = 50;
for (const sid of sourceIds) {
  const pool = bySource[sid];
  const pick = pool[Math.floor(rand() * pool.length)];
  sample.push(pick);
  if (sample.length >= TARGET) break;
}

console.log(JSON.stringify({
  loose_total: looseN,
  tightened_total: tightN,
  tightened_distinct_sources: distinctSources,
  tightened_null_filepath: nullPaths,
  path_prefixes: pathPrefix,
  sample_size: sample.length,
}, null, 2));

// Emit the worksheet rows to a JSON file for the classification step.
const fs = require('fs');
fs.writeFileSync(
  path.join(__dirname, 'audit-species-overspec-sample.json'),
  JSON.stringify(sample, null, 2)
);
console.log('\nWrote sample worksheet -> backend/audit-species-overspec-sample.json');
