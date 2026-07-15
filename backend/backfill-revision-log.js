'use strict';

/**
 * backfill-revision-log.js — reconstruct revision_log rows for the bulk entity/
 * claim corrections ALREADY applied this session, so their provenance is visible
 * on the page (not just buried in backend/backups/*.json). One-time, idempotent.
 *
 * Sources (auto-detected apply backups, printed for verification):
 *   - resolve-ingested-taxonomy-*.json (mode=apply) → entity taxonomy + bio_category
 *   - reclassify-bio-category-*.json (latest)        → entity bio_category (--safe)
 *   - quarantine-coarse-rank-*.json (latest)         → claim review_status
 *
 * Backfilled rows are tagged `changed_by = '<script> (backfilled)'` so re-running
 * is idempotent (it deletes those first). Going-forward writes come straight from
 * the mutator scripts via lib/revision-log.js and are NOT touched.
 *
 * Usage: node backfill-revision-log.js [--apply]
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { logRevisions } = require('./lib/revision-log');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const APPLY = process.argv.slice(2).includes('--apply');
const BACKUP_DIR = path.join(__dirname, 'backups');
const db = new Database(CORPUS_DB);

const ls = (re) => fs.readdirSync(BACKUP_DIR).filter(f => re.test(f)).sort();
const latest = (re) => { const a = ls(re); return a.length ? path.join(BACKUP_DIR, a[a.length - 1]) : null; };
const load = (p) => p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;

// resolver: pick the newest backup whose mode === 'apply'
const resolverApply = ls(/^resolve-ingested-taxonomy-.*\.json$/)
  .map(f => path.join(BACKUP_DIR, f))
  .filter(p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).mode === 'apply'; } catch { return false; } })
  .pop() || null;
const reclassFile = latest(/^reclassify-bio-category-.*\.json$/);
const quarFile = latest(/^quarantine-coarse-rank-.*\.json$/);

console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`  resolver  : ${resolverApply ? path.basename(resolverApply) : '(none)'}`);
console.log(`  reclassify: ${reclassFile ? path.basename(reclassFile) : '(none)'}`);
console.log(`  quarantine: ${quarFile ? path.basename(quarFile) : '(none)'}`);

// Build the revision-write closures (run inside one transaction on --apply).
const work = [];

const resolver = load(resolverApply);
if (resolver) {
  const ts = resolver.created_at || '';
  for (const r of resolver.results || []) {
    if (r.accept) {
      work.push({ targetType: 'entity', targetId: r.id, changedBy: 'resolve-ingested-taxonomy.js (backfilled)',
        method: 'gbif_accepted_name_match', appliedAt: ts, reason: `GBIF ${r.matchType}/${r.confidence}${r.hint ? `; hint=${r.hint}` : ''}`,
        changes: [
          { field: 'bio_category', before: r.old_bio, after: r.new_bio },
          // ingested target was kingdom IS NULL → old taxonomy/key were NULL
          { field: 'kingdom', before: r.old_kingdom ?? null, after: r.kingdom },
          { field: 'phylum', before: r.old_phylum ?? null, after: r.phylum },
          { field: 'taxon_class', before: r.old_class ?? null, after: r.taxon_class },
          { field: 'gbif_key', before: r.old_gbif_key ?? null, after: r.gbif_key },
        ] });
    } else {
      work.push({ targetType: 'entity', targetId: r.id, changedBy: 'resolve-ingested-taxonomy.js (backfilled)',
        method: 'gbif_abstain', appliedAt: ts, reason: r.reason,
        changes: [{ field: 'needs_taxonomy_review', before: null, after: '1' }] });
    }
  }
}

const reclass = load(reclassFile);
if (reclass) {
  const ts = reclass.created_at || '';
  for (const c of reclass.changes || []) {
    work.push({ targetType: 'entity', targetId: c.id, changedBy: 'reclassify-bio-category.js (backfilled)',
      method: 'curated_genus_reclassify', appliedAt: ts, reason: `--safe: ${c.tier || ''} ${c.signal || ''}`.trim(),
      changes: [{ field: 'bio_category', before: c.old, after: c.new }] });
  }
}

const quar = load(quarFile);
if (quar) {
  const ts = quar.created_at || '';
  for (const a of quar.affected || []) {
    work.push({ targetType: 'claim', targetId: a.id, changedBy: 'quarantine-coarse-rank.js (backfilled)',
      method: 'rank_floor_quarantine', appliedAt: ts, reason: `coarse-rank endpoint (class+): ${a.subj} ⇄ ${a.obj}`,
      changes: [{ field: 'review_status', before: a.review_status, after: 'quarantined_coarse' }] });
  }
}

console.log(`[backfill] reconstructed ${work.length} change-events`);

if (!APPLY) {
  console.log('[backfill] DRY-RUN — nothing written. Sample:');
  for (const w of work.slice(0, 6)) console.log(`  ${w.targetType}#${w.targetId} ${w.changes.map(c => c.field).join(',')}  [${w.method}]`);
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  db.prepare(`DELETE FROM revision_log WHERE changed_by LIKE '% (backfilled)'`).run();
  let n = 0;
  for (const w of work) n += logRevisions(db, w);
  return n;
});
const written = tx();
console.log(`[backfill] APPLIED: ${written} revision_log rows written (re-runnable — old (backfilled) rows cleared first).`);
db.close();
