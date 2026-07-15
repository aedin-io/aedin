/**
 * rebuild-species-grid.js
 * Builds species_grid_cells, species_locality_coverage, and interaction_locality_coverage
 * tables from the interactions table.
 *
 * - species_grid_cells: 1° grid presence for ALL species (source or target) with coordinates
 * - species_locality_coverage: country/subdivision presence per species
 * - interaction_locality_coverage: (source, target) pairs with documented locality records
 *   → these become "logged" interactions in the neighborhood BFS
 *
 * Usage: node rebuild-species-grid.js
 * Requires: grid_locality table already built (run rebuild-localities.js first)
 * Takes 10-30 minutes on WSL filesystem due to large dataset.
 */
const sqlite3 = require('sqlite3').verbose();
const { RAW_DB } = require('./lib/db-paths.cjs');
const db = new sqlite3.Database(RAW_DB);
const start = Date.now();

function elapsed() {
  return ((Date.now() - start) / 1000).toFixed(1) + 's';
}

db.serialize(() => {
  db.run('PRAGMA journal_mode = OFF');
  db.run('PRAGMA synchronous = OFF');
  db.run('PRAGMA cache_size = -131072'); // 128MB cache

  // ── species_grid_cells ──────────────────────────────────────────────────────
  console.log('[1/3] Building species_grid_cells...');
  db.run('DROP TABLE IF EXISTS species_grid_cells');
  db.run(`CREATE TABLE species_grid_cells (
    species_name TEXT,
    lat_cell     INTEGER,
    lng_cell     INTEGER,
    PRIMARY KEY (species_name, lat_cell, lng_cell)
  )`);

  console.log('  Inserting source species...');
  db.run(`
    INSERT OR IGNORE INTO species_grid_cells (species_name, lat_cell, lng_cell)
    SELECT DISTINCT source_name, CAST(lat AS INTEGER), CAST(lng AS INTEGER)
    FROM interactions
    WHERE lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
  `, function(err) {
    if (err) { console.error('source side error:', err.message); process.exit(1); }
    console.log(`  Source side: ${this.changes.toLocaleString()} rows (${elapsed()})`);

    console.log('  Inserting target species...');
    db.run(`
      INSERT OR IGNORE INTO species_grid_cells (species_name, lat_cell, lng_cell)
      SELECT DISTINCT target_name, CAST(lat AS INTEGER), CAST(lng AS INTEGER)
      FROM interactions
      WHERE lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
    `, function(err2) {
      if (err2) { console.error('target side error:', err2.message); process.exit(1); }
      console.log(`  Target side: ${this.changes.toLocaleString()} additional rows (${elapsed()})`);

      db.get('SELECT COUNT(*) as n FROM species_grid_cells', (e, row) => {
        console.log(`  species_grid_cells: ${row.n.toLocaleString()} total rows`);
        buildLocalityCoverage();
      });
    });
  });

  // ── species_locality_coverage ───────────────────────────────────────────────
  function buildLocalityCoverage() {
    console.log('[2/3] Building species_locality_coverage...');
    db.run('DROP TABLE IF EXISTS species_locality_coverage');
    db.run(`CREATE TABLE species_locality_coverage (
      species_name TEXT,
      country      TEXT,
      subdivision  TEXT,
      PRIMARY KEY (species_name, country, subdivision)
    )`);

    db.run(`
      INSERT OR IGNORE INTO species_locality_coverage (species_name, country, subdivision)
      SELECT DISTINCT sgc.species_name, gl.country, COALESCE(gl.subdivision, '')
      FROM species_grid_cells sgc
      INNER JOIN grid_locality gl
        ON gl.lat_cell = sgc.lat_cell AND gl.lng_cell = sgc.lng_cell
    `, function(err) {
      if (err) { console.error('species_locality_coverage error:', err.message); process.exit(1); }
      console.log(`  species_locality_coverage: ${this.changes.toLocaleString()} entries (${elapsed()})`);
      db.run('CREATE INDEX IF NOT EXISTS idx_slc_country ON species_locality_coverage(country, subdivision)');
      buildInteractionLocality();
    });
  }

  // ── interaction_locality_coverage ──────────────────────────────────────────
  function buildInteractionLocality() {
    console.log('[3/3] Building interaction_locality_coverage (logged interactions)...');
    db.run('DROP TABLE IF EXISTS interaction_locality_coverage');
    db.run(`CREATE TABLE interaction_locality_coverage (
      source_name TEXT,
      target_name TEXT,
      country     TEXT,
      subdivision TEXT,
      PRIMARY KEY (source_name, target_name, country, subdivision)
    )`);

    db.run(`
      INSERT OR IGNORE INTO interaction_locality_coverage (source_name, target_name, country, subdivision)
      SELECT DISTINCT i.source_name, i.target_name, gl.country, COALESCE(gl.subdivision, '')
      FROM interactions i
      INNER JOIN grid_locality gl
        ON gl.lat_cell = CAST(i.lat AS INTEGER) AND gl.lng_cell = CAST(i.lng AS INTEGER)
      WHERE i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
    `, function(err) {
      if (err) { console.error('interaction_locality_coverage error:', err.message); process.exit(1); }
      console.log(`  interaction_locality_coverage: ${this.changes.toLocaleString()} entries (${elapsed()})`);
      db.run('CREATE INDEX IF NOT EXISTS idx_ilc_source ON interaction_locality_coverage(source_name, country, subdivision)');
      db.run('CREATE INDEX IF NOT EXISTS idx_ilc_country ON interaction_locality_coverage(country, subdivision)');

      db.get('SELECT COUNT(*) as n FROM interaction_locality_coverage', (e, row) => {
        console.log(`\nDone. ${row.n.toLocaleString()} logged interaction-locality records in ${elapsed()}.`);
        console.log('Restart the backend server to use the new tables.');
        db.close();
      });
    });
  }
});
