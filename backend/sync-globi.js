const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const readline = require('readline');
const Database = require('better-sqlite3');
const { buildInteractionTuple } = require('./lib/globi-row-map');
const { RAW_DB, ATTACH_CORPUS_SQL } = require('./lib/db-paths.cjs');

const REGIONS_PATH = path.join(__dirname, 'regions.json');

/**
 * Builds interaction_locality_coverage, species_locality_coverage, and
 * crop_locality_coverage using direct bounding box range queries — no grid
 * intermediary. Synchronous (better-sqlite3): all locality inserts run inside a
 * single db.transaction() for speed.
 */
function buildLocalityTables(db) {
  const regions = JSON.parse(fs.readFileSync(REGIONS_PATH, 'utf8'));

  const localities = [];
  for (const [country, data] of Object.entries(regions)) {
    if (data.bbox) {
      const [minLng, minLat, maxLng, maxLat] = data.bbox.split(',').map(Number);
      localities.push({ country, subdivision: '', minLat, maxLat, minLng, maxLng });
    }
    for (const sub of (data.subdivisions || [])) {
      if (sub.bbox) {
        const [minLng, minLat, maxLng, maxLat] = sub.bbox.split(',').map(Number);
        localities.push({ country, subdivision: sub.name, minLat, maxLat, minLng, maxLng });
      }
    }
  }
  console.log(`  ${localities.length} localities loaded`);

  // Drop old grid tables; (re)create coverage tables; clear for rebuild.
  db.exec('DROP TABLE IF EXISTS grid_locality');
  db.exec('DROP TABLE IF EXISTS species_grid_cells');
  db.exec('DROP TABLE IF EXISTS crop_grid_cells');
  db.exec(`CREATE TABLE IF NOT EXISTS interaction_locality_coverage (
    source_name TEXT, target_name TEXT, country TEXT, subdivision TEXT,
    PRIMARY KEY (source_name, target_name, country, subdivision)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS species_locality_coverage (
    species_name TEXT, country TEXT, subdivision TEXT,
    PRIMARY KEY (species_name, country, subdivision)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS crop_locality_coverage (
    crop_name TEXT, country TEXT, subdivision TEXT,
    PRIMARY KEY (crop_name, country, subdivision)
  )`);
  db.exec('DELETE FROM interaction_locality_coverage');
  db.exec('DELETE FROM species_locality_coverage');
  db.exec('DELETE FROM crop_locality_coverage');

  const insIlc = db.prepare(`
    INSERT OR IGNORE INTO interaction_locality_coverage (source_name, target_name, country, subdivision)
    SELECT DISTINCT source_name, target_name, ?, ?
    FROM interactions
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      AND lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
  `);
  const insSlc = db.prepare(`
    INSERT OR IGNORE INTO species_locality_coverage (species_name, country, subdivision)
    SELECT DISTINCT source_name, ?, ? FROM interactions
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      AND lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
    UNION
    SELECT DISTINCT target_name, ?, ? FROM interactions
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      AND lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
  `);

  // crop_locality_coverage joins verified_crops — only build it if that table
  // exists (it is populated by a separate sync step).
  const hasCrops = db.prepare(
    "SELECT 1 FROM corpus.sqlite_master WHERE type='table' AND name='verified_crops'"
  ).get();
  const insClc = hasCrops ? db.prepare(`
    INSERT OR IGNORE INTO crop_locality_coverage (crop_name, country, subdivision)
    SELECT DISTINCT i.source_name, ?, ? FROM interactions i
    JOIN corpus.verified_crops vc ON vc.name = i.source_name
    WHERE i.lat BETWEEN ? AND ? AND i.lng BETWEEN ? AND ?
      AND i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
    UNION
    SELECT DISTINCT i.target_name, ?, ? FROM interactions i
    JOIN corpus.verified_crops vc ON vc.name = i.target_name
    WHERE i.lat BETWEEN ? AND ? AND i.lng BETWEEN ? AND ?
      AND i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
  `) : null;

  const buildAll = db.transaction((locs) => {
    let i = 0;
    for (const loc of locs) {
      const { country, subdivision, minLat, maxLat, minLng, maxLng } = loc;
      const a = [minLat, maxLat, minLng, maxLng];
      insIlc.run(country, subdivision, ...a);
      insSlc.run(country, subdivision, ...a, country, subdivision, ...a);
      if (insClc) insClc.run(country, subdivision, ...a, country, subdivision, ...a);
      if (++i % 50 === 0) console.log(`  locality progress: ${i}/${locs.length}`);
    }
  });
  buildAll(localities);

  db.exec('CREATE INDEX IF NOT EXISTS idx_ilc_source ON interaction_locality_coverage(source_name, country, subdivision)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ilc_country ON interaction_locality_coverage(country, subdivision)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_slc_country ON species_locality_coverage(country, subdivision)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_clc_country ON crop_locality_coverage(country, subdivision)');
  console.log('  Locality tables built.');
}

