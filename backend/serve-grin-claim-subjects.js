'use strict';
/**
 * serve-grin-claim-subjects.js — make slug-less variety entities that subject a
 * promoted GRIN resistance claim servable, so the live-D1 publish (gen-claims-patch.cjs)
 * stops holding their claims for a missing subject page.
 *
 * These entities were auto-created by promote-staged-claims.js::resolveEntityForClaim
 * (needs_dedup=1, no slug) when no existing variety entity matched the claim's
 * subject_variety. They now carry resistance data, so they are worth serving.
 *
 * Serve = assign a canonical slug (slugify(scientific_name) + uniqueSlug collision
 * suffix) + scope_tier=0 + needs_dedup=NULL, matching the served-variety state
 * (cf. Early Girl: slug + tier=0 + needs_dedup=null). Every field change is logged
 * to revision_log; a JSON backup of the before-state is written first; reversible.
 *
 * SAFETY: a slug-less subject that has a canonical served TWIN (same parent +
 * same variety_name, slug NOT NULL) is NOT slugged — that is a dedup-MERGE case,
 * not a serve case. Such rows are reported and skipped (resolve via the merge rail).
 *
 * Usage:
 *   node serve-grin-claim-subjects.js              # dry-run (default)
 *   node serve-grin-claim-subjects.js --apply
 *   node serve-grin-claim-subjects.js --source-id=244   # default 244 (GRIN narratives)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { slugify, uniqueSlug } = require('./lib/slugify');
const { logRevisions } = require('./lib/revision-log');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SOURCE_ID = parseInt((args.find(a => a.startsWith('--source-id=')) || '').split('=')[1], 10) || 244;

const db = new Database(CORPUS_DB);

// Slug-less variety entities that subject a promoted claim from this source —
// across BOTH the interaction/resistance table (claims.subject_entity_id) and the
// trait table (entity_trait_claims.entity_id). A trait-only subject (Phase 2)
// needs serving just as much as a resistance subject (Phase 1).
const subjects = db.prepare(`
  WITH subj(id) AS (
    SELECT subject_entity_id FROM claims WHERE source_id = ?
    UNION
    SELECT entity_id FROM entity_trait_claims WHERE source_id = ?
  )
  SELECT DISTINCT e.id, e.scientific_name, e.variety_name, e.parent_entity_id,
         e.slug, e.scope_tier, e.needs_dedup
  FROM subj
  JOIN entities e ON e.id = subj.id
  WHERE e.slug IS NULL
    AND e.parent_entity_id IS NOT NULL
  ORDER BY e.id
`).all(SOURCE_ID, SOURCE_ID);

console.log(`[serve] source_id=${SOURCE_ID} slug-less claim-subject varieties: ${subjects.length}`);

// Partition into serve (no twin) vs merge-needed (has a canonical served twin).
const twinStmt = db.prepare(`
  SELECT id, slug FROM entities
  WHERE parent_entity_id = ? AND id <> ? AND variety_name = ? COLLATE NOCASE AND slug IS NOT NULL`);

const toServe = [];
const needMerge = [];
for (const e of subjects) {
  const twins = twinStmt.all(e.parent_entity_id, e.id, e.variety_name);
  if (twins.length) needMerge.push({ e, twins });
  else toServe.push(e);
}

if (needMerge.length) {
  console.log(`\n[serve] ${needMerge.length} have a canonical served twin → MERGE case, NOT slugged:`);
  needMerge.forEach(({ e, twins }) =>
    console.log(`  e${e.id} "${e.variety_name}" → twin(s) ${twins.map(t => `${t.id}(${t.slug})`).join(', ')}`));
}

// Plan slugs (collision-safe across the run + the live table).
const taken = new Set();
const plan = toServe.map(e => ({ e, slug: uniqueSlug(db, slugify(e.scientific_name), taken) }));

console.log(`\n[serve] ${plan.length} to serve (slug + scope_tier=0 + needs_dedup=NULL):`);
plan.forEach(({ e, slug }) => console.log(`  e${e.id} "${e.variety_name}" → ${slug}`));

if (!APPLY) {
  console.log(`\n[serve] DRY RUN — re-run with --apply to write. ${needMerge.length} merge-case row(s) skipped.`);
  db.close();
  process.exit(0);
}

// Backup before-state.
const stamp = (args.find(a => a.startsWith('--stamp=')) || '').split('=')[1] || 'now';
const backupDir = path.join(__dirname, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `serve-grin-claim-subjects-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify(plan.map(({ e, slug }) => ({
  id: e.id, before: { slug: e.slug, scope_tier: e.scope_tier, needs_dedup: e.needs_dedup }, after_slug: slug,
})), null, 2));
console.log(`\n[serve] backup → ${backupFile}`);

const upd = db.prepare(`UPDATE entities SET slug = ?, scope_tier = 0, needs_dedup = NULL WHERE id = ?`);
const tx = db.transaction(() => {
  for (const { e, slug } of plan) {
    upd.run(slug, e.id);
    logRevisions(db, {
      targetType: 'entity', targetId: e.id, changedBy: 'serve-grin-claim-subjects',
      method: 'serve_claim_subject_variety', reason: 'auto-created variety with served resistance claims made servable',
      changes: [
        { field: 'slug', before: e.slug, after: slug },
        { field: 'scope_tier', before: e.scope_tier, after: 0 },
        { field: 'needs_dedup', before: e.needs_dedup, after: null },
      ],
    });
  }
});
tx();
console.log(`[serve] APPLIED: served ${plan.length} varieties. ${needMerge.length} merge-case row(s) still need the merge rail.`);
db.close();
