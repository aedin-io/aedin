#!/usr/bin/env node
'use strict';
/**
 * report-taxonomy-disagreement.js — where our stored taxonomy disagrees with OTT.
 *
 * READ-ONLY. Writes nothing to entities. Disagreement is derivable from ott_id
 * plus the tree, so storing it would create a second copy that goes stale.
 *
 * Answers, mechanically: how many genus-collision corruptions actually exist
 * (only 5 have ever been confirmed by hand); the canonical order for each family
 * carrying two order names; and how many entities OTT can give a subfamily we
 * do not have.
 *
 *   node report-taxonomy-disagreement.js
 *   node report-taxonomy-disagreement.js --out=report.json
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const { CORPUS_DB, OTT_DB } = require('./lib/db-paths.cjs');
const { lineageRanks, compareFields, LINNAEAN } = require('./lib/ott-lineage.js');
const { OTT_RELEASE, checkOttDbVersion } = require('./lib/ott-release.js');

const arg = (f) => {
  const h = process.argv.find(a => a.startsWith(`--${f}=`));
  return h ? h.slice(f.length + 3) : null;
};

const out = arg('out');

const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB, { readonly: true });
const ottDb = new Database(OTT_DB, { readonly: true });

{
  const v = checkOttDbVersion(ottDb);
  if (!v.ok) {
    console.error(
      `FATAL: ott.sqlite version mismatch — expected OTT ${OTT_RELEASE.version}, ` +
      `found ${v.found === null ? '(no ott_meta.version row — incomplete or stale build)' : v.found}. ` +
      `Rebuild with: node build-ott-db.js`
    );
    db.close(); ottDb.close();
    process.exit(1);
  }
}

const rows = db.prepare(`
  SELECT id, scientific_name, ott_id, ott_status, kingdom, phylum, taxon_class AS class,
         taxon_order AS "order", family, genus
  FROM entities
  WHERE ott_id IS NOT NULL AND merged_into_entity_id IS NULL`).all();

// Reproducibility split: resolved_local is derivable from the pinned OTT
// dump alone; resolved_tnrs depends on a live API call made at resolve
// time. Mixing them into one "vs OTT" measurement without saying so would
// quietly make the report partly non-reproducible.
const statusTally = {};
for (const e of rows) statusTally[e.ott_status] = (statusTally[e.ott_status] || 0) + 1;

const summary = {}; const pairs = {}; const detail = [];
let subfamilyGain = 0;
for (const f of LINNAEAN) summary[f] = { agree: 0, differ: 0, ours_missing: 0, ott_missing: 0, both_missing: 0 };

for (const e of rows) {
  const theirs = lineageRanks(ottDb, e.ott_id);
  if (theirs.subfamily) subfamilyGain++;
  const cmp = compareFields(e, theirs);
  for (const c of cmp) {
    summary[c.field][c.verdict]++;
    if (c.bothMissing) summary[c.field].both_missing++;
    if (c.verdict === 'differ') {
      const k = `${c.field}: ${c.ours} -> ${c.theirs}`;
      pairs[k] = (pairs[k] || 0) + 1;
      if (out) detail.push({ id: e.id, name: e.scientific_name, ...c });
    }
  }
}

console.log(`=== taxonomy disagreement vs OTT ${OTT_RELEASE.version} ===`);
console.log(`resolved entities compared: ${rows.length}`);
console.log(`  resolved_local (reproducible from the pinned OTT ${OTT_RELEASE.version} dump): ${statusTally.resolved_local || 0}`);
console.log(`  resolved_tnrs  (live-API-derived at resolve time, NOT reproducible from the dump alone): ${statusTally.resolved_tnrs || 0}`);
if (statusTally.resolved_tnrs) {
  console.log(`  NOTE: this comparison mixes reproducible (resolved_local) and non-reproducible (resolved_tnrs) rows.`);
}
console.log(`\n  (both_missing rows are counted within agree — absent data on both sides, not concordance)\n`);
for (const f of LINNAEAN) {
  const s = summary[f];
  console.log(`  ${f.padEnd(8)} agree=${String(s.agree).padStart(6)} differ=${String(s.differ).padStart(6)}` +
              ` ours_missing=${String(s.ours_missing).padStart(6)} ott_missing=${String(s.ott_missing).padStart(6)}` +
              ` both_missing=${String(s.both_missing).padStart(6)}`);
}
console.log(`\n  subfamily available from OTT for ${subfamilyGain} entities (we store none)`);
console.log(`\ntop 20 differing value pairs:`);
for (const [k, v] of Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}

if (out) { fs.writeFileSync(out, JSON.stringify({ ottVersion: OTT_RELEASE.version, statusTally, summary, pairs, detail }, null, 2));
  console.log(`\nRow-level detail written to ${out} (${detail.length} rows).`); }
db.close(); ottDb.close();
