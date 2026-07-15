'use strict';

/**
 * resolve-ingested-taxonomy.js — backfill GBIF taxonomy + a correct bio_category
 * for INGESTED literature entities (lineage NULL, kingdom NULL), which
 * promote-staged-claims.js creates with NULL taxonomy + a *guessed* bio_category
 * and never resolves. Uses the hardened disambiguate-or-abstain resolver
 * (lib/gbif-resolve.js) with a local kingdom hint (lib/kingdom-hint.js).
 *
 * SAFE: dry-run + JSON backup by default. Abstains are flagged
 * needs_taxonomy_review=1 (migration 054), never given a guessed taxonomy.
 * GBIF needs network — run with the sandbox disabled.
 *
 * Usage:
 *   node resolve-ingested-taxonomy.js                 # dry-run, served subset
 *   node resolve-ingested-taxonomy.js --all           # dry-run, all ingested
 *   node resolve-ingested-taxonomy.js --limit=50      # cap for a sample
 *   node resolve-ingested-taxonomy.js --apply         # write
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { resolveTaxonomy } = require('./lib/gbif-resolve');
const { kingdomHint, plantTraitEntityIds, animalContextEntityIds, isAbiotic } = require('./lib/kingdom-hint');
const { logRevisions } = require('./lib/revision-log');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const DELAY_MS = parseInt(flag('delay', '200'), 10) || 200;

const db = new Database(CORPUS_DB);
const BACKUP_DIR = path.join(__dirname, 'backups');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SERVED_SQL = `id IN (
  SELECT subject_entity_id FROM claims WHERE review_status='ai_reviewed'
  UNION SELECT object_entity_id FROM claims WHERE review_status='ai_reviewed'
  UNION SELECT entity_id FROM entity_trait_claims WHERE review_status='ai_reviewed')`;

let where = `kingdom IS NULL AND parent_entity_id IS NULL`;
if (!ALL) where += ` AND ${SERVED_SQL}`;
let sql = `SELECT id, scientific_name, bio_category, kingdom, phylum, taxon_class, gbif_key FROM entities WHERE ${where} ORDER BY id`;
if (LIMIT) sql += ` LIMIT ${LIMIT}`;

const targets = db.prepare(sql).all();
const plantSet = plantTraitEntityIds(db);
const animalSet = animalContextEntityIds(db);
console.log(`[resolve-tax] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${ALL ? ' (ALL ingested)' : ' (served subset)'}  targets=${targets.length}  plant-hints=${plantSet.size} animal-hints=${animalSet.size}`);
if (!targets.length) { db.close(); process.exit(0); }

(async () => {
  const results = [];
  const tally = { accept: 0, no_match: 0, hint_contradiction: 0, low_confidence: 0 };
  let i = 0;
  for (const e of targets) {
    // Abiotic non-organisms (Phosphorus, "(soil nutrient)") must never be run
    // through the taxonomic resolver — GBIF matches them to a homonym genus.
    if (isAbiotic(e.scientific_name)) {
      tally.abiotic = (tally.abiotic || 0) + 1;
      results.push({ id: e.id, name: e.scientific_name, old_bio: e.bio_category, hint: null, accept: false, reason: 'abiotic' });
      continue;
    }
    const hint = kingdomHint(e, plantSet, animalSet);
    const r = await resolveTaxonomy(e.scientific_name, hint);
    if (r.accept) {
      tally.accept++;
      results.push({ id: e.id, name: e.scientific_name, old_bio: e.bio_category, hint,
        accept: true, new_bio: r.bio_category, gbif_key: r.gbif_key, ...r.taxonomy,
        old_kingdom: e.kingdom, old_phylum: e.phylum, old_class: e.taxon_class, old_gbif_key: e.gbif_key,
        matchType: r.matchType, confidence: r.confidence });
    } else {
      tally[r.reason] = (tally[r.reason] || 0) + 1;
      results.push({ id: e.id, name: e.scientific_name, old_bio: e.bio_category, hint, accept: false, reason: r.reason, matchType: r.matchType, confidence: r.confidence });
    }
    if (++i % 50 === 0) console.log(`  …${i}/${targets.length}  (accept ${tally.accept})`);
    await sleep(DELAY_MS);
  }

  console.log(`[resolve-tax] tally:`, JSON.stringify(tally));
  // bio_category corrections (the routing-critical payoff)
  const corrections = results.filter(r => r.accept && r.new_bio !== r.old_bio);
  console.log(`[resolve-tax] bio_category corrections: ${corrections.length}`);
  for (const c of corrections.slice(0, 20)) console.log(`  #${c.id} ${String(c.name).slice(0,30).padEnd(30)} ${String(c.old_bio).padEnd(12)} → ${c.new_bio}  [${c.kingdom}]`);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `resolve-ingested-taxonomy-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ created_at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', tally, results }, null, 2));
  console.log(`[resolve-tax] report+backup: ${backupFile}`);

  if (!APPLY) { console.log('[resolve-tax] DRY-RUN — nothing written. Re-run with --apply.'); db.close(); return; }

  const accept = db.prepare(`UPDATE entities SET kingdom=?, phylum=?, taxon_class=?, taxon_order=?,
      family=COALESCE(family,?), genus=COALESCE(genus,?), gbif_key=?, bio_category=?, taxonomy_path=?,
      lineage_source='gbif_api', gbif_synced_at=datetime('now'), updated_at=datetime('now') WHERE id=?`);
  const abstain = db.prepare(`UPDATE entities SET needs_taxonomy_review=1, updated_at=datetime('now') WHERE id=?`);
  const CHANGED_BY = 'resolve-ingested-taxonomy.js';
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      if (r.accept) {
        const tp = [r.kingdom, r.phylum, r.taxon_class, r.taxon_order, r.family, r.genus].filter(Boolean).join(' | ');
        accept.run(r.kingdom, r.phylum, r.taxon_class, r.taxon_order, r.family, r.genus, r.gbif_key, r.new_bio, tp, r.id);
        // Audit trail: one row per changed field (provenance shown on the page).
        logRevisions(db, {
          targetType: 'entity', targetId: r.id, changedBy: CHANGED_BY,
          method: 'gbif_accepted_name_match',
          reason: `GBIF ${r.matchType}/${r.confidence}${r.hint ? `; hint=${r.hint}` : ''}`,
          changes: [
            { field: 'bio_category', before: r.old_bio, after: r.new_bio },
            { field: 'kingdom', before: r.old_kingdom, after: r.kingdom },
            { field: 'phylum', before: r.old_phylum, after: r.phylum },
            { field: 'taxon_class', before: r.old_class, after: r.taxon_class },
            { field: 'gbif_key', before: r.old_gbif_key, after: r.gbif_key },
          ],
        });
      } else {
        abstain.run(r.id);
        logRevisions(db, {
          targetType: 'entity', targetId: r.id, changedBy: CHANGED_BY,
          method: 'gbif_abstain', reason: r.reason,
          changes: [{ field: 'needs_taxonomy_review', before: null, after: '1' }],
        });
      }
    }
  });
  tx(results);
  console.log(`[resolve-tax] APPLIED: ${tally.accept} resolved, ${results.length - tally.accept} flagged needs_taxonomy_review.`);
  db.close();
})().catch(e => { console.error('Fatal:', e); db.close(); process.exit(1); });
