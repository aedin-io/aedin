/**
 * Data Enrichment for Standard Version
 * Categorizes interactions, integrates common names, and identifies beneficial relationships
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');

/**
 * Classifies interaction context based on interaction type
 * Returns: 'positive', 'negative', or 'neutral'
 */
function classifyInteractionContext(interactionType) {
  const type = (interactionType || '').toLowerCase();

  // Positive interactions
  if (
    type.includes('pollinat') ||
    type.includes('nectar') ||
    type.includes('mutualis') ||
    type.includes('benefit') ||
    type.includes('protect')
  ) {
    return 'positive';
  }

  // Negative interactions
  if (
    type.includes('pest') ||
    type.includes('parasit') ||
    type.includes('pathog') ||
    type.includes('feed') ||
    type.includes('eat') ||
    type.includes('infect')
  ) {
    return 'negative';
  }

  return 'neutral';
}

/**
 * Loads or creates common names mapping
 */
function loadCommonNames() {
  const commonNamePath = path.join(__dirname, 'common_names.json');

  if (fs.existsSync(commonNamePath)) {
    return JSON.parse(fs.readFileSync(commonNamePath, 'utf-8'));
  }

  // Default common names mapping (will be enriched)
  return {
    'Colocasia esculenta': 'Taro',
    'Oryza sativa': 'Rice',
    'Solanum lycopersicum': 'Tomato',
    'Manihot esculenta': 'Cassava',
    'Ipomoea batatas': 'Sweet Potato',
  };
}

/**
 * Enriches SQLite database with interaction context and common names
 */
function enrichDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec(ATTACH_RAW_SQL);

  console.log('Starting database enrichment...');

  // Create interaction_context column if it doesn't exist
  try {
    db.exec(`
      ALTER TABLE raw.interactions
      ADD COLUMN interaction_context TEXT DEFAULT 'neutral'
    `);
    console.log('Added interaction_context column');
  } catch (err) {
    if (!err.message.includes('duplicate')) {
      console.error('Error adding interaction_context:', err);
    }
  }

  // Create species_common_names table
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS species_common_names (
        id INTEGER PRIMARY KEY,
        source_name TEXT UNIQUE NOT NULL,
        common_name TEXT,
        language TEXT DEFAULT 'en',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Created species_common_names table');
  } catch (err) {
    console.error('Error creating common_names table:', err);
  }

  // Create beneficial_chains table
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beneficial_chains (
        id INTEGER PRIMARY KEY,
        crop_id TEXT NOT NULL,
        crop_name TEXT NOT NULL,
        pest_id TEXT NOT NULL,
        pest_name TEXT NOT NULL,
        predator_id TEXT NOT NULL,
        predator_name TEXT NOT NULL,
        confidence REAL DEFAULT 0.7,
        source_type TEXT DEFAULT 'logged',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(crop_name, pest_name, predator_name)
      )
    `);
    console.log('Created beneficial_chains table');
  } catch (err) {
    console.error('Error creating beneficial_chains table:', err);
  }

  // Update interaction_context for existing interactions
  console.log('Updating interaction_context values...');
  const updateStmt = db.prepare(`
    UPDATE raw.interactions
    SET interaction_context = ?
    WHERE interaction_context = 'neutral' AND interaction_type = ?
  `);

  // Sample interaction types to categorize
  const interactionTypes = {
    positive: ['pollinates', 'preys on', 'parasitizes', 'benefits', 'protects'],
    negative: ['eats', 'parasitizes', 'pathogenic to', 'damages', 'infests'],
  };

  for (const [context, types] of Object.entries(interactionTypes)) {
    for (const type of types) {
      try {
        updateStmt.run(context, type);
      } catch (err) {
        console.error(`Error updating context for ${type}:`, err);
      }
    }
  }

  // Load and insert common names
  console.log('Loading common names...');
  const commonNames = loadCommonNames();

  const insertCommonName = db.prepare(`
    INSERT OR REPLACE INTO species_common_names (source_name, common_name, language)
    VALUES (?, ?, 'en')
  `);

  for (const [scientificName, commonName] of Object.entries(commonNames)) {
    insertCommonName.run(scientificName, commonName);
  }

  console.log(`Inserted ${Object.keys(commonNames).length} common names`);

  // Identify and store tri-trophic chains
  console.log('Identifying tri-trophic chains...');

  const findChainsStmt = db.prepare(`
    SELECT DISTINCT
      i1.source_name as crop,
      i1.target_name as pest,
      i2.target_name as predator
    FROM raw.interactions i1
    JOIN raw.interactions i2 ON i1.target_name = i2.source_name
    WHERE i1.interaction_context = 'negative'
      AND i2.interaction_context = 'positive'
  `);

  const insertChain = db.prepare(`
    INSERT OR IGNORE INTO beneficial_chains (crop_id, crop_name, pest_id, pest_name, predator_id, predator_name, source_type)
    VALUES (?, ?, ?, ?, ?, ?, 'logged')
  `);

  const chains = findChainsStmt.all();
  let chainCount = 0;

  for (const chain of chains) {
    try {
      insertChain.run(chain.crop, chain.crop, chain.pest, chain.pest, chain.predator, chain.predator);
      chainCount++;
    } catch (err) {
      console.error(`Error inserting chain ${chain.crop} → ${chain.pest} → ${chain.predator}:`, err);
    }
  }

  console.log(`Stored ${chainCount} tri-trophic chains`);

  // Create indexes for common queries
  console.log('Creating indexes...');
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_interactions_context ON raw.interactions(interaction_context);
      CREATE INDEX IF NOT EXISTS idx_interactions_source ON raw.interactions(source_name);
      CREATE INDEX IF NOT EXISTS idx_interactions_target ON raw.interactions(target_name);
      CREATE INDEX IF NOT EXISTS idx_beneficial_chains_crop ON beneficial_chains(crop_name);
      CREATE INDEX IF NOT EXISTS idx_beneficial_chains_pest ON beneficial_chains(pest_name);
      CREATE INDEX IF NOT EXISTS idx_beneficial_chains_predator ON beneficial_chains(predator_name);
    `);
    console.log('Indexes created');
  } catch (err) {
    console.error('Error creating indexes:', err);
  }

  db.close();
  console.log('Database enrichment complete!');
}

/**
 * Exports common names to CSV for offline bundle
 */
function exportCommonNamesToCsv(dbPath, outputPath) {
  const db = new Database(dbPath);

  const rows = db.prepare(`
    SELECT source_name, common_name FROM species_common_names
    ORDER BY source_name
  `).all();

  const csv = ['source_name,common_name', ...rows.map((r) => `"${r.source_name}","${r.common_name}"`)].join('\n');

  fs.writeFileSync(outputPath, csv);
  console.log(`Exported ${rows.length} common names to ${outputPath}`);

  db.close();
}

/**
 * Main function
 */
function main() {
  const dbPath = CORPUS_DB;

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  enrichDatabase(dbPath);

  // Export common names for offline
  exportCommonNamesToCsv(dbPath, path.join(__dirname, 'common_names.csv'));
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { classifyInteractionContext, enrichDatabase, exportCommonNamesToCsv };
