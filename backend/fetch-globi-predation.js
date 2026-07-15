/**
 * fetch-globi-predation.js
 *
 * Supplemental script that fetches predation/parasitism interaction records
 * from the live GloBI API and inserts them into the interactions table.
 *
 * Background: sync-globi.js filters out records without location data, but
 * literature-derived biocontrol relationships (preysOn, parasiteOf, etc.)
 * rarely have coordinates. This script fills that gap by querying the API
 * for specific interaction types involving organisms already in our database.
 *
 * Usage:
 *   node fetch-globi-predation.js                 # fetch for biocontrol + pest entities
 *   node fetch-globi-predation.js --role biocontrol  # only biocontrol entities
 *   node fetch-globi-predation.js --family Coccinellidae  # only one family
 *   node fetch-globi-predation.js --entity "Coccinella septempunctata"  # single organism
 *   node fetch-globi-predation.js --dry-run       # preview without inserting
 *   node fetch-globi-predation.js --limit 100     # max entities to query
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');
const https = require('https');

const DB_PATH = CORPUS_DB;
const API_BASE = 'https://api.globalbioticinteractions.org';

// Interaction types that indicate predation/parasitism/biocontrol
const PREDATION_TYPES = ['preysOn', 'parasiteOf', 'parasitoidOf', 'kills', 'pathogenOf'];
// Reverse types (target is the predator/parasite)
const REVERSE_TYPES = ['preyedUponBy', 'hasParasite', 'hasParasitoid', 'hasPathogen'];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error for ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseGlobiResponse(json) {
  if (!json || !json.columns || !json.data) return [];
  const cols = json.columns;
  const ci = (name) => cols.indexOf(name);
  return json.data.map(row => ({
    sourceName: row[ci('source_taxon_name')],
    sourcePath: row[ci('source_taxon_path')] || '',
    targetName: row[ci('target_taxon_name')],
    targetPath: row[ci('target_taxon_path')] || '',
    interactionType: row[ci('interaction_type')],
    lat: row[ci('latitude')] ? parseFloat(row[ci('latitude')]) : null,
    lng: row[ci('longitude')] ? parseFloat(row[ci('longitude')]) : null,
    location: null,
    reference: row[ci('study_title')] || null,
    source: 'GloBI API fetch',
  }));
}

async function fetchInteractionsForOrganism(name, interactionType) {
  const url = `${API_BASE}/interaction?sourceTaxon=${encodeURIComponent(name)}&interactionType=${interactionType}&type=json&limit=500`;
  try {
    const data = await fetchJSON(url);
    return parseGlobiResponse(data);
  } catch (e) {
    console.error(`  Error fetching ${interactionType} for ${name}: ${e.message}`);
    return [];
  }
}

async function fetchReverseInteractions(name, interactionType) {
  const url = `${API_BASE}/interaction?targetTaxon=${encodeURIComponent(name)}&interactionType=${interactionType}&type=json&limit=500`;
  try {
    const data = await fetchJSON(url);
    return parseGlobiResponse(data);
  } catch (e) {
    console.error(`  Error fetching reverse ${interactionType} for ${name}: ${e.message}`);
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const roleFilter = getArgValue(args, '--role');
  const familyFilter = getArgValue(args, '--family');
  const entityFilter = getArgValue(args, '--entity');
  const limitArg = getArgValue(args, '--limit');
  const entityLimit = limitArg ? parseInt(limitArg, 10) : 500;

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(ATTACH_RAW_SQL);
  await db.run('PRAGMA journal_mode = WAL');
  await db.run('PRAGMA busy_timeout = 10000');

  // Track which entities we've already queried
  await db.exec(`CREATE TABLE IF NOT EXISTS raw.globi_fetch_log (
    entity_id INTEGER PRIMARY KEY,
    fetched_at TEXT DEFAULT (datetime('now'))
  )`);

  // Build entity query — focus on biocontrol agents (as predators) and pest insects (as prey)
  let where = 'e.parent_entity_id IS NULL';
  const params = [];

  if (entityFilter) {
    where += ' AND e.scientific_name = ? COLLATE NOCASE';
    params.push(entityFilter);
  } else if (familyFilter) {
    where += ' AND e.family = ? COLLATE NOCASE';
    params.push(familyFilter);
  } else if (roleFilter) {
    where += ' AND e.primary_role = ?';
    params.push(roleFilter);
  } else {
    // Default: biocontrol agents as subjects, pest insects as targets
    where += " AND e.primary_role IN ('biocontrol', 'beneficial_predator', 'beneficial_parasitoid', 'pest_insect', 'pest_mite')";
  }

  // Skip entities already fetched (unless --entity or --force)
  if (!entityFilter && !args.includes('--force')) {
    where += ' AND gfl.entity_id IS NULL';
  }

  const entities = await db.all(`
    SELECT e.id, e.scientific_name, e.primary_role, e.family, e.bio_category
    FROM entities e
    LEFT JOIN raw.globi_fetch_log gfl ON gfl.entity_id = e.id
    WHERE ${where}
    ORDER BY e.primary_role, e.scientific_name
    LIMIT ?
  `, [...params, entityLimit]);

  console.log(`=== Fetch GloBI Predation Data (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`Entities to query: ${entities.length}`);

  // Split into predators (query as subject) and prey (query as target)
  const predators = entities.filter(e =>
    ['biocontrol', 'beneficial_predator', 'beneficial_parasitoid'].includes(e.primary_role));
  const prey = entities.filter(e =>
    ['pest_insect', 'pest_mite'].includes(e.primary_role));

  console.log(`  Predators/parasitoids to query as source: ${predators.length}`);
  console.log(`  Pests to query as target: ${prey.length}\n`);

  // Check existing interactions to avoid duplicates
  const existingSet = new Set();
  const existing = await db.all(`
    SELECT source_name, target_name, interaction_type
    FROM raw.interactions
    WHERE interaction_type IN ('preysOn', 'parasiteOf', 'parasitoidOf', 'kills', 'pathogenOf',
                               'preyedUponBy', 'hasParasite', 'hasParasitoid', 'hasPathogen')
  `);
  for (const row of existing) {
    existingSet.add(`${row.source_name}||${row.target_name}||${row.interaction_type}`);
  }
  console.log(`Existing predation interactions in DB: ${existingSet.size}\n`);

  // interactions table has 8 columns: source_name, source_path, target_name, target_path,
  // interaction_type, lat, lng, location (no reference/source columns in current schema)
  const stmt = dryRun ? null : await db.prepare(
    'INSERT INTO raw.interactions (source_name, source_path, target_name, target_path, interaction_type, lat, lng, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  let totalFetched = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let queriesMade = 0;

  if (!dryRun) await db.run('BEGIN TRANSACTION');

  const logStmt = dryRun ? null : await db.prepare(
    'INSERT OR REPLACE INTO raw.globi_fetch_log (entity_id) VALUES (?)'
  );

  // Query predators as source
  for (let i = 0; i < predators.length; i++) {
    const entity = predators[i];
    process.stdout.write(`  [${i + 1}/${predators.length}] ${entity.scientific_name} (${entity.primary_role})...`);

    let entityNew = 0;
    for (const iType of PREDATION_TYPES) {
      const records = await fetchInteractionsForOrganism(entity.scientific_name, iType);
      queriesMade++;
      totalFetched += records.length;

      for (const r of records) {
        const key = `${r.sourceName}||${r.targetName}||${r.interactionType}`;
        if (existingSet.has(key)) {
          totalSkipped++;
          continue;
        }
        existingSet.add(key);

        if (!dryRun) {
          await stmt.run([
            r.sourceName, r.sourcePath, r.targetName, r.targetPath,
            r.interactionType,
            isNaN(r.lat) ? null : r.lat,
            isNaN(r.lng) ? null : r.lng,
            r.location
          ]);
        }
        totalInserted++;
        entityNew++;
      }

      // Rate limit: ~200ms between API calls
      await sleep(200);
    }

    if (!dryRun) await logStmt.run(entity.id);
    console.log(` +${entityNew} new`);
  }

  // Query pests as target
  for (let i = 0; i < prey.length; i++) {
    const entity = prey[i];
    process.stdout.write(`  [${i + 1}/${prey.length}] ${entity.scientific_name} as prey...`);

    let entityNew = 0;
    for (const iType of PREDATION_TYPES) {
      // Query: what preysOn/parasiteOf this pest?
      const records = await fetchReverseInteractions(entity.scientific_name, iType);
      queriesMade++;
      totalFetched += records.length;

      for (const r of records) {
        const key = `${r.sourceName}||${r.targetName}||${r.interactionType}`;
        if (existingSet.has(key)) {
          totalSkipped++;
          continue;
        }
        existingSet.add(key);

        if (!dryRun) {
          await stmt.run([
            r.sourceName, r.sourcePath, r.targetName, r.targetPath,
            r.interactionType,
            isNaN(r.lat) ? null : r.lat,
            isNaN(r.lng) ? null : r.lng,
            r.location
          ]);
        }
        totalInserted++;
        entityNew++;
      }

      await sleep(200);
    }

    if (!dryRun) await logStmt.run(entity.id);
    console.log(` +${entityNew} new`);
  }

  if (!dryRun) {
    await db.run('COMMIT');
    if (stmt) await stmt.finalize();
    if (logStmt) await logStmt.finalize();
  }

  console.log(`\n=== Summary ===`);
  console.log(`API queries made: ${queriesMade}`);
  console.log(`Records fetched: ${totalFetched}`);
  console.log(`New records inserted: ${totalInserted}`);
  console.log(`Duplicates skipped: ${totalSkipped}`);

  if (totalInserted > 0 && !dryRun) {
    console.log(`\nNext step: run 'node load-globi-claims.js --force' to process new interactions into claims.`);
  }

  await db.close();
  console.log('Done.');
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
