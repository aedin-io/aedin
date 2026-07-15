'use strict';
/**
 * serve-referenced-entities.js — give D1 pages to the literature-ingested entities
 * that the build-d1 serving set references purely by an `ai_reviewed` claim/trait
 * but that were never scope_tier-promoted (so they sit in D1 as page-less,
 * NULL-slug rows and `gen-claims-patch.cjs` HOLDS their claims for a missing page).
 *
 * Serve = assign a canonical slug (slugify(scientific_name)) + scope_tier=0, for the
 * CLEAN tail only. A slug collision (base equals an existing slug or another in-batch
 * base) is a DUPLICATE TAXON → flagged needs_dedup (merge rail), NOT suffixed. Rows
 * already carrying needs_dedup / needs_taxonomy_review are excluded by the candidate
 * query (held off the public site per the 2026-06-29 scope decision).
 *
 * Reversible: every field change is in revision_log; a JSON backup of the before-state
 * (incl. the served id list, consumed by web/scripts/gen-served-entities-patch.cjs) is
 * written first. Dry-run by default.
 *
 * Usage:
 *   node serve-referenced-entities.js                    # dry-run
 *   node serve-referenced-entities.js --apply
 *   node serve-referenced-entities.js --apply --stamp=2026-06-29
 *
 * Spec: docs/superpowers/specs/2026-06-29-serve-referenced-entities-design.md
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { slugify } = require('./lib/slugify');
const { selectSluglessReferenced, existingSlugs, planFromRows, applyReferencedServe } = require('./lib/slug-backfill');

const CHANGED_BY = 'serve-referenced-entities';

// --hold-ids=<comma-list | path-to-file>. Ids to EXCLUDE from serving (generic-guild
// / non-taxon nodes the agroecologist held off the public site). File may be
// comma- or newline-separated.
function parseHoldIds(args) {
  const raw = (args.find(a => a.startsWith('--hold-ids=')) || '').split('=').slice(1).join('=');
  if (!raw) return new Set();
  const text = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw;
  // Take the FIRST token of each non-comment line as the id, so reason text on the
  // same line (and #-comment lines, e.g. dates) can't leak stray integers.
  const ids = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    for (const tok of t.split(/[\s,]+/)) { const n = parseInt(tok, 10); if (Number.isInteger(n)) { ids.push(n); break; } }
  }
  return new Set(ids);
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const stamp = (args.find(a => a.startsWith('--stamp=')) || '').split('=')[1] || 'now';
  const holdIds = parseHoldIds(args);
  const db = new Database(CORPUS_DB);

  // Compute the plan once for the report + backup (applyReferencedServe recomputes
  // identically against the unchanged db, with the same holdIds filter).
  const candidates = selectSluglessReferenced(db).filter(c => !holdIds.has(c.id));
  const byId = new Map(candidates.map(c => [c.id, c]));
  const { assign, flag } = planFromRows(candidates, existingSlugs(db));
  if (holdIds.size) console.log(`[serve-referenced] excluding ${holdIds.size} hold-ids (generic-guild / non-taxon)`);

  console.log(`[serve-referenced] clean slugless referenced candidates: ${candidates.length}`);
  console.log(`  → serve (slug + scope_tier=0): ${assign.length}`);
  console.log(`  → flag needs_dedup (slug collision = duplicate taxon, NOT served): ${flag.reduce((a, g) => a + g.members.length, 0)} in ${flag.length} groups`);
  for (const { id, slug } of assign.slice(0, 25)) {
    console.log(`    e${id}  ${byId.get(id).scientific_name}  →  ${slug}`);
  }
  if (assign.length > 25) console.log(`    … +${assign.length - 25} more`);
  if (flag.length) {
    console.log(`  collision groups (dedup candidates):`);
    for (const g of flag.slice(0, 25)) {
      console.log(`    ${g.base || '(empty)'}  ←  ${g.members.map(m => byId.get(m.id).scientific_name).join('  |  ')}`);
    }
    if (flag.length > 25) console.log(`    … +${flag.length - 25} more`);
  }

  if (!apply) {
    console.log('\n[serve-referenced] DRY RUN — re-run with --apply.');
    db.close();
    return;
  }

  // Backup before-state (+ the served id list, for gen-served-entities-patch).
  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `serve-referenced-entities-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({
    method: CHANGED_BY,
    stamp,
    served: assign.map(a => ({ id: a.id, slug: a.slug, before: { slug: null, scope_tier: null } })),
    flagged: flag.flatMap(g => g.members.map(m => ({ id: m.id, base: g.base, before: { needs_dedup: byId.get(m.id).needs_dedup } }))),
  }, null, 2));
  console.log(`\n[serve-referenced] backup → ${backupFile}`);

  let res;
  db.transaction(() => { res = applyReferencedServe(db, { changedBy: CHANGED_BY, holdIds }); })();
  db.close();
  console.log(`[serve-referenced] APPLIED: served ${res.served}, flagged ${res.flaggedEntities} (${res.flaggedGroups} groups).`);
  console.log(`  served ids → backup ${path.basename(backupFile)}; publish with gen-served-entities-patch.cjs --served=${backupFile}`);
}

if (require.main === module) main();
module.exports = { main };
