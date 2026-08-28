#!/usr/bin/env node
'use strict';
/**
 * resolve-entities-to-ott.js — link entities to the OTT backbone.
 *
 * WRITES TWO COLUMNS AND NOTHING ELSE: entities.ott_id and entities.ott_status.
 * The existing taxonomy columns are deliberately untouched — this pass builds a
 * reference to reconcile against, it does not correct anything.
 *
 * Cascade: exact local -> normalized local -> TNRS fallback (context-pinned,
 * grouped by bio_category) -> unmatched. TNRS-resolved rows get
 * ott_status='resolved_tnrs' (not 'resolved_local') — they depend on a live
 * service, not the pinned OTT 3.7 dump, so they aren't reproducible offline.
 *
 *   node resolve-entities-to-ott.js                # dry-run
 *   node resolve-entities-to-ott.js --limit=500
 *   node resolve-entities-to-ott.js --apply
 *   node resolve-entities-to-ott.js --no-network    # skip TNRS; residual stays unmatched
 */
const Database = require('better-sqlite3');
const { CORPUS_DB, OTT_DB } = require('./lib/db-paths.cjs');
const { resolve, normalizeName, curatedKingdomHint, binomialOf, validateTnrsMatch } = require('./lib/ott-resolve.js');
const { candidatesFor, kingdomOf } = require('./lib/ott-lookup.js');
const { logRevisions } = require('./lib/revision-log.js');
const { groupByContext, matchNames } = require('./lib/ott-tnrs-fallback.js');
const { OTT_RELEASE, checkOttDbVersion } = require('./lib/ott-release.js');

const arg = (f) => {
  const h = process.argv.find(a => a.startsWith(`--${f}=`));
  return h ? h.slice(f.length + 3) : null;
};

// Ranks a binomial fallback is allowed to land on. A truncated name must resolve
// to an actual species-level taxon; anything coarser means the truncation
// produced a different concept rather than the parent species.
const BINOMIAL_OK_RANKS = new Set(['species', 'subspecies', 'varietas', 'variety', 'form', 'forma']);

function resolveOne(ottDb, entity) {
  const hint = curatedKingdomHint(entity.scientific_name);

  // 1. exact
  let candidates = candidatesFor(ottDb, entity.scientific_name);

  // 2. normalized (authority, hybrid markers, infraspecific rank words, whitespace)
  if (candidates.length === 0) {
    const norm = normalizeName(entity.scientific_name);
    if (norm && norm !== entity.scientific_name.trim()) {
      candidates = candidatesFor(ottDb, norm);
    }
  }
  if (candidates.length > 0) {
    return resolve({ name: entity.scientific_name, candidates, curatedHint: hint });
  }

  // 3. binomial fallback. OTT carries species; this corpus carries subspecies,
  //    varieties, trinomials and quoted cultivars. That is a GRANULARITY
  //    mismatch, and the correct answer is the parent species — a subspecies
  //    belongs to its species, and shares its lineage exactly. It is reported as
  //    `resolved_binomial` rather than `resolved_local` because the link is
  //    MANY-TO-ONE — siblings collapse onto one ott_id, so ott_id is not an
  //    identity key for these rows.
  const binomial = binomialOf(normalizeName(entity.scientific_name)) || binomialOf(entity.scientific_name);
  if (binomial) {
    const bc = candidatesFor(ottDb, binomial).filter(c => BINOMIAL_OK_RANKS.has(c.rank));
    if (bc.length > 0) {
      const r = resolve({ name: binomial, candidates: bc, curatedHint: hint });
      if (r.accept) return { ...r, reason: 'resolved_binomial', binomial };
      return r;
    }
  }

  return resolve({ name: entity.scientific_name, candidates: [], curatedHint: hint });
}

