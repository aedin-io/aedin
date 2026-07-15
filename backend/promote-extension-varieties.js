'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log');
const { normalizeVarietyName, completenessOk, dedupDecision } = require('./lib/variety-promote');
const { slugify: slugifyEntity, uniqueSlug } = require('./lib/slugify');

const CHANGED_BY = 'promote-extension-varieties';
const METHOD = 'promote-extension-varieties';

function slugify(s) {
  return String(s || 'source').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
}

function ensureSource(db, name, url) {
  const found = db.prepare('SELECT id FROM sources WHERE url=?').get(url);
  if (found) return found.id;
  const info = db.prepare(
    'INSERT INTO sources (title, url, source_type, slug) VALUES (?,?,?,?)'
  ).run(name || url, url, 'extension', slugify(name || url));
  return info.lastInsertRowid;
}

function findParent(db, speciesName) {
  return db.prepare(
    'SELECT id FROM entities WHERE LOWER(scientific_name)=LOWER(?) AND parent_entity_id IS NULL LIMIT 1'
  ).get(speciesName);
}

// Promote a single crop_varieties-shaped row. Idempotent. Returns {action, entityId?, traitWritten, reason?}.
function promoteOne(db, row) {
  const parent = findParent(db, row.species_name);
  if (!parent) return { action: 'skip', reason: 'no_parent', traitWritten: false };
  if (!completenessOk(row)) return { action: 'skip', reason: 'no_traits', traitWritten: false };

  const name = normalizeVarietyName(row.variety_name);
  const existing = db.prepare('SELECT id, variety_name FROM entities WHERE parent_entity_id=?').all(parent.id);
  const decision = dedupDecision(existing, name);

  let entityId, action = decision.action;
  if (decision.action === 'update') {
    entityId = decision.targetId;
  } else {
    const sci = `${row.species_name} '${name}'`;
    const needsDedup = decision.action === 'create-flag' ? 1 : 0;
    const slug = uniqueSlug(db, slugifyEntity(sci));
    const info = db.prepare(
      `INSERT INTO entities (scientific_name, common_name, variety_name, parent_entity_id,
         bio_category, primary_role, source_table, scope_tier, native_regions, needs_dedup, slug)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(sci, name, name, parent.id, 'plantae', 'crop', 'extension_scrape', 0,
          JSON.stringify(row.region ? [row.region] : []), needsDedup, slug);
    entityId = info.lastInsertRowid;
    logRevisions(db, { targetType:'entity', targetId:entityId, changedBy:CHANGED_BY, method:METHOD,
      changes:[{ field:'created', before:null, after:sci }] });
  }

  // Upsert the days_to_harvest trait claim (idempotent on entity+trait+method-source).
  const sourceId = ensureSource(db, row.source_name, row.source_url);
  const maturity = Number(row.maturity_days);
  const quote = row.maturity_quote || `${maturity} days`;   // preserve verbatim phrasing if the scrape captured it
  const exists = db.prepare(
    "SELECT id FROM entity_trait_claims WHERE entity_id=? AND trait_name='days_to_harvest' AND source_id=?"
  ).get(entityId, sourceId);
  let traitWritten = false;
  if (!exists) {
    db.prepare(
      `INSERT INTO entity_trait_claims (entity_id, trait_name, value_numeric, source_id, source_quote, regional_context, review_status)
       VALUES (?,?,?,?,?,?,?)`
    ).run(entityId, 'days_to_harvest', maturity, sourceId, quote, row.region || null, 'ai_reviewed');
    logRevisions(db, { targetType:'entity_trait_claim', targetId:entityId, changedBy:CHANGED_BY, method:METHOD,
      changes:[{ field:'days_to_harvest', before:null, after:String(maturity) }] });
    traitWritten = true;
  }
  return { action, entityId, traitWritten };
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const rows = db.prepare('SELECT * FROM crop_varieties').all();
  if (!apply) {
    db.close();
    console.log(`DRY RUN — ${rows.length} crop_varieties rows. Re-run with --apply.`);
    return;
  }
  const tally = { create:0, 'create-flag':0, update:0, skip:0, traits:0 };
  const run = db.transaction(() => {
    for (const r of rows) {
      const res = promoteOne(db, r);
      tally[res.action] = (tally[res.action] || 0) + 1;
      if (res.traitWritten) tally.traits++;
    }
  });
  run();
  db.close();
  console.log('Applied:', JSON.stringify(tally));
}

if (require.main === module) main();
module.exports = { promoteOne, ensureSource };
