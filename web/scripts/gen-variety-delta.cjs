'use strict';
/**
 * gen-variety-delta.cjs
 *
 * Generates a surgical D1 delta SQL file to INSERT 271 new variety entities
 * (and their inherited entity_trait_claims) into live Cloudflare D1.
 *
 * READ-ONLY on corpus DB. Does NOT touch D1 / wrangler / prod.
 * Replicates build-d1.cjs column projection + variety-traits.js inheritance logic exactly.
 *
 * Usage:
 *   node web/scripts/gen-variety-delta.cjs \
 *     --slugs /tmp/new_slugs.txt \
 *     --out /path/to/variety-delta-271.sql
 *
 * Defaults:
 *   --slugs  /tmp/new_slugs.txt
 *   --out    /tmp/variety-delta-271.sql
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── paths ──────────────────────────────────────────────────────────────────
const REPO_ROOT = path.join(__dirname, '..', '..'); // publish-main worktree root
const CORPUS_DB_PATH = path.join(REPO_ROOT, '..', '..', 'backend', 'aedin.sqlite');
const SCHEMA_PATH = path.join(__dirname, '..', 'd1', 'schema.sql');

// CLI args
const args = process.argv.slice(2);
function arg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
}
const SLUGS_FILE = arg('--slugs', '/tmp/new_slugs.txt');
const OUT_FILE   = arg('--out', '/tmp/variety-delta-271.sql');

// ── D1 schema column discovery (mirrors build-d1.cjs d1ColumnsByTable) ────
function d1ColumnsByTable() {
  const mem = new Database(':memory:');
  mem.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const tables = mem.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map(r => r.name);
  const out = {};
  for (const t of tables) {
    out[t] = mem.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(r => r.name);
  }
  mem.close();
  return out;
}

// Intersection of D1 schema cols & live corpus cols (D1 order preserved).
function projectedCols(db, table, d1Cols) {
  const src = new Set(
    db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(r => r.name)
  );
  const shared = (d1Cols[table] || []).filter(c => src.has(c));
  if (!shared.length) throw new Error(`gen-variety-delta: no shared columns for "${table}"`);
  return shared;
}

// ── trait-inheritance-class (inlined to avoid require path issues) ─────────
const UNIVERSAL_DIVERGENT = new Set([
  'host_range', 'host', 'host_plants', 'target', 'generations_per_year',
]);
const PLANT_CONSERVED = new Set([
  'ph_min', 'ph_max', 'optimal_temp_min', 'optimal_temp_max',
  'optimal_precip_min', 'optimal_precip_max', 'optimal_light', 'optimal_soil_texture',
  'tolerance_temp_min', 'tolerance_temp_max', 'native_regions', 'habitat_type', 'nitrogen_fixation',
]);
const FUNGI_CONSERVED = new Set([
  'optimal_temp_min', 'optimal_temp_max', 'primary_role', 'interaction_category',
]);
const CONSERVED_BY_KINGDOM = { plantae: PLANT_CONSERVED, fungi: FUNGI_CONSERVED };
function inheritanceClass(bioCategory, traitName) {
  if (UNIVERSAL_DIVERGENT.has(traitName)) return 'divergent';
  const conserved = CONSERVED_BY_KINGDOM[bioCategory];
  if (conserved && conserved.has(traitName)) return 'conserved';
  return 'divergent';
}

// ── SQL helpers ────────────────────────────────────────────────────────────
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  // String: escape single-quotes
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function insertRow(table, cols, row, opts = {}) {
  const vals = cols.map(c => sqlVal(row[c]));
  if (opts.orIgnore) {
    return `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')});`;
  }
  if (opts.upsertOn) {
    // Some target ids already exist in live D1 (entity row published earlier
    // with NULL slug / pre-slug-backfill). Upsert so those rows get their slug
    // + refreshed columns from the corpus (source of truth) instead of erroring
    // on the PK. No DELETE → no FK-cascade risk. Makes the delta idempotent.
    const setClause = cols
      .filter(c => c !== opts.upsertOn)
      .map(c => `${c}=excluded.${c}`)
      .join(',');
    return `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')}) ON CONFLICT(${opts.upsertOn}) DO UPDATE SET ${setClause};`;
  }
  return `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')});`;
}

// ── resolveVarietyTraits (mirrors variety-traits.js exactly) ──────────────
function aiReviewedTraits(db, entityId) {
  return db.prepare(
    `SELECT * FROM entity_trait_claims WHERE entity_id=? AND review_status='ai_reviewed'`
  ).all(entityId);
}

function resolveVarietyTraits(db, varietyId) {
  const own = aiReviewedTraits(db, varietyId).map(r => ({
    ...r, source: 'variety_specific', inherited_from_entity_id: null,
  }));
  const ent = db.prepare(
    'SELECT parent_entity_id, bio_category, variety_type FROM entities WHERE id=?'
  ).get(varietyId);
  const parentId = ent ? ent.parent_entity_id : null;
  if (parentId == null) return own;
  // Guard C: hybrid/morphotype inherit nothing.
  if (ent.variety_type === 'hybrid' || ent.variety_type === 'morphotype') return own;
  const parent = db.prepare(
    'SELECT bio_category, needs_taxonomy_review FROM entities WHERE id=?'
  ).get(parentId);
  if (!parent) return own;
  // Guard A: never inherit across kingdom boundary.
  if (parent.bio_category !== ent.bio_category) return own;
  // Guard B: never inherit from taxonomy-suspect parent.
  if (parent.needs_taxonomy_review) return own;
  const ownTraitNames = new Set(own.map(r => r.trait_name));
  const inherited = aiReviewedTraits(db, parentId)
    .filter(r => !ownTraitNames.has(r.trait_name))
    .filter(r => inheritanceClass(ent.bio_category, r.trait_name) === 'conserved')
    .map(r => ({ ...r, entity_id: varietyId, source: 'inherited', inherited_from_entity_id: parentId }));
  return [...own, ...inherited];
}

// ── main ──────────────────────────────────────────────────────────────────
function main() {
  // 1. Read slugs
  if (!fs.existsSync(SLUGS_FILE)) throw new Error(`Slugs file not found: ${SLUGS_FILE}`);
  const slugs = fs.readFileSync(SLUGS_FILE, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  console.log(`Loaded ${slugs.length} slugs from ${SLUGS_FILE}`);

  // 2. Open corpus DB (read-only)
  if (!fs.existsSync(CORPUS_DB_PATH)) throw new Error(`Corpus DB not found: ${CORPUS_DB_PATH}`);
  const db = new Database(CORPUS_DB_PATH, { readonly: true });

  // 3. Discover column intersection
  const d1Cols = d1ColumnsByTable();
  const entCols = projectedCols(db, 'entities', d1Cols);
  const traitCols = projectedCols(db, 'entity_trait_claims', d1Cols);
  console.log(`Entity columns (${entCols.length}): ${entCols.join(', ')}`);
  console.log(`ETC corpus columns (${traitCols.length}): ${traitCols.join(', ')}`);
  // inherited_from_entity_id is D1-only (not in corpus table); appended explicitly below
  console.log(`ETC emitted columns: ${traitCols.length + 1} (+ inherited_from_entity_id)`);

  // 4. Resolve slugs → entity rows
  const entitiesMap = new Map(); // slug → row
  const missingSlug = [];
  for (const slug of slugs) {
    const row = db.prepare(
      `SELECT ${entCols.join(',')} FROM entities WHERE slug=?`
    ).get(slug);
    if (!row) {
      missingSlug.push(slug);
    } else {
      entitiesMap.set(slug, row);
    }
  }
  if (missingSlug.length > 0) {
    console.error(`WARNING: ${missingSlug.length} slugs not found in corpus:`);
    missingSlug.forEach(s => console.error('  MISSING:', s));
  }

  const entityRows = [...entitiesMap.values()];
  const entityIds = entityRows.map(r => r.id);
  console.log(`Resolved ${entityRows.length} / ${slugs.length} slugs to entity rows`);

  // 5. Parent-liveness check
  // Collect distinct parent_entity_id values and check their scope_tier in corpus
  const parentCheck = db.prepare(
    `SELECT id, scientific_name, slug, scope_tier, needs_taxonomy_review FROM entities WHERE id=?`
  );
  const nonServedParents = [];
  const parentIds = [...new Set(entityRows.map(r => r.parent_entity_id).filter(x => x != null))];
  const parentInfo = [];
  for (const pid of parentIds) {
    const p = parentCheck.get(pid);
    if (!p) {
      nonServedParents.push({ pid, note: 'NOT FOUND IN CORPUS' });
    } else if (p.scope_tier === null || p.scope_tier === undefined) {
      nonServedParents.push({ pid, slug: p.slug, name: p.scientific_name, note: 'scope_tier IS NULL — NOT served' });
    } else {
      parentInfo.push({ pid, slug: p.slug, name: p.scientific_name, scope_tier: p.scope_tier, needs_taxonomy_review: p.needs_taxonomy_review });
    }
  }

  console.log(`\nParent-liveness check: ${parentIds.length} distinct parent_entity_ids`);
  if (nonServedParents.length > 0) {
    console.error(`\nFLAG: ${nonServedParents.length} parents with scope_tier IS NULL (not served → broken parent link):`);
    nonServedParents.forEach(p => console.error(`  parent_id=${p.pid} slug=${p.slug} name=${p.name} — ${p.note}`));
  } else {
    console.log('  All parents have scope_tier set (served in D1). ✓');
  }
  console.log(`  Served parents: ${parentInfo.length}`);
  parentInfo.forEach(p =>
    console.log(`    id=${p.pid} scope_tier=${p.scope_tier} needs_taxonomy_review=${p.needs_taxonomy_review} slug=${p.slug} — ${p.name}`)
  );

  // 6. variety_type breakdown
  const vtBreakdown = {};
  for (const r of entityRows) {
    const vt = r.variety_type || '(null)';
    vtBreakdown[vt] = (vtBreakdown[vt] || 0) + 1;
  }
  console.log('\nvariety_type breakdown:');
  for (const [vt, cnt] of Object.entries(vtBreakdown)) {
    console.log(`  ${vt}: ${cnt}`);
  }

  // traitCols from the corpus intersection will NOT include `inherited_from_entity_id`
  // (that column is D1-only, synthesized by build-d1.cjs). We emit it explicitly in
  // the INSERT by using traitColsFull = traitCols + inherited_from_entity_id for ETC rows.
  // This mirrors build-d1.cjs which sets projected.inherited_from_entity_id after the
  // column-intersection loop, so it appears in the INSERT values.
  const traitColsFull = [...traitCols, 'inherited_from_entity_id'];

  // 7. Generate inherited trait rows
  const inheritedTraitRows = [];
  for (const vid of entityIds) {
    for (const row of resolveVarietyTraits(db, vid)) {
      if (row.source !== 'inherited') continue; // own rows: variety has no ai_reviewed traits (checked below)
      const projected = {};
      for (const c of traitCols) projected[c] = row[c];
      projected.entity_id = vid;
      projected.id = vid * 1_000_000_000 + row.id; // deterministic, stable, non-colliding
      projected.inherited_from_entity_id = row.inherited_from_entity_id;
      inheritedTraitRows.push(projected);
    }
  }

  // Also collect own trait rows for these varieties (if any)
  const ownTraitRows = [];
  for (const vid of entityIds) {
    const own = db.prepare(
      `SELECT ${traitCols.join(',')} FROM entity_trait_claims WHERE entity_id=? AND review_status='ai_reviewed'`
    ).all(vid);
    for (const r of own) {
      ownTraitRows.push({ ...r, inherited_from_entity_id: null });
    }
  }

  console.log(`\nEntity INSERTs: ${entityRows.length}`);
  console.log(`Own trait-claim INSERTs: ${ownTraitRows.length}`);
  console.log(`Inherited trait-claim INSERTs: ${inheritedTraitRows.length}`);
  console.log(`Total entity_trait_claims INSERTs: ${ownTraitRows.length + inheritedTraitRows.length}`);

  // 8. Spot-check prints
  const spotSlugs = ['solanum-lycopersicum-a-kosta-perchev-vidin', 'solanum-lycopersicum-5635m', 'capsicum-annuum-bell-boy-hybrid'];
  console.log('\n── SPOT CHECK ─────────────────────────────────────────────');
  for (const ss of spotSlugs) {
    const er = entitiesMap.get(ss);
    if (!er) { console.log(`  [not in target set]: ${ss}`); continue; }
    const eInsert = insertRow('entities', entCols, er);
    const itsOwn = ownTraitRows.filter(r => r.entity_id === er.id);
    const itsInh = inheritedTraitRows.filter(r => r.entity_id === er.id);
    console.log(`\n[${ss}]`);
    console.log(`  entity INSERT:\n    ${eInsert}`);
    console.log(`  own trait rows: ${itsOwn.length}, inherited trait rows: ${itsInh.length}`);
    if (itsInh.length > 0) {
      console.log(`  first inherited ETC INSERT:\n    ${insertRow('entity_trait_claims', traitColsFull, itsInh[0])}`);
    }
  }
  console.log('──────────────────────────────────────────────────────────\n');

  // 9. Emit SQL file
  const lines = [];
  lines.push('-- variety-delta-271.sql');
  lines.push('-- Generated by web/scripts/gen-variety-delta.cjs');
  lines.push(`-- ${new Date().toISOString()}`);
  lines.push(`-- Adds ${entityRows.length} new variety entities + their inherited/own trait claims.`);
  lines.push('-- Apply inside a transaction; safe to wrap in BEGIN/COMMIT.');
  lines.push('');
  lines.push('-- ── ENTITIES ──────────────────────────────────────────────────────────────');
  for (const row of entityRows) {
    lines.push(insertRow('entities', entCols, row, { upsertOn: 'id' }));
  }
  lines.push('');
  lines.push('-- ── ENTITY_TRAIT_CLAIMS (own) ────────────────────────────────────────────');
  if (ownTraitRows.length === 0) {
    lines.push('-- (no own ai_reviewed trait claims for these 271 varieties)');
  }
  for (const row of ownTraitRows) {
    lines.push(insertRow('entity_trait_claims', traitColsFull, row, { orIgnore: true }));
  }
  lines.push('');
  lines.push('-- ── ENTITY_TRAIT_CLAIMS (inherited from parent species) ──────────────────');
  if (inheritedTraitRows.length === 0) {
    lines.push('-- (no inherited conserved trait claims for these 271 varieties)');
  }
  for (const row of inheritedTraitRows) {
    lines.push(insertRow('entity_trait_claims', traitColsFull, row, { orIgnore: true }));
  }
  lines.push('');

  fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
  console.log(`\nSQL delta written to: ${OUT_FILE}`);
  console.log(`Lines: ${lines.length}`);

  db.close();
}

main();