(async () => {
  const apply = process.argv.includes('--apply');
  const limit = arg('limit');
  // Read-only unless we're actually going to write — the corpus has no
  // routine backup (see the corpus-backup-gap memory), so a dry-run must
  // never even be capable of touching it.
  const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB, apply ? {} : { readonly: true });
  const ottDb = new Database(OTT_DB, { readonly: true });

  {
    const v = checkOttDbVersion(ottDb);
    if (!v.ok) {
      console.error(
        `FATAL: ott.sqlite version mismatch — expected OTT ${OTT_RELEASE.version}, ` +
        `found ${v.found === null ? '(no ott_meta.version row — incomplete or stale build)' : v.found}. ` +
        `Rebuild with: node build-ott-db.js`
      );
      db.close(); ottDb.close();
      process.exit(1);
    }
  }

  const entities = db.prepare(
    `SELECT id, scientific_name, bio_category, ott_id, ott_status FROM entities
     WHERE merged_into_entity_id IS NULL
     ${limit ? 'LIMIT ' + Number(limit) : ''}`).all();

  console.log(`=== resolve-entities-to-ott (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`entities ${entities.length}\n`);

  const tally = {};
  const residual = [];            // collected here, NOT by re-resolving afterwards
  const upd = db.prepare('UPDATE entities SET ott_id = ?, ott_status = ? WHERE id = ?');
  const run = db.transaction(() => {
    for (const e of entities) {
      // A row already resolved via the live TNRS fallback is, by definition,
      // NOT locally resolvable (that's why it went through TNRS in the first
      // place). Re-running local resolution on it would always fail, and
      // without this guard the no-op check below ('unmatched' !== stored
      // 'resolved_tnrs') would fire on every re-run, clobbering the row back
      // to unmatched — which then requires the TNRS pass to fix it again on
      // every single invocation. Treat it as settled and leave it alone.
      if (e.ott_status === 'resolved_tnrs') {
        tally.resolved_tnrs = (tally.resolved_tnrs || 0) + 1;
        continue;
      }
      const r = resolveOne(ottDb, e);
      const status = r.accept ? (r.reason === 'resolved_binomial' ? 'resolved_binomial' : 'resolved_local') : r.reason;
      tally[status] = (tally[status] || 0) + 1;
      if (status === 'unmatched') residual.push(e);
      if (!apply) continue;
      if (e.ott_id === (r.ott_id || null) && e.ott_status === status) continue;
      upd.run(r.ott_id, status, e.id);
      logRevisions(db, {
        targetType: 'entity', targetId: e.id, changedBy: 'ott-resolve',
        method: 'resolve_entities_to_ott',
        reason: `OTT 3.7 local resolution: ${status}`,
        changes: [
          { field: 'ott_id', before: e.ott_id, after: r.ott_id },
          { field: 'ott_status', before: e.ott_status, after: status },
        ],
      });
    }
  });
  run();

  // ── Fallback: TNRS for the local residual only. Local always wins. ──
  // `residual` was collected during the local pass above — resolving every
  // entity a second time to find it would double the work over ~196K rows.
  // Rows already carrying ott_status='resolved_tnrs' never entered `residual`
  // (guarded above), but filter defensively too so a re-run never re-sends
  // an already-resolved name over the network even if that invariant drifts.
  const noNetwork = process.argv.includes('--no-network');
  const toResolve = residual.filter(e => e.ott_status !== 'resolved_tnrs');
  if (!noNetwork && toResolve.length) {
    console.log(`\nTNRS fallback for ${toResolve.length} unmatched names…`);
    const upd2 = db.prepare('UPDATE entities SET ott_id = ?, ott_status = ? WHERE id = ?');

    // Adaptive rate limit mirroring sync-gbif.js: start small, double on
    // 429/503 (capped), decay slowly back down after a clean batch.
    const INITIAL_DELAY_MS = 100;
    const MAX_DELAY_MS = 5000;
    let delayMs = INITIAL_DELAY_MS;
    let failedBatches = 0;

    for (const [ctx, group] of groupByContext(toResolve)) {
      for (let i = 0; i < group.length; i += 200) {
        const chunk = group.slice(i, i + 200);
        const names = chunk.map(e => e.scientific_name);
        const label = `context=${ctx}, offset=${i}`;

        // A single failed batch (transient 429/503, network error, bad JSON)
        // must not abort the ~138-batch run. Try once; on a rate-limit
        // response, back off and retry the SAME batch once more; any other
        // failure, or a second failure after retry, gives up on this batch
        // only — its names stay 'unmatched', which is the correct fallback.
        let hits = new Map();
        try {
          hits = await matchNames(names, ctx);
        } catch (err) {
          const httpCode = Number((/HTTP (\d+)/.exec(err.message) || [])[1]);
          console.error(`TNRS batch failed (${label}): ${err.message}`);
          if (httpCode === 429 || httpCode === 503) {
            delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
            console.error(`  rate-limited — backing off to ${delayMs}ms and retrying once…`);
            await new Promise(r => setTimeout(r, delayMs));
            try {
              hits = await matchNames(names, ctx);
            } catch (err2) {
              console.error(`TNRS batch failed again (${label}), giving up on this batch: ${err2.message}`);
              failedBatches++;
            }
          } else {
            failedBatches++;
          }
        }

        for (const e of chunk) {
          const id = hits.get(e.scientific_name);
          if (id == null) continue;

          // Pinning context by kingdom (groupByContext, above) is required for
          // recall, but it also means TNRS can hand back a confident homonym
          // with NO ambiguity signal — the local pass's multi-candidate
          // abstention has no equivalent here. Validate what came back
          // against the curated hint before trusting it; this is the
          // disambiguate-or-abstain check for the network path.
          const hint = curatedKingdomHint(e.scientific_name);
          const kingdom = hint ? kingdomOf(ottDb, id) : null;
          const verdict = validateTnrsMatch({ ottId: id, kingdom, curatedHint: hint });
          const status = verdict.reason;
          const writeId = verdict.ott_id;

          // Mirrors the local pass's no-op guard: don't rewrite a row that
          // already holds this exact value.
          if (e.ott_id === writeId && e.ott_status === status) continue;
          tally.unmatched--; tally[status] = (tally[status] || 0) + 1;
          if (apply) {
            upd2.run(writeId, status, e.id);
            logRevisions(db, {
              targetType: 'entity', targetId: e.id, changedBy: 'ott-resolve',
              method: 'resolve_entities_to_ott_tnrs',
              reason: status === 'hint_contradiction'
                ? `TNRS fallback returned a taxon whose kingdom contradicts the curated hint (context=${ctx}) — abstained`
                : `TNRS fallback resolution (context=${ctx})`,
              changes: [
                { field: 'ott_id', before: e.ott_id, after: writeId },
                { field: 'ott_status', before: e.ott_status, after: status },
              ],
            });
          }
        }

        if (delayMs > INITIAL_DELAY_MS) {
          delayMs = Math.max(INITIAL_DELAY_MS, Math.floor(delayMs * 0.9));
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    if (failedBatches) {
      console.log(`\nTNRS: ${failedBatches} batch(es) failed and were skipped; their names remain unmatched.`);
    }
  } else if (noNetwork) {
    console.log('\n--no-network: TNRS fallback skipped; residual stays unmatched.');
  }

  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}  (${(v * 100 / entities.length).toFixed(1)}%)`);
  }
  if (!apply) console.log('\nDry run. Re-run with --apply.');
  db.close(); ottDb.close();
})().catch(e => { console.error(e); process.exit(1); });
