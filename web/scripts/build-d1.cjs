'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { resolveVarietyTraits } = require('../../backend/lib/variety-traits.js');
const { derivePathogenTransmission } = require('../../backend/lib/transmission-traits.js');

const SCHEMA_PATH = path.join(__dirname, '..', 'd1', 'schema.sql');

// Columns each D1 table actually has, learned from the committed schema.sql by
// loading it into a throwaway in-memory DB. The export emits only columns present
// in BOTH the D1 schema and the live source table, so a live-DB schema drift can
// never produce an INSERT that names a column D1 lacks (which would fail the load).
function d1ColumnsByTable() {
  const mem = new Database(':memory:');
  mem.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const tables = mem.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map(r => r.name);
  const out = {};
  for (const t of tables) {
    out[t] = mem.prepare('SELECT name FROM pragma_table_info(?)').all(t).map(r => r.name);
  }
  mem.close();
  return out;
}

// Columns to export for a table: the D1 schema's column list filtered to those that
// also exist in the live source table (preserves D1 schema column order). Throws if
// the intersection is empty (a sign the table is missing or schema.sql is stale).
function projectedCols(db, table, d1Cols) {
  const src = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r => r.name));
  const shared = (d1Cols[table] || []).filter(c => src.has(c));
  if (!shared.length) throw new Error(`build-d1: no shared columns for "${table}" between schema.sql and the source DB`);
  return shared;
}

// The set of entities that can have an SSR page: in-scope OR has a literature claim.
const ENTITY_IDS_SQL = `
  SELECT DISTINCT id FROM (
    SELECT id FROM entities WHERE scope_tier IS NOT NULL
    UNION
    SELECT subject_entity_id AS id FROM claims WHERE review_status='ai_reviewed'
    UNION
    SELECT object_entity_id  AS id FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL
    UNION
    SELECT entity_id AS id FROM entity_trait_claims WHERE review_status='ai_reviewed'
    UNION
    SELECT id FROM entities WHERE merged_into_entity_id IS NOT NULL AND slug IS NOT NULL
  ) WHERE id IS NOT NULL`;

const CLAIMS_WHERE = `(review_status='ai_reviewed') OR (data_tier='tier2_globi' AND chain_role IS NOT NULL)`;

