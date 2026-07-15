'use strict';
/**
 * load-globi-scoped.js — crop-anchored multi-pass scope expansion.
 * BFS from crops 4 levels over raw `interactions`, emitting claims for in-scope
 * edges only, tagging entities with scope_tier + claims with chain_role.
 * Synchronous better-sqlite3. Frontier = temp table joined on interactions
 * indexes; citations fetched by representative rowid (never carried through a sort).
 * Spec: docs/superpowers/specs/2026-05-27-globi-scope-expansion-design.md
 */
const Database = require('better-sqlite3');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');
const { classifyTriple, isGarbage } = require('./lib/globi-classify');
const { inferCategoryFromName } = require('./lib/entity-name-classification');

const HARMFUL = new Set(['herbivory', 'pest_pressure', 'pathogen_pressure',
  'parasitism', 'disease_vector', 'competition', 'allelopathy']);
const BENEFICIAL = new Set(['pollination', 'mutualism', 'mycorrhizal', 'facilitation']);
// EXPAND_HARMFUL = the subset of HARMFUL whose organisms have a natural enemy worth
// tracing to tier-2. Agroecologist-validated (2026-05-29): competition + allelopathy
// are plant-plant interference (no enemy to trace) -> kept as in-scope tier-1 leaves,
// never expanded. The rest are real pests; disease_vector expands to the vector's enemy.
const EXPAND_HARMFUL = new Set(['herbivory', 'pest_pressure', 'pathogen_pressure',
  'parasitism', 'disease_vector']);
// Only these bio_categories are expandable as "pests": invertebrate / microbe / fungi
// have tractable classical biocontrol. Vertebrate + plant "pests" (deer, weeds) do not
// -> kept as leaves. (Agroecologist guardrail.)
const PEST_BIO = new Set(['invertebrate', 'microbe', 'fungi']);
// ATTRACTOR: plant that subsidizes a biocontrol agent (insectary / floral-resource).
// pollination + flower_visitor are the core mechanism. mutualism DROPPED — it
// over-captures ant-tending, seed dispersal, gut symbionts (agroecologist). facilitation
// kept (habitat/refuge provision). Gates L2->L3 with neighbour.bio_category==='plantae'.
const ATTRACTOR = new Set(['pollination', 'flower_visitor', 'facilitation']);

// Optional minimum-evidence gate (opt-in via runScopedExpansion's { minRecords,
// minLocalities } options; DEFAULT in runScopedExpansion is 0/0 = no threshold).
// When enabled, requires BOTH enough records AND distinct localities — EIL/sampling
// logic for callers who want to filter to well-documented edges. Default policy is
// comprehensive: GloBI is sparse, many legitimate pests are endemic to a single
// locality, so the loader trusts the category + bio_category gates by default
// (user policy 2026-05-30). cnt = interaction_count, loc = locality_count.
function meetsEvidence(cnt, loc, { minRecords = 3, minLocalities = 2 } = {}) {
  return (cnt || 0) >= minRecords && (loc || 0) >= minLocalities;
}

// Per-level neighbour-edge query. CROSS JOIN forces `_frontier` as the OUTER table
// so SQLite drives the join from the (small, batched) frontier and SEARCHes
// interactions via idx_source_name / idx_target_name — instead of scanning the
// 27.5M-row table twice (the plan a plain JOIN picks with no ANALYZE stats, which
// made tier-1 read ~GB and risk OOM at .all()). CROSS JOIN fixes the plan
// deterministically regardless of stats/table size. Prepared once per run; the
// caller swaps the contents of `_frontier` per batch.
const SCOPED_TRIPLES_SQL = `
  WITH scoped AS (
    SELECT i.rowid AS rid, i.source_name, i.target_name, i.interaction_type, i.location
    FROM _frontier f CROSS JOIN raw.interactions i ON i.source_name = f.name
    UNION ALL
    SELECT i.rowid AS rid, i.source_name, i.target_name, i.interaction_type, i.location
    FROM _frontier f CROSS JOIN raw.interactions i ON i.target_name = f.name)
  -- UNION ALL (not UNION) avoids a TEMP B-TREE sort-dedup over the whole CROSS-JOIN
  -- output. A both-endpoints-in-frontier interaction then appears in BOTH branches, so
  -- cnt uses COUNT(DISTINCT rid) (rid = interaction rowid) to count each interaction once
  -- — identical to the old UNION+COUNT(*). loc_cnt/rep_rowid/has_locality are dedup-invariant.
  SELECT source_name, target_name, interaction_type,
         COUNT(DISTINCT rid) AS cnt, COUNT(DISTINCT location) AS loc_cnt, MAX(rid) AS rep_rowid,
         EXISTS (SELECT 1 FROM raw.interaction_locality_coverage ilc
                  WHERE ilc.source_name = scoped.source_name
                    AND ilc.target_name = scoped.target_name) AS has_locality
  FROM scoped GROUP BY source_name, target_name, interaction_type`;

