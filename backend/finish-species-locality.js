/**
 * finish-species-locality.js
 * Builds species_locality_coverage and interaction_locality_coverage
 * from the already-completed species_grid_cells table.
 * Run this when rebuild-species-grid.js fails midway through step 2 or 3.
 */
const sqlite3 = require('sqlite3').verbose();
const { RAW_DB } = require('./lib/db-paths.cjs');
const db = new sqlite3.Database(RAW_DB);
const start = Date.now();
function elapsed() { return ((Date.now() - start) / 1000).toFixed(1) + 's'; }

db.serialize(() => {
  db.run('PRAGMA journal_mode = OFF');
  db.run('PRAGMA synchronous = OFF');
  db.run('PRAGMA cache_size = -131072');

  console.log('[2/3] Building species_locality_coverage...');
  db.run('DROP TABLE IF EXISTS species_locality_coverage', function(err) {
    if (err) { console.error('drop slc error:', err.message); process.exit(1); }
    db.run(`CREATE TABLE species_locality_coverage (
      species_name TEXT, country TEXT, subdivision TEXT,
      PRIMARY KEY (species_name, country, subdivision)
    )`, function(err2) {
      if (err2) { console.error('create slc error:', err2.message); process.exit(1); }
      db.run(`
        INSERT OR IGNORE INTO species_locality_coverage (species_name, country, subdivision)
        SELECT DISTINCT sgc.species_name, gl.country, COALESCE(gl.subdivision, '')
        FROM species_grid_cells sgc
        INNER JOIN grid_locality gl ON gl.lat_cell = sgc.lat_cell AND gl.lng_cell = sgc.lng_cell
      `, function(err3) {
        if (err3) { console.error('insert slc error:', err3.message); process.exit(1); }
        console.log(`  species_locality_coverage: ${this.changes.toLocaleString()} entries (${elapsed()})`);
        db.run('CREATE INDEX IF NOT EXISTS idx_slc_country ON species_locality_coverage(country, subdivision)');
        buildInteractionLocality();
      });
    });
  });

  function buildInteractionLocality() {
    console.log('[3/3] Building interaction_locality_coverage...');
    db.run('DROP TABLE IF EXISTS interaction_locality_coverage', function(err) {
      if (err) { console.error('drop ilc error:', err.message); process.exit(1); }
      db.run(`CREATE TABLE interaction_locality_coverage (
        source_name TEXT, target_name TEXT, country TEXT, subdivision TEXT,
        PRIMARY KEY (source_name, target_name, country, subdivision)
      )`, function(err2) {
        if (err2) { console.error('create ilc error:', err2.message); process.exit(1); }
        db.run(`
          INSERT OR IGNORE INTO interaction_locality_coverage (source_name, target_name, country, subdivision)
          SELECT DISTINCT i.source_name, i.target_name, gl.country, COALESCE(gl.subdivision, '')
          FROM interactions i
          INNER JOIN grid_locality gl
            ON gl.lat_cell = CAST(i.lat AS INTEGER) AND gl.lng_cell = CAST(i.lng AS INTEGER)
          WHERE i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
        `, function(err3) {
          if (err3) { console.error('insert ilc error:', err3.message); process.exit(1); }
          console.log(`  interaction_locality_coverage: ${this.changes.toLocaleString()} entries (${elapsed()})`);
          db.run('CREATE INDEX IF NOT EXISTS idx_ilc_source ON interaction_locality_coverage(source_name, country, subdivision)');
          db.run('CREATE INDEX IF NOT EXISTS idx_ilc_country ON interaction_locality_coverage(country, subdivision)', function() {
            console.log(`\nDone in ${elapsed()}. Restart the server.`);
            db.close();
          });
        });
      });
    });
  }
});
