#!/usr/bin/env node
'use strict';
/**
 * apply-kingdom-verdicts.js — apply the bio_category contradictions that a
 * panel of critics confirmed, and only those.
 *
 * align-bio-category.js deliberately does NOT act on contradictions: those rows
 * are genus collisions where an external authority may have resolved the wrong
 * namesake. It writes them to a review file; independent critics adjudicate;
 * this script applies the confirmed subset.
 *
 * The gate (lib/kingdom-consensus.js) requires >=2 non-low-confidence votes for
 * one value and ZERO critics naming any other — see that module for why a lone
 * dissent blocks rather than being outvoted.
 *
 * WRITES ONE COLUMN: entities.bio_category, only for `confirmed` rows whose
 * value differs from what we already store.
 *
 *   node apply-kingdom-verdicts.js --review=<contradictions.json> --verdicts=<dir>
 *   node apply-kingdom-verdicts.js ... --apply
 *   node apply-kingdom-verdicts.js --undo --apply
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { consensusFor } = require('./lib/kingdom-consensus.js');
const { logRevisions } = require('./lib/revision-log.js');

const METHOD = 'align_bio_category_adjudicated';
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };

const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB, apply ? {} : { readonly: true });

if (argv.includes('--undo')) {
  const rows = db.prepare(
    `SELECT target_id, before_value FROM revision_log
     WHERE target_type='entity' AND field='bio_category' AND method=? ORDER BY id DESC`).all(METHOD);
  console.log(`=== apply-kingdom-verdicts UNDO (${apply ? 'APPLY' : 'DRY-RUN'}) — ${rows.length} rows ===`);
  if (apply) {
    const seen = new Set();
    db.transaction(() => {
      for (const r of rows) {
        if (seen.has(r.target_id)) continue;
        seen.add(r.target_id);
        db.prepare('UPDATE entities SET bio_category = ? WHERE id = ?').run(r.before_value, r.target_id);
      }
      db.prepare(`DELETE FROM revision_log WHERE target_type='entity' AND field='bio_category' AND method=?`).run(METHOD);
    })();
    console.log(`Restored ${seen.size} rows.`);
  } else console.log('Dry run. Re-run with --apply.');
  process.exit(0);
}

// JSONL is accepted alongside JSON: a critic writing 91 verdicts in one call
// drops the connection, so they append in chunks, and a partly-written JSONL
// file still parses line by line instead of failing whole.
function readVerdicts(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  if (!file.endsWith('.jsonl')) return JSON.parse(raw);
  const out = [];
  raw.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try { out.push(JSON.parse(t)); }
    catch { console.warn(`  skipped unparseable line ${i + 1} of ${path.basename(file)}`); }
  });
  return out;
}

const review = JSON.parse(fs.readFileSync(flag('review'), 'utf8'));
const dir = flag('verdicts');
const files = fs.readdirSync(dir).filter(f => /^verdicts-.*\.jsonl?$/.test(f)).sort();
if (files.length < 2) { console.error(`Need >=2 critic verdict files in ${dir}; found ${files.length}.`); process.exit(1); }

// critic -> entity_id -> verdict
const byCritic = files.map((f) => {
  const critic = f.replace(/^verdicts-/, '').replace(/\.jsonl?$/, '');
  const list = readVerdicts(path.join(dir, f));
  return { critic, map: new Map(list.map(v => [v.entity_id, v])) };
});
console.log(`critics: ${byCritic.map(c => `${c.critic}(${c.map.size})`).join(', ')}\n`);

const upd = db.prepare('UPDATE entities SET bio_category = ? WHERE id = ?');
const tally = { confirmed_changed: 0, confirmed_no_change: 0, disputed: 0, insufficient: 0, unreviewed: 0 };
const changes = [];
const disputed = [];

db.transaction(() => {
  for (const r of review) {
    const verdicts = byCritic.map(c => c.map.get(r.entity_id)).filter(Boolean);
    if (!verdicts.length) { tally.unreviewed++; continue; }
    const res = consensusFor({ ours: r.ours, ottProposes: r.ott_proposes }, verdicts);

    if (res.outcome === 'disputed') {
      tally.disputed++;
      disputed.push({ ...r, consensus: res, votes: byCritic.map((c, i) => ({ critic: c.critic, v: verdicts[i] })) });
      continue;
    }
    if (res.outcome !== 'confirmed') { tally.insufficient++; continue; }
    if (res.value === r.ours) { tally.confirmed_no_change++; continue; }   // critics backed us

    tally.confirmed_changed++;
    changes.push({ ...r, to: res.value, votes: res.votes });
    if (!apply) continue;
    upd.run(res.value, r.entity_id);
    logRevisions(db, {
      targetType: 'entity', targetId: r.entity_id, changedBy: 'kingdom-critic-panel', method: METHOD,
      reason: `${res.votes} independent critics agreed ${r.scientific_name} is ${res.value}, not ${r.ours}; no critic named another kingdom`,
      changes: [{ field: 'bio_category', before: r.ours, after: res.value }],
    });
  }
})();

console.log(`=== apply-kingdom-verdicts (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`review rows            : ${review.length}`);
console.log(`  CONFIRMED, changed   : ${tally.confirmed_changed}`);
console.log(`  CONFIRMED, we were right: ${tally.confirmed_no_change}`);
console.log(`  DISPUTED (blocked)   : ${tally.disputed}`);
console.log(`  insufficient votes   : ${tally.insufficient}`);
console.log(`  not reviewed         : ${tally.unreviewed}`);
if (changes.length) {
  const pairs = {};
  changes.forEach(c => { const k = `${c.ours} -> ${c.to}`; pairs[k] = (pairs[k] || 0) + 1; });
  console.log('\nchanges:');
  for (const [p, n] of Object.entries(pairs).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${p}`);
}
if (disputed.length) {
  console.log('\nDISPUTED — left alone, a critic named a different organism:');
  for (const d of disputed) console.log(`  ${d.scientific_name.padEnd(32)} ours=${d.ours} ott=${d.ott_proposes}`);
  const out = path.join(dir, 'disputed.json');
  fs.writeFileSync(out, JSON.stringify(disputed, null, 2));
  console.log(`  -> ${out}`);
}
if (!apply) console.log('\nDry run. Re-run with --apply.');
db.close();
