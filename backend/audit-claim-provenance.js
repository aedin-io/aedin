'use strict';

/**
 * Phase 2 step 3 — Provenance backfill audit.
 *
 * Reads `claims` and reports what fraction of rows carry the verbatim-citation
 * fields the Phase 2 serving-layer gate will require:
 *
 *   - source_quote          (verbatim text from the source)
 *   - source_page            (page number; for journal articles, may be page range)
 *   - reference_citation     (free-text citation string; legacy GloBI field)
 *   - source_id              (FK into sources table — provenance via lookup)
 *
 * Breaks the report down by `data_tier` (tier1_paper > tier2_globi > tier3_user)
 * and by `review_status` (the new column added in migration 024). The serving-layer
 * gate planned for Phase 2 step 2 is approximately:
 *
 *   review_status IN ('ai_vouched','human_verified','edited')
 *   AND source_quote IS NOT NULL
 *
 * This script reports both halves so the gap is explicit.
 *
 * Read-only. Run any time to re-measure. No DB writes.
 *
 * Usage:
 *   node audit-claim-provenance.js
 *   node audit-claim-provenance.js --json    # machine-readable output
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = CORPUS_DB;

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');

function pct(n, total) {
  if (!total) return '0.0%';
  return ((n / total) * 100).toFixed(1) + '%';
}

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // 1. Overall coverage
  const overall = await db.get(`
    SELECT
      COUNT(*)                                                                      AS total,
      SUM(CASE WHEN source_quote IS NOT NULL AND source_quote != ''         THEN 1 ELSE 0 END) AS with_quote,
      SUM(CASE WHEN source_page IS NOT NULL                                  THEN 1 ELSE 0 END) AS with_page,
      SUM(CASE WHEN reference_citation IS NOT NULL AND reference_citation != '' THEN 1 ELSE 0 END) AS with_cite,
      SUM(CASE WHEN source_id IS NOT NULL                                    THEN 1 ELSE 0 END) AS with_source_id
    FROM claims
  `);

  // 2. Coverage broken down by data_tier
  const byTier = await db.all(`
    SELECT
      data_tier,
      COUNT(*)                                                                      AS total,
      SUM(CASE WHEN source_quote IS NOT NULL AND source_quote != ''         THEN 1 ELSE 0 END) AS with_quote,
      SUM(CASE WHEN source_page IS NOT NULL                                  THEN 1 ELSE 0 END) AS with_page,
      SUM(CASE WHEN reference_citation IS NOT NULL AND reference_citation != '' THEN 1 ELSE 0 END) AS with_cite,
      SUM(CASE WHEN source_id IS NOT NULL                                    THEN 1 ELSE 0 END) AS with_source_id
    FROM claims
    GROUP BY data_tier
    ORDER BY total DESC
  `);

  // 3. Review-status distribution (new column from migration 024)
  const byReview = await db.all(`
    SELECT
      review_status,
      COUNT(*)                                                                      AS total,
      SUM(CASE WHEN source_quote IS NOT NULL AND source_quote != ''         THEN 1 ELSE 0 END) AS with_quote
    FROM claims
    GROUP BY review_status
    ORDER BY total DESC
  `);

  // 4. Implied serving-layer gate: how many claims would pass the Phase 2
  //    consumer-API filter today?
  const gateEligible = await db.get(`
    SELECT COUNT(*) AS eligible
    FROM claims
    WHERE review_status IN ('ai_vouched', 'human_verified', 'edited')
      AND source_quote IS NOT NULL
      AND source_quote != ''
  `);

  // 5. Sources table: how many entries, how many have license set?
  const sourcesAudit = await db.get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN license IS NOT NULL AND license != '' THEN 1 ELSE 0 END) AS with_license,
      SUM(CASE WHEN doi IS NOT NULL AND doi != ''         THEN 1 ELSE 0 END) AS with_doi,
      SUM(CASE WHEN isbn IS NOT NULL AND isbn != ''       THEN 1 ELSE 0 END) AS with_isbn,
      SUM(CASE WHEN url IS NOT NULL AND url != ''         THEN 1 ELSE 0 END) AS with_url
    FROM sources
  `);

  // 6. Bridge to extraction_staging — how many staged claims are ai_vouched and
  //    therefore candidates to lift into live claims as 'ai_vouched'?
  const stagingBridge = await db.get(`
    SELECT
      COUNT(*) AS total_staged,
      SUM(CASE WHEN ai_vouch_status = 'plausible'   THEN 1 ELSE 0 END) AS plausible,
      SUM(CASE WHEN ai_vouch_status = 'implausible' THEN 1 ELSE 0 END) AS implausible,
      SUM(CASE WHEN ai_vouch_status = 'uncertain'   THEN 1 ELSE 0 END) AS uncertain,
      SUM(CASE WHEN ai_vouch_status = 'pending'     THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN ai_vouch_status = 'out_of_scope' THEN 1 ELSE 0 END) AS out_of_scope
    FROM extraction_staging
  `);

  await db.close();

  const report = {
    generated_at: new Date().toISOString(),
    overall,
    by_tier: byTier,
    by_review_status: byReview,
    serving_layer_gate: {
      eligible_today: gateEligible.eligible,
      total_claims: overall.total,
      eligible_pct: pct(gateEligible.eligible, overall.total),
      gate_filter: "review_status IN ('ai_vouched','human_verified','edited') AND source_quote IS NOT NULL",
    },
    sources_table: sourcesAudit,
    staging_bridge: stagingBridge,
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('═══ Phase 2 — Provenance Backfill Audit ═══');
  console.log(`Generated: ${report.generated_at}\n`);

  console.log('── Overall claims provenance ──');
  console.log(`  total claims:          ${overall.total.toLocaleString()}`);
  console.log(`  with source_quote:     ${overall.with_quote.toLocaleString()}  (${pct(overall.with_quote, overall.total)})`);
  console.log(`  with source_page:      ${overall.with_page.toLocaleString()}  (${pct(overall.with_page, overall.total)})`);
  console.log(`  with reference_cite:   ${overall.with_cite.toLocaleString()}  (${pct(overall.with_cite, overall.total)})`);
  console.log(`  with source_id (FK):   ${overall.with_source_id.toLocaleString()}  (${pct(overall.with_source_id, overall.total)})\n`);

  console.log('── Coverage by data_tier ──');
  for (const t of byTier) {
    console.log(`  ${t.data_tier} (${t.total.toLocaleString()} rows):`);
    console.log(`    quote: ${pct(t.with_quote, t.total)}  page: ${pct(t.with_page, t.total)}  cite: ${pct(t.with_cite, t.total)}  source_id: ${pct(t.with_source_id, t.total)}`);
  }
  console.log();

  console.log('── Review-status distribution ──');
  for (const r of byReview) {
    console.log(`  ${r.review_status}: ${r.total.toLocaleString()} rows  (with quote: ${r.with_quote.toLocaleString()})`);
  }
  console.log();

  console.log('── Serving-layer gate impact ──');
  console.log(`  Filter:  ${report.serving_layer_gate.gate_filter}`);
  console.log(`  Eligible today:  ${gateEligible.eligible.toLocaleString()} / ${overall.total.toLocaleString()}  (${report.serving_layer_gate.eligible_pct})`);
  console.log();

  console.log('── Sources table audit ──');
  console.log(`  total sources: ${sourcesAudit.total}`);
  console.log(`  with license:  ${sourcesAudit.with_license}  (${pct(sourcesAudit.with_license, sourcesAudit.total)})  ← Phase 5a redistribution gate`);
  console.log(`  with DOI:      ${sourcesAudit.with_doi}  (${pct(sourcesAudit.with_doi, sourcesAudit.total)})`);
  console.log(`  with ISBN:     ${sourcesAudit.with_isbn}  (${pct(sourcesAudit.with_isbn, sourcesAudit.total)})`);
  console.log(`  with URL:      ${sourcesAudit.with_url}  (${pct(sourcesAudit.with_url, sourcesAudit.total)})`);
  console.log();

  console.log('── Staging bridge (extraction_staging) ──');
  console.log(`  total staged claims:  ${stagingBridge.total_staged}`);
  console.log(`    plausible:    ${stagingBridge.plausible}   ← candidates to lift into claims as ai_vouched`);
  console.log(`    implausible:  ${stagingBridge.implausible}`);
  console.log(`    uncertain:    ${stagingBridge.uncertain}`);
  console.log(`    out_of_scope: ${stagingBridge.out_of_scope}`);
  console.log(`    pending:      ${stagingBridge.pending}`);
  console.log();

  console.log('── Phase 2 implications ──');
  if (gateEligible.eligible === 0) {
    console.log('  • 0 claims pass the serving-layer gate today.');
    console.log('    Next: build the staging→claims bridge so ai_vouched plausible rows become servable.');
  } else if (gateEligible.eligible < 100) {
    console.log(`  • Only ${gateEligible.eligible} claims pass the gate. Phase 5a launch needs more volume.`);
  } else {
    console.log(`  • ${gateEligible.eligible.toLocaleString()} claims would be servable through the Phase 5a MCP server.`);
  }

  if (sourcesAudit.with_license === 0 && sourcesAudit.total > 0) {
    console.log('  • 0 sources have license set — Phase 5a redistribution layer cannot decide quote-vs-paraphrase yet.');
    console.log('    Next: backfill `license` on the existing sources rows.');
  }
})().catch(err => {
  console.error('audit-claim-provenance failed:', err);
  process.exit(1);
});
