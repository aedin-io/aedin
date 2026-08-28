#!/usr/bin/env node
'use strict';
/**
 * align-bio-category.js — use the Open Tree Taxonomy to fill in entities whose
 * bio_category we never determined, and to SURFACE (never silently fix) the
 * ones where OTT contradicts a category we do hold.
 *
 * The two classes are not the same problem, and only one of them is safe to
 * automate:
 *
 *   FILL          — bio_category is 'other'/blank. We asserted nothing, so
 *                   adopting OTT's kingdom overwrites no judgement. Applied.
 *                   Tagged `align_bio_category_fill`.
 *   CONTRADICTION — we hold a real category and OTT disagrees. NOT applied.
 *                   Written to a review file instead, because a genus name can
 *                   sit in two kingdoms and OTT may have picked the wrong
 *                   namesake: Graphium is both a swallowtail and an anamorphic
 *                   fungus, Sphaeroderma both a flea beetle and a fungus. Our
 *                   own curated genus lists sometimes back OUR value over OTT's.
 *                   These go to the two-critic gate; nothing here decides them.
 *
 * WRITES ONE COLUMN: entities.bio_category, and only for FILL rows.
 *
 *   node align-bio-category.js                                   # dry-run
 *   node align-bio-category.js --report=../contradictions.json   # + review file
 *   node align-bio-category.js --apply
 *   node align-bio-category.js --undo --apply
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const { CORPUS_DB, OTT_DB } = require('./lib/db-paths.cjs');
const { kingdomOf } = require('./lib/ott-lookup.js');
const { lineageRanks } = require('./lib/ott-lineage.js');
const { classifyKingdomDelta } = require('./lib/kingdom-align.js');
const { BACTERIAL_GENERA, FUNGAL_GENERA } = require('./lib/curated-genera.js');
const { logRevisions } = require('./lib/revision-log.js');

const METHOD = 'align_bio_category_fill';
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const reportArg = argv.find(a => a.startsWith('--report='));

const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB, apply ? {} : { readonly: true });

if (argv.includes('--undo')) {
  const rows = db.prepare(
    `SELECT target_id, before_value FROM revision_log
     WHERE target_type='entity' AND field='bio_category' AND method=? ORDER BY id DESC`).all(METHOD);
  console.log(`=== align-bio-category UNDO (${apply ? 'APPLY' : 'DRY-RUN'}) — ${rows.length} rows ===`);
  if (apply) {
    const seen = new Set();
    db.transaction(() => {
      for (const r of rows) {
        if (seen.has(r.target_id)) continue;              // newest wins
        seen.add(r.target_id);
        db.prepare('UPDATE entities SET bio_category = ? WHERE id = ?').run(r.before_value, r.target_id);
      }
      db.prepare(`DELETE FROM revision_log WHERE target_type='entity' AND field='bio_category' AND method=?`).run(METHOD);
    })();
    console.log(`Restored ${seen.size} rows.`);
  } else console.log('Dry run. Re-run with --apply.');
  process.exit(0);
}

const ottDb = new Database(OTT_DB, { readonly: true });
const entities = db.prepare(
  `SELECT id, scientific_name, common_name, bio_category, primary_role, slug, ott_id, ott_status,
          phylum, taxon_class, taxon_order, family
   FROM entities WHERE ott_id IS NOT NULL AND merged_into_entity_id IS NULL`).all();

const ottTaxon = ottDb.prepare('SELECT name, rank, uniqname, flags FROM ott_taxa WHERE ott_id = ?');
const claimSample = db.prepare(
  `SELECT c.interaction_category, es.scientific_name AS subj, eo.scientific_name AS obj
   FROM claims c LEFT JOIN entities es ON es.id=c.subject_entity_id
                 LEFT JOIN entities eo ON eo.id=c.object_entity_id
   WHERE c.subject_entity_id=? OR c.object_entity_id=? LIMIT 3`);

const curatedFor = (name) => {
  const g = String(name || '').split(/\s+/)[0].toLowerCase();
  if (FUNGAL_GENERA.has(g)) return 'fungi';
  if (BACTERIAL_GENERA.has(g)) return 'microbe';
  return null;
};

const upd = db.prepare('UPDATE entities SET bio_category = ? WHERE id = ?');
const tally = { agree: 0, fill: 0, contradiction: 0, no_ott_kingdom: 0 };
const fillPairs = {};
const contradictions = [];

const run = db.transaction(() => {
  for (const e of entities) {
    const ottKingdom = kingdomOf(ottDb, e.ott_id);
    if (!ottKingdom) { tally.no_ott_kingdom++; continue; }
    const { verdict, value } = classifyKingdomDelta(ottDb, { ours: e.bio_category, ottKingdom, ottId: e.ott_id });
    if (verdict === 'agree') { tally.agree++; continue; }
    tally[verdict]++;

    if (verdict === 'contradiction') {
      const t = ottTaxon.get(e.ott_id) || {};
      const ottLin = lineageRanks(ottDb, e.ott_id);
      const curated = curatedFor(e.scientific_name);
      contradictions.push({
        entity_id: e.id, scientific_name: e.scientific_name, common_name: e.common_name,
        slug: e.slug, ours: e.bio_category, ott_proposes: value, primary_role: e.primary_role,
        ott_status: e.ott_status, ott_name: t.name, ott_rank: t.rank,
        ott_uniqname: t.uniqname || null, ott_flags: t.flags || null,
        // Where OTT actually places it, against what our own columns say. When
        // our stored phylum agrees with OTT the bio_category is simply stale;
        // when it disagrees too, one of the two resolved the wrong namesake.
        ott_lineage: ottLin,
        // Triage: when our OWN phylum already agrees with OTT, two independently
        // derived sources concur and only bio_category dissents — an internal
        // inconsistency needing no external authority. When it disagrees, one of
        // the two resolved the wrong namesake and a domain critic must decide.
        phylum_concordance: !e.phylum || !ottLin.phylum ? 'ours_missing'
          : e.phylum === ottLin.phylum ? 'agrees_with_ott' : 'disagrees_with_ott',
        our_lineage: { phylum: e.phylum, class: e.taxon_class, order: e.taxon_order, family: e.family },
        // Our own curated genus list, where it has an opinion. When it BACKS
        // our stored value the contradiction is likely OTT picking the wrong
        // namesake, not corruption on our side.
        curated_genus_says: curated,
        curated_backs: curated ? (curated === e.bio_category ? 'ours' : curated === value ? 'ott' : 'neither') : null,
        claim_context: claimSample.all(e.id, e.id),
      });
      continue;                                   // never auto-applied
    }

    const key = `${e.bio_category || 'NULL'} -> ${value}`;
    fillPairs[key] = (fillPairs[key] || 0) + 1;
    if (!apply) continue;
    upd.run(value, e.id);
    logRevisions(db, {
      targetType: 'entity', targetId: e.id, changedBy: 'ott-kingdom-align', method: METHOD,
      reason: `bio_category was unset ("${e.bio_category}"); OTT places ${e.scientific_name} in ${value}`,
      changes: [{ field: 'bio_category', before: e.bio_category, after: value }],
    });
  }
});
run();

console.log(`=== align-bio-category (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`resolved entities   : ${entities.length}`);
console.log(`  agree             : ${tally.agree}`);
console.log(`  FILL (applied)    : ${tally.fill}`);
console.log(`  CONTRADICTION     : ${tally.contradiction}  (NOT applied — routed to review)`);
console.log(`  OTT kingdom unknown: ${tally.no_ott_kingdom}  (left alone)`);
console.log('\nfills:');
for (const [p, n] of Object.entries(fillPairs).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${p}`);
}
if (contradictions.length) {
  const backs = contradictions.reduce((a, c) => { a[c.curated_backs || 'no opinion'] = (a[c.curated_backs || 'no opinion'] || 0) + 1; return a; }, {});
  console.log('\ncontradictions, by what OUR curated genus lists say:');
  for (const [k, n] of Object.entries(backs)) console.log(`  ${String(n).padStart(6)}  curated backs ${k}`);
}
if (reportArg) {
  const out = reportArg.split('=', 2)[1];
  fs.writeFileSync(out, JSON.stringify(contradictions, null, 2));
  console.log(`\ncontradiction review file: ${out}  (${contradictions.length} rows)`);
}
if (!apply) console.log('\nDry run. Re-run with --apply.');
db.close(); ottDb.close();
