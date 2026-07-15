/**
 * Migration 001: Create enrichment tables for recommendation engine
 *
 * Creates new tables:
 * - species_common_names: Maps scientific names to common names
 * - anticipated_interactions: Inferred interactions based on co-occurrence
 * - beneficial_chains: 3-hop beneficial relationship chains (crop -> pest -> predator -> crop)
 *
 * Usage: node migrations/001_create_enrichment_tables.js
 */

const sqlite3 = require('sqlite3').verbose();
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const db = new sqlite3.Database(CORPUS_DB);

console.log('🔄 Running migration 001_create_enrichment_tables...\n');

db.serialize(() => {
  // 1. Create species_common_names table
  db.run(`
    CREATE TABLE IF NOT EXISTS species_common_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scientific_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      common_name TEXT NOT NULL,
      language TEXT DEFAULT 'en',
      source TEXT DEFAULT 'unknown',
      confidence REAL DEFAULT 0.8,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('❌ species_common_names error:', err.message);
    else console.log('✅ species_common_names table created');
  });

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_common_names_scientific
    ON species_common_names(scientific_name)
  `, (err) => {
    if (err) console.error('❌ idx_common_names_scientific error:', err.message);
    else console.log('✅ idx_common_names_scientific index created');
  });

  // 2. Create anticipated_interactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS anticipated_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL COLLATE NOCASE,
      target_name TEXT NOT NULL COLLATE NOCASE,
      interaction_type TEXT NOT NULL,
      confidence_score REAL NOT NULL DEFAULT 0.5,
      reasoning TEXT,
      locations_found TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('❌ anticipated_interactions error:', err.message);
    else console.log('✅ anticipated_interactions table created');
  });

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_anticipated_source
    ON anticipated_interactions(source_name)
  `, (err) => {
    if (err) console.error('❌ idx_anticipated_source error:', err.message);
    else console.log('✅ idx_anticipated_source index created');
  });

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_anticipated_target
    ON anticipated_interactions(target_name)
  `, (err) => {
    if (err) console.error('❌ idx_anticipated_target error:', err.message);
    else console.log('✅ idx_anticipated_target index created');
  });

  // 3. Create beneficial_chains table
  db.run(`
    CREATE TABLE IF NOT EXISTS beneficial_chains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_name TEXT NOT NULL COLLATE NOCASE,
      pest_name TEXT NOT NULL COLLATE NOCASE,
      predator_name TEXT NOT NULL COLLATE NOCASE,
      chain_confidence REAL NOT NULL DEFAULT 0.8,
      reasoning TEXT,
      region TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('❌ beneficial_chains error:', err.message);
    else console.log('✅ beneficial_chains table created');
  });

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_beneficial_chains_crop
    ON beneficial_chains(crop_name)
  `, (err) => {
    if (err) console.error('❌ idx_beneficial_chains_crop error:', err.message);
    else console.log('✅ idx_beneficial_chains_crop index created');
  });

  // 4. Create interaction_context table (for distinguishing beneficial vs. harmful "eats")
  db.run(`
    CREATE TABLE IF NOT EXISTS interaction_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interaction_id INTEGER,
      source_name TEXT COLLATE NOCASE,
      target_name TEXT COLLATE NOCASE,
      interaction_type TEXT,
      context_type TEXT CHECK(context_type IN ('nectar', 'pollen', 'predation', 'parasitism', 'seed', 'tissue', 'unknown')),
      is_beneficial BOOLEAN,
      confidence REAL DEFAULT 0.8,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('❌ interaction_context error:', err.message);
    else console.log('✅ interaction_context table created');
  });

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_context_source
    ON interaction_context(source_name)
  `, (err) => {
    if (err) console.error('❌ idx_context_source error:', err.message);
    else console.log('✅ idx_context_source index created');
  });

  // 5. Add composite index for common neighborhood queries
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_interactions_source_target
    ON interactions(source_name, target_name)
  `, (err) => {
    if (err) {
      // May fail if already exists, that's fine
      if (err.message.includes('already exists')) {
        console.log('⚠️  idx_interactions_source_target already exists');
      } else {
        console.error('❌ idx_interactions_source_target error:', err.message);
      }
    } else {
      console.log('✅ idx_interactions_source_target index created');
    }
  });

  // Final status
  setTimeout(() => {
    db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err, tables) => {
      if (err) {
        console.error('❌ Failed to verify tables:', err.message);
      } else {
        console.log('\n📊 Database tables after migration:');
        tables.forEach(t => console.log(`   - ${t.name}`));
      }

      db.all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name", (err, indexes) => {
        if (err) {
          console.error('❌ Failed to verify indexes:', err.message);
        } else {
          console.log('\n🔍 Indexes after migration:');
          indexes.forEach(i => console.log(`   - ${i.name}`));
        }

        console.log('\n✨ Migration 001 complete!');
        db.close();
      });
    });
  }, 500);
});