function selectReadSubset(db) {
  const d1Cols = d1ColumnsByTable();

  const entCols = projectedCols(db, 'entities', d1Cols);
  const entities = db.prepare(`SELECT ${entCols.join(',')} FROM entities WHERE id IN (${ENTITY_IDS_SQL})`).all();

  const claimCols = projectedCols(db, 'claims', d1Cols);
  const claims = db.prepare(`SELECT ${claimCols.join(',')} FROM claims WHERE ${CLAIMS_WHERE}`).all();

  // entity_trait_claims: the trait half of the corpus, keyed by entity_id.
  const traitCols = projectedCols(db, 'entity_trait_claims', d1Cols);
  // Own trait claims for served entities; carry the (D1-only) inheritance flag = null.
  const ownTraits = db.prepare(
    `SELECT ${traitCols.join(',')} FROM entity_trait_claims WHERE review_status='ai_reviewed' AND entity_id IN (${ENTITY_IDS_SQL})`
  ).all().map(r => ({ ...r, inherited_from_entity_id: null }));

  // Materialize inherited parent traits onto each SERVED variety (parent_entity_id set + in scope).
  const servedVarietyIds = db.prepare(
    `SELECT id FROM entities WHERE parent_entity_id IS NOT NULL AND id IN (${ENTITY_IDS_SQL})`
  ).all().map(r => r.id);
  const inheritedTraits = [];
  for (const vid of servedVarietyIds) {
    for (const row of resolveVarietyTraits(db, vid)) {
      if (row.source !== 'inherited') continue;            // own rows already in ownTraits
      const projected = {};
      for (const c of traitCols) projected[c] = row[c];
      projected.entity_id = vid;
      projected.id = vid * 1_000_000_000 + row.id;          // deterministic, non-colliding, stable
      projected.inherited_from_entity_id = row.inherited_from_entity_id;
      inheritedTraits.push(projected);
    }
  }
  // Materialize DERIVED pathogen transmission traits (transmission_vector + vector_borne)
  // from the disease_vector edges — D1-only, like inheritance (see lib/transmission-traits.js).
  const servedIdSet = new Set(entities.map(e => e.id));
  const derivedTransmission = derivePathogenTransmission(db)
    .filter(r => servedIdSet.has(r.entity_id))
    .map(r => { const p = {}; for (const c of traitCols) p[c] = r[c]; return p; });

  const traitClaims = [...ownTraits, ...inheritedTraits, ...derivedTransmission];

  // sources + staging ids span BOTH claims and trait claims so references resolve.
  const sourceIds = [...new Set([...claims, ...traitClaims].map(c => c.source_id).filter(x => x != null))];
  const stagingIds = [...new Set([...claims, ...traitClaims].map(c => c.staging_id).filter(x => x != null))];

  const srcCols = projectedCols(db, 'sources', d1Cols);
  const sources = sourceIds.length
    ? db.prepare(`SELECT ${srcCols.join(',')} FROM sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
    : [];

  const verdicts = stagingIds.length
    ? db.prepare(`SELECT staging_id, critic_name, verdict FROM claim_critic_verdicts WHERE staging_id IN (${stagingIds.map(() => '?').join(',')})`).all(...stagingIds)
    : [];

  const locCols = projectedCols(db, 'claim_localities', d1Cols);
  const localities = db.prepare(
    `SELECT ${locCols.join(',')} FROM claim_localities
      WHERE claim_id IN (SELECT id FROM claims WHERE ${CLAIMS_WHERE})`
  ).all();

  // entity_common_names: multilingual vernacular names for served entities.
  const ecnCols = projectedCols(db, 'entity_common_names', d1Cols);
  const commonNames = db.prepare(
    `SELECT ${ecnCols.join(',')} FROM entity_common_names WHERE entity_id IN (${ENTITY_IDS_SQL})`
  ).all();

  // revision_log: modification provenance. Claim-target rows are DENORMALIZED
  // with the entity association (subject/object id+name, served) because the D1
  // claims mirror omits removed/quarantined claims — the rollup reads these
  // columns instead of JOINing to absent claims. Scope: entity revisions for
  // served entities + claim revisions whose subject OR object entity is served
  // (even if the claim itself was removed). Mirrors build-d1-revisions-patch.cjs.
  const revisions = db.prepare(
    `SELECT r.id, r.target_type, r.target_id, r.field, r.before_value, r.after_value, r.changed_by,
            r.method, r.reason, r.applied_at,
            NULL AS subject_entity_id, NULL AS object_entity_id, NULL AS subject_name, NULL AS object_name, NULL AS served
       FROM revision_log r
      WHERE r.target_type='entity' AND r.target_id IN (${ENTITY_IDS_SQL})
     UNION ALL
     SELECT r.id, r.target_type, r.target_id, r.field, r.before_value, r.after_value, r.changed_by,
            r.method, r.reason, r.applied_at,
            c.subject_entity_id, c.object_entity_id, es.scientific_name, eo.scientific_name,
            (CASE WHEN c.review_status='ai_reviewed' OR (c.data_tier='tier2_globi' AND c.chain_role IS NOT NULL) THEN 1 ELSE 0 END)
       FROM revision_log r
       JOIN claims c ON c.id = r.target_id
       LEFT JOIN entities es ON es.id = c.subject_entity_id
       LEFT JOIN entities eo ON eo.id = c.object_entity_id
      WHERE r.target_type='claim'
        AND (c.subject_entity_id IN (${ENTITY_IDS_SQL}) OR c.object_entity_id IN (${ENTITY_IDS_SQL}))`
  ).all();

  return { entities, claims, traitClaims, sources, verdicts, localities, revisions, commonNames };
}

function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  const escaped = String(v).replace(/'/g, "''");
  // Newlines/CR are legal inside SQLite string literals, but a literal newline in
  // the .sql file can confuse line-based statement splitters (e.g. wrangler's d1
  // --file importer). Emit them via char() concatenation so each INSERT stays on
  // one physical line AND the exact bytes round-trip (SQLite has no backslash escapes).
  if (!/[\r\n]/.test(escaped)) return `'${escaped}'`;
  return escaped
    .split(/(\r\n|\r|\n)/)
    .filter(part => part !== '')
    .map(part => {
      if (part === '\r\n') return 'char(13)||char(10)';
      if (part === '\r') return 'char(13)';
      if (part === '\n') return 'char(10)';
      return `'${part}'`;
    })
    .join('||');
}
function insertsFor(table, rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const lines = rows.map(r => `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => sqlVal(r[c])).join(',')});`);
  return lines.join('\n') + '\n';
}

function main() {
  const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
  const db = new Database(CORPUS_DB, { readonly: true });
  const sub = selectReadSubset(db);
  const outDir = path.join(__dirname, '..', 'd1');
  fs.mkdirSync(outDir, { recursive: true });
  const sql = [
    'PRAGMA foreign_keys=OFF;\n',
    insertsFor('entities', sub.entities),
    insertsFor('claims', sub.claims),
    insertsFor('entity_trait_claims', sub.traitClaims),
    insertsFor('claim_localities', sub.localities),
    insertsFor('sources', sub.sources),
    insertsFor('claim_critic_verdicts', sub.verdicts),
    insertsFor('revision_log', sub.revisions),
    insertsFor('entity_common_names', sub.commonNames),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'data.sql'), sql);
  console.log(`d1/data.sql: ${sub.entities.length} entities, ${sub.claims.length} claims, ${sub.traitClaims.length} trait-claims, ${sub.localities.length} localities, ${sub.sources.length} sources, ${sub.verdicts.length} verdicts, ${sub.revisions.length} revisions, ${sub.commonNames.length} common-names`);
  db.close();
}

function entityIdsFromMergedTombstones(db) {
  return db.prepare(
    `SELECT id FROM entities WHERE merged_into_entity_id IS NOT NULL AND slug IS NOT NULL ORDER BY id`
  ).all().map(r => r.id);
}

module.exports = { selectReadSubset, sqlVal, entityIdsFromMergedTombstones };
if (require.main === module) main();
