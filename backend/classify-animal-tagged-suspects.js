#!/usr/bin/env node
'use strict';
/**
 * classify-animal-tagged-suspects.js — DRY-RUN batch classifier for the 107 animal-tagged +
 * NULL-kingdom entities (the entity-taxonomy-corruption suspect set). For each, ask GBIF
 * (via the conservative resolveTaxonomy — abstains on collision/low-confidence) what it would
 * resolve to, and bucket the outcome. READ-ONLY — no writes, no D1. Use before deciding which
 * to fix with fix-taxonomy-mislabel.js.
 *
 * Usage: node classify-animal-tagged-suspects.js
 */
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { resolveTaxonomy } = require('./lib/gbif-resolve');

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: String(e.message || e) }; } } }
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const rows = await db.all(
    `SELECT id, scientific_name, bio_category FROM entities
     WHERE bio_category IN ('invertebrate','vertebrate') AND (kingdom IS NULL OR kingdom='')
     ORDER BY scientific_name`
  );
  await db.close();

  const results = await mapLimit(rows, 6, async (e) => {
    const res = await resolveTaxonomy(e.scientific_name, null);
    let bucket;
    if (res.error) bucket = 'error';
    else if (res.accept && (res.bio_category === 'plantae' || res.bio_category === 'fungi')) bucket = `fix:${res.bio_category}`;
    else if (res.accept) bucket = `leave:animal(${res.bio_category})`;
    else bucket = `abstain:${res.reason}`;
    return { name: e.scientific_name, cur: e.bio_category, bucket, gbif: res.accept ? res.bio_category : null, conf: res.confidence, mt: res.matchType };
  });

  const groups = {};
  for (const r of results) (groups[r.bucket] = groups[r.bucket] || []).push(r);
  const order = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

  console.log(`=== DRY-RUN classification of ${rows.length} animal-tagged + NULL-kingdom suspects ===\n`);
  let fixable = 0;
  for (const g of order) {
    const list = groups[g];
    if (g.startsWith('fix:')) fixable += list.length;
    console.log(`### ${g} — ${list.length}`);
    for (const r of list) console.log(`   ${r.name}${r.gbif ? ` (gbif=${r.gbif}, conf=${r.conf}, ${r.mt})` : ''}`);
    console.log('');
  }
  console.log('=== HEADLINE ===');
  console.log(`FIXABLE (GBIF→plantae/fungi, conservative): ${fixable}`);
  console.log(`LEAVE/ABSTAIN (genuine animal or unresolvable): ${rows.length - fixable}`);
  console.log('\nApply a fix with: node fix-taxonomy-mislabel.js --id=<id> --apply  (then D1 publish per served row)');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
