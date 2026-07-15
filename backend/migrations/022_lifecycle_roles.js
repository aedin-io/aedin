'use strict';

/**
 * Adds stage-qualified lifecycle role columns to entities.
 *
 * Addresses CLAUDE.md bug #1 (stage-dependent roles not representable):
 * `primary_role` is a single scalar, but Lepidoptera (22,478 entities, all
 * currently labeled `pest_insect`) and many other insect groups have different
 * ecological roles as larvae vs. adults — caterpillar = herbivore, adult moth/
 * butterfly = nectarivore/pollinator.
 *
 * Schema is ADDITIVE: existing `primary_role` semantics are unchanged; the new
 * columns expose the missing stage info. Consumers can query either or both.
 *
 *   larval_role  — role of the larval stage (herbivore, predator, parasitoid, …)
 *   adult_role   — role of the adult stage (nectarivore, predator, pollinator, …)
 *
 * Both NULLable. NULL means "not applicable" or "not yet inferred".
 */
async function runMigration(db) {
  const cols = await db.all('PRAGMA table_info(entities)');
  const existing = new Set(cols.map(c => c.name));

  const newCols = [
    ['larval_role', 'TEXT'],
    ['adult_role',  'TEXT'],
  ];

  let added = 0;
  for (const [name, type] of newCols) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE entities ADD COLUMN ${name} ${type}`);
      added++;
    }
  }

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_adult_role  ON entities(adult_role)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_larval_role ON entities(larval_role)`);

  console.log(`[migration-022] lifecycle role columns: ${added} added (others pre-existing). Indexes ready.`);
}

module.exports = { runMigration };