// GloBI moved the bulk dump from CSV to TSV (the old /csv/interactions.csv.gz
// now 404s). Parse tab-delimited below. Column names are unchanged.
const GZ_URL = 'https://depot.globalbioticinteractions.org/snapshot/target/data/tsv/interactions.tsv.gz';
const DB_PATH = RAW_DB;
const FORCE = process.argv.includes('--force');

const db = new Database(DB_PATH);
db.exec(ATTACH_CORPUS_SQL);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 10000');

console.log('Initializing SQLite (Total Ecology Mode)...');

let existingCount = 0;
try {
  existingCount = db.prepare('SELECT COUNT(*) AS n FROM interactions').get().n;
} catch (_) {
  existingCount = 0; // interactions table doesn't exist yet
}

if (existingCount > 0 && !FORCE) {
  console.log(`interactions table already has ${existingCount.toLocaleString()} rows.`);
  console.log('Use --force to drop and re-download. Skipping to locality rebuild...');
  console.log('Building locality tables from regions.json...');
  buildLocalityTables(db);
  console.log('Local Cache Rebuilt. All regional ecological chains now available.');
  db.close();
  process.exit(0);
}

if (FORCE) console.log('--force: dropping and rebuilding interactions table...');
db.exec('DROP TABLE IF EXISTS interactions');
db.exec(`CREATE TABLE interactions (
  source_name TEXT,
  source_path TEXT,
  target_name TEXT,
  target_path TEXT,
  interaction_type TEXT,
  lat REAL,
  lng REAL,
  location TEXT,
  reference_citation TEXT,
  reference_doi TEXT,
  reference_url TEXT,
  source_citation TEXT,
  source_taxon_ids TEXT,
  target_taxon_ids TEXT,
  source_life_stage TEXT,
  target_life_stage TEXT,
  event_date TEXT,
  source_genus TEXT,
  source_family TEXT,
  source_order TEXT,
  source_class TEXT,
  source_phylum TEXT,
  source_kingdom TEXT,
  target_genus TEXT,
  target_family TEXT,
  target_order TEXT,
  target_class TEXT,
  target_phylum TEXT,
  target_kingdom TEXT
)`);
// 29 columns — tuple order matches lib/globi-row-map.js::buildInteractionTuple.
const stmt = db.prepare(`INSERT INTO interactions VALUES (${Array(29).fill('?').join(', ')})`);

let count = 0;
let inserted = 0;

// Download the dump to a local file FIRST (curl: fast bulk transfer, resumable
// via -C -, and -f fails on HTTP errors instead of silently saving a 404 HTML
// body). Then process the LOCAL file — this decouples the slow/flaky network
// transfer from the insert: a dropped connection resumes instead of restarting,
// the parse+insert runs at full local speed (not the throttled stream rate), and
// curl's progress bar gives real download feedback. The file is kept so re-runs
// skip the re-download (curl -C - returns immediately if already complete).
const DUMP_PATH = path.join(__dirname, 'globi-interactions.tsv.gz');
console.log(`Downloading dump to ${DUMP_PATH} (resumable)...`);
try {
  execSync(`curl -fL --retry 5 --retry-delay 5 -C - -o "${DUMP_PATH}" "${GZ_URL}"`, { stdio: 'inherit' });
} catch (e) {
  console.error('Download failed:', e.message);
  process.exit(1);
}
console.log('Download complete. Parsing + inserting...');

