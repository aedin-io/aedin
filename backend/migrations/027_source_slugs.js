'use strict';

/**
 * Migration 027: sources.slug (Phase 5b — public web UI source pages)
 *
 * Each source gets a citable URL at `/source/<slug>` listing every claim
 * derived from it. Slugs follow academic convention (first-author surname
 * + year, e.g. `pedigo-2009`) where possible, falling back to a
 * title-based slug for sources missing author or year metadata
 * (e.g. source 44 "History of Plant Pathology" has year=Unknown).
 *
 * Same shape as migration 026 (entities.slug): TEXT column + unique
 * partial index on NOT NULL. Collisions during backfill are
 * disambiguated by appending `-2`, `-3`, etc. — author-year alone
 * can't disambiguate the same author with multiple works in the same
 * year (Pedigo 2002 + Pedigo 2002 second edition, etc.).
 */
async function runMigration(db) {
  const cols = await db.all(`PRAGMA table_info(sources)`);
  const hasSlug = cols.some(c => c.name === 'slug');

  if (!hasSlug) {
    await db.exec(`ALTER TABLE sources ADD COLUMN slug TEXT`);
    console.log('[migration-027] sources.slug column added.');
  } else {
    console.log('[migration-027] sources.slug already exists — skipping ALTER.');
  }

  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_slug ON sources(slug) WHERE slug IS NOT NULL`);
  console.log('[migration-027] idx_sources_slug (unique, partial on NOT NULL) ensured.');
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