function runScopedExpansion(db, { batchSize = 500, minRecords = 0, minLocalities = 0, countsOnly = false } = {}) {
  db.pragma('temp_store = FILE');
  // --counts mode is READ-ONLY: skip the clear + all writes, classify/gate/tally only,
  // so we can size the tiers in minutes before committing to a full multi-hour build.
  if (!countsOnly) {
    db.exec("DELETE FROM claims WHERE data_tier = 'tier2_globi'");
    db.exec('UPDATE entities SET scope_tier = NULL');
  }

  const byName = new Map();
  for (const e of db.prepare('SELECT id, scientific_name, bio_category, family FROM entities').all())
    byName.set(e.scientific_name.toLowerCase(), e);
  const insEntity = db.prepare('INSERT OR IGNORE INTO entities (scientific_name, bio_category, family) VALUES (?,?,?)');
  const getByName = db.prepare('SELECT id, scientific_name, bio_category, family FROM entities WHERE scientific_name = ? COLLATE NOCASE');
  let synthSeq = -1;                 // synthetic ids for unresolved names in counts-only mode
  const synthById = new Map();
  function resolve(name) {
    const k = name.toLowerCase();
    let e = byName.get(k); if (e) return e;
    const inf = inferCategoryFromName(name) || { bio_category: 'other' };
    if (countsOnly) {                // don't touch the DB; synthesize an entity row
      e = { id: synthSeq--, scientific_name: name, bio_category: inf.bio_category, family: null };
      byName.set(k, e); synthById.set(e.id, e); return e;
    }
    insEntity.run(name, inf.bio_category, null);
    e = getByName.get(name); if (e) byName.set(k, e);
    return e;
  }
  const nameByIdStmt = db.prepare('SELECT scientific_name FROM entities WHERE id=?');
  const nameById = (id) => synthById.has(id) ? synthById.get(id).scientific_name : (nameByIdStmt.get(id) || {}).scientific_name;

  const setTier = db.prepare('UPDATE entities SET scope_tier = ? WHERE id = ? AND (scope_tier IS NULL OR scope_tier > ?)');
  const insClaim = db.prepare(`INSERT INTO claims (
    subject_entity_id, object_entity_id, data_tier, interaction_type_raw,
    interaction_category, effect_direction, confidence_score, applied_weight,
    evidence_tier, valence_confidence, resolution_path, mechanism, impact_class,
    interaction_count, locality_count, country, subdivision,
    reference_citation, reference_doi, reference_url, source_count, chain_role
  ) VALUES (?,?, 'tier2_globi', ?,?,?,?,?, 'inferred', ?,?,?,?,?,?, '','', ?,?,?, 0, ?)`);
  const citStmt = db.prepare('SELECT reference_citation, reference_doi, reference_url FROM raw.interactions WHERE rowid = ?');
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _emit_map (claim_id INTEGER, source_name TEXT, target_name TEXT)');
  const insEmitMap = db.prepare('INSERT INTO _emit_map (claim_id, source_name, target_name) VALUES (?,?,?)');

  db.exec('CREATE TEMP TABLE IF NOT EXISTS _frontier (name TEXT PRIMARY KEY)');
  const insF = db.prepare('INSERT OR IGNORE INTO _frontier (name) VALUES (?)');
  const triplesStmt = db.prepare(SCOPED_TRIPLES_SQL);

  const visited = new Map();      // entityId -> tier
  // An edge (keyed by rep_rowid) is emitted at most once: the FIRST level whose
  // frontier reaches it wins its chain_role. This is correct given the strict
  // sequential L0->L1->L2->L3 ordering — an earlier hop always has priority over a
  // later one for the same biological edge, so first-role-wins matches the chain order.
  const seenEdge = new Set();     // rep_rowid -> claim already emitted

  // Returns true iff a claim was emitted (false if this edge was already emitted by
  // an earlier batch/level). Callers gate mark()/discovered on the return so each
  // edge contributes exactly once even when batching makes a both-endpoints-in-
  // frontier edge surface in two separate batches.
  const claimRoleCounts = {};
  const localityStats = { retained: 0, droppedNoLocality: 0 };
  // Returns 0 if this edge was already emitted (dedup), -1 in counts-mode
  // (emitted for sizing, no DB row), or the new claim id (>0) for a real insert.
  function emitClaim(c, t, chainRole) {
    if (seenEdge.has(t.rep_rowid)) return 0;
    seenEdge.add(t.rep_rowid);
    claimRoleCounts[chainRole] = (claimRoleCounts[chainRole] || 0) + 1;
    if (countsOnly) return -1;
    const cit = citStmt.get(t.rep_rowid) || {};
    const info = insClaim.run(c.subjectId, c.objectId, t.interaction_type, c.category, c.effect,
      c.confidence, c.weight, c.valenceConf, c.resolutionPath, c.mechanism, c.severity,
      t.cnt, t.loc_cnt, cit.reference_citation || null, cit.reference_doi || null,
      cit.reference_url || null, chainRole);
    return Number(info.lastInsertRowid);
  }
  function mark(id, tier) {
    if (!visited.has(id) || visited.get(id) > tier) { visited.set(id, tier); if (!countsOnly) setTier.run(tier, id, tier); }
  }

  // gate(c, otherEntity) -> { chainRole, expand:boolean, harmful? } | null
  // otherEntity = the endpoint NOT in the CURRENT frontier (the discovered neighbour).
  // Process ONE neighbour-edge row from triplesStmt. Mutates `discovered`.
  function processTriple(t, tier, gate, frontierSet, discovered) {
    if (isGarbage(t.source_name) || isGarbage(t.target_name)) return;
    const src = resolve(t.source_name), tgt = resolve(t.target_name);
    if (!src || !tgt) return;
    const c = classifyTriple(src, tgt, t.interaction_type || '');
    if (!c) return;
    // The "other" endpoint is the one NOT in the current frontier — determined by
    // frontier MEMBERSHIP (the FULL frontier set, not per-batch), so the gate's
    // neighbour-property check is orientation-independent: same result no matter
    // which raw column the neighbour sits in. classifyTriple may flip
    // subjectId/objectId, but neighbour selection keys off raw src/tgt names here.
    const srcInFrontier = frontierSet.has(src.scientific_name.toLowerCase());
    const tgtInFrontier = frontierSet.has(tgt.scientific_name.toLowerCase());
    // If both endpoints are in the frontier (e.g., two pests interacting, or an
    // attractor plant that is also a crop), evaluate the gate against BOTH candidate
    // neighbours and keep whichever the gate accepts — so an L3 plantae-attractor edge
    // fires when EITHER endpoint is the in-frontier biocontrol and the OTHER is plantae,
    // regardless of src/tgt order. Otherwise the neighbour is the lone out-of-frontier end.
    const ev = { cnt: t.cnt, loc: t.loc_cnt }; // per-edge evidence, same for either neighbour
    let other = null, g = null;
    if (srcInFrontier && tgtInFrontier) {
      const gTgt = gate(c, tgt, ev);
      if (gTgt) { other = tgt; g = gTgt; }
      else { const gSrc = gate(c, src, ev); if (gSrc) { other = src; g = gSrc; } }
    } else {
      other = srcInFrontier ? tgt : src;
      g = gate(c, other, ev);
    }
    if (!g) return;
    // Locality policy: drop region-less GloBI edges BEFORE emitting/expanding, using the
    // EXISTS flag from the triples query (coverage keyed on raw t.source_name/target_name).
    if (!t.has_locality) {
      if (!seenEdge.has(t.rep_rowid)) { seenEdge.add(t.rep_rowid); localityStats.droppedNoLocality++; }
      return;
    }
    const claimId = emitClaim(c, t, g.chainRole);
    if (claimId === 0) return;
    localityStats.retained++;
    if (claimId > 0) insEmitMap.run(claimId, t.source_name, t.target_name);
    mark(other.id, tier);
    if (g.expand) discovered.push({ id: other.id, harmful: !!g.harmful });
  }

  function expand(frontierNames, tier, gate) {
    // frontierSet is the FULL frontier (orientation/membership) — independent of the
    // SQL _frontier table, which we fill in batches below. Keeping it full is what
    // makes batching behaviour-identical to a single pass.
    const frontierSet = new Set();
    for (const n of frontierNames) if (n) frontierSet.add(String(n).toLowerCase());
    console.log(`  tier ${tier}: expanding ${frontierNames.length} frontier names (batch ${batchSize})...`);
    const discovered = []; // {id, harmful}
    const _t0 = process.hrtime.bigint();
    // Batch the SQL frontier so each triplesStmt.all() materializes only the
    // neighbour edges of <=batchSize names — never the whole crop neighbourhood in
    // one JS array (the unbounded .all() that risked OOM on tier-1). The CROSS JOIN
    // in SCOPED_TRIPLES_SQL keeps each batch index-driven. .all() (not .iterate())
    // because we INSERT into claims inside the loop and better-sqlite3 forbids
    // writes while a read iterator is open on the same connection.
    // Commit per batch (write mode) so memory stays bounded and an interruption costs
    // one batch, not the whole run. Wrapping the entire BFS in ONE transaction caused
    // WAL read-amplification (hours-slow) + OOM/kill on long sleep-spanning runs.
    const runBatch = (slice) => {
      db.exec('DELETE FROM _frontier');
      for (const n of slice) insF.run(n);
      for (const t of triplesStmt.all()) processTriple(t, tier, gate, frontierSet, discovered);
    };
    const runBatchTx = countsOnly ? runBatch : db.transaction(runBatch);
    for (let off = 0; off < frontierNames.length; off += batchSize) {
      runBatchTx(frontierNames.slice(off, off + batchSize));
    }
    const claimsCount = Object.values(claimRoleCounts).reduce((a, b) => a + b, 0);
    const _ms = Number(process.hrtime.bigint() - _t0) / 1e6;
    console.log(`  tier ${tier}: discovered ${discovered.length} in-scope neighbours (${claimsCount} claims so far) [${_ms.toFixed(0)} ms]`);
    return discovered;
  }

  const body = () => {
    // L0 crops
    const crops = db.prepare(`SELECT id, scientific_name FROM entities
      WHERE primary_role='crop' OR crop_type IS NOT NULL OR edible=1`).all();
    const markL0 = () => { for (const c of crops) mark(c.id, 0); };
    if (countsOnly) markL0(); else db.transaction(markL0)();
    const cropNames = crops.map(c => c.scientific_name);

    const evOk = (ev) => meetsEvidence(ev.cnt, ev.loc, { minRecords, minLocalities });

    // L0->L1: crop edges. Every harmful/beneficial crop edge emits a crop_interaction
    // claim; we EXPAND to tier-2 only pests with a tractable natural enemy — trimmed
    // category set (no competition/allelopathy) + pest bio_category (invertebrate/
    // microbe/fungi, not vertebrate/plant). evOk is opt-in via { minRecords,
    // minLocalities }; DEFAULT is comprehensive (no evidence threshold) because GloBI
    // is sparse and many legitimate pests are endemic to a single locality (user
    // policy 2026-05-30). Agroecologist-validated category/bio gates 2026-05-29.
    const l1 = expand(cropNames, 1, (c, other, ev) => {
      if (HARMFUL.has(c.category)) {
        const exp = EXPAND_HARMFUL.has(c.category) && PEST_BIO.has(other.bio_category) && evOk(ev);
        return { chainRole: 'crop_interaction', expand: exp, harmful: exp };
      }
      if (BENEFICIAL.has(c.category)) return { chainRole: 'crop_interaction', expand: false };
      return null;
    });
    const pestNames = l1.filter(d => d.harmful).map(d => nameById(d.id)).filter(Boolean);

    // L1->L2: biocontrol of pests. evOk is opt-in (default: no threshold).
    const l2 = expand(pestNames, 2, (c, other, ev) =>
      (c.category === 'biocontrol' && evOk(ev)) ? { chainRole: 'biocontrol', expand: true } : null);
    const bioNames = l2.map(d => nameById(d.id)).filter(Boolean);

    // L2->L3: plant attractors of biocontrol (insectary plants). Mutualism dropped
    // from ATTRACTOR (over-captures ant-tending/dispersal/symbionts). evOk opt-in.
    expand(bioNames, 3, (c, other, ev) =>
      (ATTRACTOR.has(c.category) && other.bio_category === 'plantae' && evOk(ev))
        ? { chainRole: 'attractant', expand: false } : null);
  };
  // Per-batch commits (inside expand) bound memory + survive interruption; the L0 crop
  // marks commit in their own transaction in body(). No single whole-BFS transaction —
  // it caused WAL read-amplification + OOM on long sleep-spanning runs.
  body();

  // One bulk set-based pass resolves every claim's localities: _emit_map(claim_id, raw
  // source/target) JOINed to coverage on the raw orientation = exactly the rows the
  // per-triple GROUP_CONCAT produced. Write-mode only (counts-mode emits no rows).
  if (!countsOnly) {
    db.prepare(`INSERT OR IGNORE INTO claim_localities (claim_id, country, subdivision)
      SELECT m.claim_id, ilc.country, ilc.subdivision
      FROM _emit_map m
      JOIN raw.interaction_locality_coverage ilc
        ON ilc.source_name = m.source_name AND ilc.target_name = m.target_name`).run();
  }

  const tierCounts = {};
  for (const t of visited.values()) tierCounts[t] = (tierCounts[t] || 0) + 1;
  return { tierCounts, claimRoleCounts, localityStats };
}

