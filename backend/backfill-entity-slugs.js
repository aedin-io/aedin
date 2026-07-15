'use strict';
// backfill-entity-slugs.js — CLI. Dry-run by default; --apply to mutate.
// Slugs clean slugless served entities; flags slug-collisions needs_dedup (dedup candidates).
// Spec: docs/superpowers/specs/2026-06-23-entity-slug-backfill-design.md
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { planSlugs, applyBackfill } = require('./lib/slug-backfill');

const CHANGED_BY = 'backfill-entity-slugs';

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const { assign, flag } = planSlugs(db);
  const flaggedEntities = flag.reduce((a, g) => a + g.members.length, 0);
  console.log(`Slugless served: ${assign.length} to slug; ${flaggedEntities} collision entities in ${flag.length} groups -> needs_dedup (NOT slugged).`);
  if (flag.length) {
    console.log('Collision groups (dedup candidates):');
    for (const g of flag.slice(0, 40)) {
      console.log(`  ${g.base || '(empty)'}  <-  ${g.members.map(m => m.scientific_name).join('  |  ')}`);
    }
    if (flag.length > 40) console.log(`  … +${flag.length - 40} more`);
  }
  if (!apply) { db.close(); console.log('DRY RUN — re-run with --apply.'); return; }
  let result;
  db.transaction(() => { result = applyBackfill(db, { changedBy: CHANGED_BY }); })();
  db.close();
  console.log(`Applied: slugged ${result.slugged}, flagged ${result.flaggedEntities} (${result.flaggedGroups} groups).`);
}

if (require.main === module) main();
module.exports = { main };
