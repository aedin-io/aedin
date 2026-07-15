'use strict';

const columns = [
  'parent_entity_id INTEGER REFERENCES entities(id)',
  'variety_name TEXT',
  'grin_accession TEXT',
  'grin_synced_at TEXT',
];

async function runMigration(db) {
  const existing = await db.all('PRAGMA table_info(entities)');
  const names = new Set(existing.map(c => c.name));

  let added = 0;
  for (const col of columns) {
    const colName = col.split(' ')[0];
    if (!names.has(colName)) {
      await db.run(`ALTER TABLE entities ADD COLUMN ${col}`);
      added++;
    }
  }

  // Replace UNIQUE index on scientific_name with composite unique on (scientific_name, variety_name)
  const indexes = await db.all("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entities_scientific_name'");
  if (indexes.length > 0) {
    await db.run('DROP INDEX idx_entities_scientific_name');
  }
  // NULL variety_name = species row; non-NULL = variety row
  // SQLite treats NULLs as distinct in UNIQUE indexes, so species rows won't conflict
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_variety ON entities(scientific_name, variety_name)');

  await db.run('CREATE INDEX IF NOT EXISTS idx_entities_parent ON entities(parent_entity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_entities_grin ON entities(grin_accession)');
  // Composite index for the admin entities listing (WHERE parent_entity_id IS NULL ORDER BY scientific_name)
  await db.run('CREATE INDEX IF NOT EXISTS idx_entities_parent_name ON entities(parent_entity_id, scientific_name)');
  // Covering index for role-filtered queries
  await db.run('CREATE INDEX IF NOT EXISTS idx_entities_role_name ON entities(primary_role, scientific_name)');

  if (added > 0) console.log(`[migration-013] Added ${added} variety columns.`);
  else console.log('[migration-013] Variety columns already exist.');
  console.log('[migration-013] Updated indexes for variety support.');
}

module.exports = { runMigration };