const gunzip = zlib.createGunzip();
gunzip.on('error', (e) => { console.error('Gunzip error (bad/!gzip file?):', e.message); process.exit(1); });

// Parse with core readline + manual tab-split. csv-parser deadlocks after ~50k
// rows when the consumer does synchronous work (its backpressure handling
// breaks); readline streams the full 6.7M-line file reliably (~100k lines/s).
// We materialize only the ~34 columns buildInteractionTuple needs (mapped by
// header index) — lighter and faster than building a 92-key object per row.
// better-sqlite3 inserts are synchronous so the stream is naturally throttled
// (flat memory); a COMMIT/BEGIN every 1M rows bounds the WAL and is race-free
// because better-sqlite3 is synchronous.
const NEEDED = [
  'sourceTaxonName', 'sourceTaxonPathNames', 'targetTaxonName', 'targetTaxonPathNames',
  'interactionTypeName', 'localityName', 'locationName', 'localityId',
  'decimalLatitude', 'latitude', 'decimalLongitude', 'longitude',
  'referenceCitation', 'referenceDoi', 'referenceUrl', 'sourceCitation',
  // argumentTypeId is read for the refuted-row filter (not stored).
  'argumentTypeId',
  // Resolved external taxon IDs, life stage, event date.
  'sourceTaxonIds', 'targetTaxonIds', 'sourceLifeStageName', 'targetLifeStageName', 'eventDate',
  // Pre-split lineage (source then target): genus/family/order/class/phylum/kingdom.
  'sourceTaxonGenusName', 'sourceTaxonFamilyName', 'sourceTaxonOrderName',
  'sourceTaxonClassName', 'sourceTaxonPhylumName', 'sourceTaxonKingdomName',
  'targetTaxonGenusName', 'targetTaxonFamilyName', 'targetTaxonOrderName',
  'targetTaxonClassName', 'targetTaxonPhylumName', 'targetTaxonKingdomName',
];
let headerIdx = null;

const rl = readline.createInterface({
  input: fs.createReadStream(DUMP_PATH)
    .on('error', (e) => { console.error('File read error:', e.message); process.exit(1); })
    .pipe(gunzip),
  crlfDelay: Infinity,
});

db.exec('BEGIN');

rl.on('line', (line) => {
  if (headerIdx === null) {
    const cols = line.split('\t');
    headerIdx = {};
    for (const name of NEEDED) {
      const i = cols.indexOf(name);
      if (i >= 0) headerIdx[name] = i;
    }
    return;
  }
  count++;
  const f = line.split('\t');
  const row = {};
  for (const name in headerIdx) row[name] = f[headerIdx[name]];
  const tuple = buildInteractionTuple(row);
  if (!tuple) return;
  stmt.run(tuple);
  inserted++;
  if (inserted % 200000 === 0) {
    console.log(`Processed ${count.toLocaleString()} rows... Saved ${inserted.toLocaleString()} ecological interactions.`);
  }
  if (inserted % 1000000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); } // bound WAL
});

rl.on('close', () => {
  db.exec('COMMIT');
  console.log(`--- GLOBAL ECOLOGY SYNC COMPLETE (${inserted.toLocaleString()} interactions) ---`);
  console.log('Creating indexes...');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lat_lng ON interactions(lat, lng)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_location ON interactions(location)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_source_name ON interactions(source_name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_target_name ON interactions(target_name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_interaction_type ON interactions(interaction_type)');
  console.log('Building locality tables from regions.json...');
  buildLocalityTables(db);
  console.log('Local Cache Rebuilt. All regional ecological chains now available.');
  db.close();
  process.exit(0);
});
