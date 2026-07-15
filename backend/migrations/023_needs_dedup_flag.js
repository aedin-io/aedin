'use strict';

/**
 * Adds `needs_dedup` flag to entities.
 *
 * Surfaced by Phase-1.5 follow-up on Bug #5: typo'd scientific-name variants
 * (e.g. `Apis melliferae`, `Apis melliferra` as duplicates of `Apis mellifera`)
 * exist in the entities table. Their common_name was previously auto-fixed via
 * the canonical alias path, which HID the deduplication backlog.
 *
 * This column makes the dedup queue queryable: `WHERE needs_dedup = 1` returns
 * all entities flagged as suspected duplicates of a canonical row. Resolution
 * (merge interactions/claims into the canonical entity, delete the duplicate)
 * is a separate "taxonomic dedup" backfill, not part of bug #5.
 */
async function runMigration(db) {
  const cols = await db.all('PRAGMA table_info(entities)');
  const has = cols.some(c => c.name === 'needs_dedup');
  if (!has) {
    await db.exec(`ALTER TABLE entities ADD COLUMN needs_dedup INTEGER`);
    console.log('[migration-023] needs_dedup column added.');
  } else {
    console.log('[migration-023] needs_dedup column already present.');
  }
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_needs_dedup ON entities(needs_dedup)`);
}

module.exports = { runMigration };