function main() {
  const countsOnly = process.argv.includes('--counts');
  const db = new Database(CORPUS_DB, countsOnly ? { readonly: true } : undefined);
  db.exec(ATTACH_RAW_SQL);
  if (!countsOnly) { db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); }
  db.pragma('cache_size = -1048576');
  console.log(`Crop-anchored scope expansion starting...${countsOnly ? ' (COUNTS-ONLY — read-only, no writes)' : ''}`);
  const res = runScopedExpansion(db, { countsOnly });
  console.log('tier counts (scope_tier -> entities):', JSON.stringify(res.tierCounts));
  console.log('claim counts (chain_role):', JSON.stringify(res.claimRoleCounts));
  console.log('locality stats:', JSON.stringify(res.localityStats),
    res.localityStats ? `(dropped ${res.localityStats.droppedNoLocality} region-less edges)` : '');
  if (!countsOnly) console.log('scoped claims in DB:', db.prepare("SELECT COUNT(*) n FROM claims WHERE data_tier='tier2_globi'").get().n);
  db.close(); console.log('Done.');
}
module.exports = { runScopedExpansion, HARMFUL, BENEFICIAL, EXPAND_HARMFUL, PEST_BIO, ATTRACTOR, meetsEvidence, SCOPED_TRIPLES_SQL };
if (require.main === module) main();
