'use strict';

/**
 * Migration 026: entities.slug (Phase 5b — public web UI)
 *
 * Phase 5b's URL structure is `/entity/<slug>` — these URLs are cited
 * externally (academic papers, bot integrations) and must be permanent. We
 * store the slug rather than computing it dynamically because:
 *   1. Permanence: if a `scientific_name` is ever corrected (typo fix), the
 *      old slug must keep resolving to the same entity. A stored slug + a
 *      future redirect table is the only way to preserve cite-stability.
 *   2. Indexability: lookups by slug need a unique index for sub-millisecond
 *      response times across ~192K entity rows.
 *   3. Manual override: in rare cases (taxonomic revisions, name conflicts)
 *      we need to assign a slug that differs from a naive slugify of
 *      scientific_name. Storing it lets us override.
 *
 * Slug shape: lowercase ASCII, hyphenated, no quotes / brackets / parens.
 * Backfill in `backend/backfill-entity-slugs.js`.
 *
 * Collision policy (enforced by the UNIQUE index): only the first entity to
 * claim a slug gets it; later collisions are left NULL by the backfill and
 * surface for manual review via the "Taxonomic-typo duplicate entities"
 * follow-on (CLAUDE.md "Open Phase-1 follow-ons").
 */
async function runMigration(db) {
  const cols = await db.all(`PRAGMA table_info(entities)`);
  const hasSlug = cols.some(c => c.name === 'slug');

  if (!hasSlug) {
    await db.exec(`ALTER TABLE entities ADD COLUMN slug TEXT`);
    console.log('[migration-026] entities.slug column added.');
  } else {
    console.log('[migration-026] entities.slug already exists — skipping ALTER.');
  }

  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_slug ON entities(slug) WHERE slug IS NOT NULL`);
  console.log('[migration-026] idx_entities_slug (unique, partial on NOT NULL) ensured.');
}

module.exports = { runMigration };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
