#!/usr/bin/env node
'use strict';
/**
 * fix-taxonomy-mislabel.js — correct a single animal-tagged PLANT/FUNGUS entity (the
 * entity-taxonomy-corruption class: e.g. Lycopersicon esculentum = tomato mis-tagged
 * `invertebrate` with NULL kingdom). Targeted + GBIF-confirmed + revision_log-logged.
 *
 * Conservative by design — NOT a bulk fixer (the 108 animal-tagged + NULL-kingdom suspects
 * include genuine animals and namesake-collision traps; see CLAUDE.md). This corrects ONE
 * entity at a time, and ONLY applies when GBIF confidently resolves the name to Plantae/Fungi
 * (so it can never flip a genuine animal). Run dry-run first; re-run with --apply to write.
 *
 * Usage:
 *   node fix-taxonomy-mislabel.js --id=373037           # dry-run
 *   node fix-taxonomy-mislabel.js --id=373037 --apply    # write + log revision_log
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { resolveTaxonomy } = require('./lib/gbif-resolve');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const idArg = argv.find(a => a.startsWith('--id='));
const ID = idArg ? parseInt(idArg.split('=', 2)[1], 10) : null;

(async () => {
  if (!ID) { console.error('Usage: node fix-taxonomy-mislabel.js --id=<entityId> [--apply]'); process.exit(2); }
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const ent = await db.get('SELECT id, scientific_name, bio_category, kingdom, phylum, taxon_class, taxon_order, family, genus, gbif_key, needs_taxonomy_review FROM entities WHERE id = ?', ID);
  if (!ent) { console.error(`entity ${ID} not found`); process.exit(1); }
  console.log(`Entity ${ent.id}: "${ent.scientific_name}" — current bio_category=${ent.bio_category}, kingdom=${ent.kingdom}`);

  const res = await resolveTaxonomy(ent.scientific_name, null);
  if (!res.accept) { console.log(`GBIF abstained (${res.reason}, matchType=${res.matchType}, conf=${res.confidence}). No change.`); await db.close(); return; }
  if (res.bio_category !== 'plantae' && res.bio_category !== 'fungi') {
    console.log(`GBIF resolved to bio_category=${res.bio_category} (not plant/fungus) — refusing to "fix" (could be a genuine animal). No change.`);
    await db.close(); return;
  }
  const t = res.taxonomy;
  const updates = [
    ['bio_category', ent.bio_category, res.bio_category],
    ['kingdom', ent.kingdom, t.kingdom],
    ['phylum', ent.phylum, t.phylum],
    ['taxon_class', ent.taxon_class, t.taxon_class],
    ['taxon_order', ent.taxon_order, t.taxon_order],
    ['family', ent.family, t.family],
    ['genus', ent.genus, t.genus],
    ['gbif_key', ent.gbif_key, res.gbif_key],
    ['needs_taxonomy_review', ent.needs_taxonomy_review, 0],
  ].filter(([, b, a]) => String(b ?? '') !== String(a ?? ''));

  console.log(`GBIF (matchType=${res.matchType}, conf=${res.confidence}) → ${res.bio_category}. Proposed changes:`);
  for (const [f, b, a] of updates) console.log(`  ${f}: ${b ?? 'NULL'} → ${a ?? 'NULL'}`);
  if (!updates.length) { console.log('Already correct. No change.'); await db.close(); return; }

  if (!APPLY) { console.log('\nDRY-RUN — re-run with --apply to write + log revision_log.'); await db.close(); return; }

  await db.run('BEGIN');
  try {
    const setSql = updates.map(([f]) => `${f} = ?`).join(', ') + ', updated_at = datetime(\'now\')';
    await db.run(`UPDATE entities SET ${setSql} WHERE id = ?`, [...updates.map(([, , a]) => a), ID]);
    for (const [f, b, a] of updates) {
      await db.run(
        `INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method, reason)
         VALUES ('entity', ?, ?, ?, ?, 'fix-taxonomy-mislabel.js', 'gbif_mislabel_correction', ?)`,
        [ID, f, b == null ? null : String(b), a == null ? null : String(a), `animal-tagged ${res.bio_category} corrected via GBIF (Hermes crop-gate follow-up)`]
      );
    }
    await db.run('COMMIT');
    console.log(`\nApplied ${updates.length} field change(s) + logged ${updates.length} revision_log row(s).`);
    console.log('NOTE: this entity is served (has a D1 page) — a D1 publish is needed to reflect the fix live.');
  } catch (e) { await db.run('ROLLBACK'); throw e; }
  await db.close();
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
