'use strict';
/**
 * gen-inheritance-refresh.cjs — GLOBAL refresh of materialized variety trait
 * inheritance on live D1.
 *
 * Variety trait inheritance is a DERIVED, D1-only product: build-d1.cjs
 * materializes a variety's inherited parent traits (resolveVarietyTraits, gated
 * to `conserved` traits, synthetic id `varietyId*1e9+parentClaimId`). The corpus
 * stores only base claims. Surgical patches (build-d1-traits-patch, gen-claims-
 * patch) do NOT touch inheritance, and gen-variety-delta only ADDS it per-slug-
 * set — so live inheritance DRIFTS behind the corpus over time (stale parent
 * values, missing new varieties). There is no standing global refresh.
 *
 * This tool is that refresh. It reuses build-d1.cjs::selectReadSubset (the SAME
 * materialization the full build uses — no duplicated scope/id logic), isolates
 * the inherited subset, and emits a FULL-REPLACE of only that subset:
 *
 *   INSERT OR IGNORE INTO entities (...)              -- variety anchors (never overwrite)
 *   INSERT OR IGNORE INTO sources  (...)
 *   DELETE FROM entity_trait_claims WHERE inherited_from_entity_id IS NOT NULL;
 *   INSERT INTO entity_trait_claims (...)             -- current inheritance
 *
 * Base claims (inherited_from_entity_id IS NULL) and the GloBI `claims` tier are
 * untouched. The result is provably in sync with the corpus: no stale rows (a
 * parent claim removed by dedup can't leave an orphan), no missing varieties.
 * Synthetic ids are deterministic, so re-running is idempotent.
 *
 * Usage:
 *   node web/scripts/gen-inheritance-refresh.cjs [--out=web/d1/patch-inheritance-refresh.sql]
 *   # then: wrangler d1 execute agroeco --remote --file=<out>
 */
const path = require('path');
const fs = require('fs');
const { selectReadSubset, sqlVal } = require('./build-d1.cjs');

function insertsFor(table, rows, mode) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  return rows.map((r) => `${mode} INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => sqlVal(r[c])).join(',')});`);
}

/**
 * Pure: given a build read-subset ({ traitClaims, entities, sources, ... } —
 * the shape build-d1.cjs::selectReadSubset returns), emit the inheritance-refresh
 * SQL + the counts. Isolates the inherited subset (inherited_from_entity_id set),
 * scopes entities/sources to what it references.
 */
function inheritanceRefreshSql(sub) {
  const inherited = (sub.traitClaims || []).filter((t) => t.inherited_from_entity_id != null);
  const varIds = new Set(inherited.map((t) => t.entity_id));
  const srcIds = new Set(inherited.map((t) => t.source_id).filter((x) => x != null));
  const entities = (sub.entities || []).filter((e) => varIds.has(e.id));
  const sources = (sub.sources || []).filter((s) => srcIds.has(s.id));

  const out = [];
  out.push('-- variety trait inheritance refresh (gen-inheritance-refresh.cjs)');
  out.push(`-- inherited=${inherited.length} varieties=${varIds.size} sources=${sources.length}`);
  out.push(...insertsFor('entities', entities, 'INSERT OR IGNORE'));
  out.push(...insertsFor('sources', sources, 'INSERT OR IGNORE'));
  // Full-replace the DERIVED inherited subset only — base + GloBI untouched.
  out.push('DELETE FROM entity_trait_claims WHERE inherited_from_entity_id IS NOT NULL;');
  out.push(...insertsFor('entity_trait_claims', inherited, 'INSERT'));

  return { sql: out.join('\n') + '\n', counts: { inherited: inherited.length, varieties: varIds.size, sources: sources.length } };
}

module.exports = { inheritanceRefreshSql };

if (require.main === module) {
  const Database = require('better-sqlite3');
  const { CORPUS_DB } = require('../../backend/lib/db-paths.cjs');
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const a = argv.find((s) => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
  const OUT = path.resolve(__dirname, '..', flag('out', 'd1/patch-inheritance-refresh.sql'));

  const db = new Database(CORPUS_DB, { readonly: true });
  const sub = selectReadSubset(db);
  db.close();

  const { sql, counts } = inheritanceRefreshSql(sub);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, sql);
  console.log(`inheritance-refresh patch: ${OUT}`);
  console.log(`  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB — inherited=${counts.inherited} varieties=${counts.varieties} sources=${counts.sources}`);
  console.log(`  apply: wrangler d1 execute agroeco --remote --file=${path.relative(path.resolve(__dirname, '..', '..'), OUT)}`);
}
