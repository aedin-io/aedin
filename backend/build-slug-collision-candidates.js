'use strict';
// Ingest the slug-backfill's needs_dedup pairs into entity_dedup_candidates.
// The epithet sweep (sweep-entity-dedup.js) is structurally blind to ×-marker /
// junk-char / cultivar-collision pairs; the slug-collision flag found them.
const { slugify } = require('./lib/slugify');

async function buildSlugCandidates(db, { apply = false } = {}) {
  const flagged = await db.all(
    `SELECT id, scientific_name, slug, scope_tier FROM entities
     WHERE needs_dedup=1 AND merged_into_entity_id IS NULL`);
  // Group flagged rows by base slug.
  const byBase = new Map();
  for (const e of flagged) {
    const base = slugify(e.scientific_name);
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(e);
  }
  const inWorklistPairs = [], orphansPaired = [], noTwin = [];
  for (const [base, members] of byBase) {
    if (members.length >= 2) {
      // In-worklist: pair the two lowest ids (covers the 2-member collision groups).
      const ids = members.map(m => m.id).sort((x, y) => x - y);
      inWorklistPairs.push({ a: ids[0], b: ids[1] });
    } else {
      // Orphan singleton: find an already-slugged, non-flagged twin holding this base slug.
      const twin = await db.get(
        `SELECT id FROM entities WHERE slug=? AND id<>? AND COALESCE(needs_dedup,0)=0
           AND merged_into_entity_id IS NULL LIMIT 1`, [base, members[0].id]);
      if (twin) orphansPaired.push({ flagged: members[0].id, twin: twin.id });
      else noTwin.push({ id: members[0].id, name: members[0].scientific_name });
    }
  }
  if (apply) {
    const pairs = [
      ...inWorklistPairs.map(p => [p.a, p.b]),
      ...orphansPaired.map(p => [p.flagged, p.twin]),
    ];
    for (const [x, y] of pairs) {
      const a = Math.min(x, y), b = Math.max(x, y);
      // entity_dedup_candidates requires genus/levenshtein_distance NOT NULL; slug
      // pairs carry neither meaningfully, so use '' / 0 sentinels (tier-candidates
      // re-derives the canonical; the epithet distance is irrelevant for these).
      await db.run(
        `INSERT OR IGNORE INTO entity_dedup_candidates
           (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis)
         VALUES (?, ?, '', 0, 'slug_collision')`, [a, b]);
    }
  }
  return { inWorklistPairs, orphansPaired, noTwin };
}

module.exports = { buildSlugCandidates };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const apply = process.argv.includes('--apply');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    const r = await buildSlugCandidates(db, { apply });
    console.log(`[slug-candidates] in-worklist pairs: ${r.inWorklistPairs.length} | orphans paired: ${r.orphansPaired.length} | no-twin (left for sweep/review): ${r.noTwin.length}`);
    if (r.noTwin.length) console.log('  no-twin:', r.noTwin.map(x => `${x.id}:${x.name}`).join(', '));
    console.log(apply ? '[slug-candidates] applied.' : '[slug-candidates] DRY RUN — re-run with --apply to write.');
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
