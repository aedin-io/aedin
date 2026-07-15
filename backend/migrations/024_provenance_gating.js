'use strict';

/**
 * Migration 024: Provenance gating (Phase 2)
 *
 * Implements the schema half of Phase 2 from docs/phased-roadmap.md:
 * "make every consumer-facing claim cite a verbatim source quote."
 *
 * Two surfaces touched:
 *
 * 1) `claims` gains a review-state machine:
 *      review_status ∈ {unreviewed, ai_vouched, human_verified, edited, disputed, superseded}
 *      reviewer_id     — handle/email of the reviewer who last touched the row (NULL until reviewed)
 *      reviewed_at     — ISO-8601 timestamp of that review (NULL until reviewed)
 *      superseded_by   — id of the newer claim that replaced this one (NULL by default;
 *                        used when an extractor re-run or human edit produces a corrected claim
 *                        and we want to keep the original for audit)
 *
 *    Default for existing rows: 'unreviewed'. This is intentional — GloBI-derived claims
 *    (~6.7M rows) are demoted to "candidate generator" per the roadmap's locked-in
 *    decision, and must flow through the vouch + human-review pipeline before being
 *    served. The serving-layer gate (Phase 2 step 2) will filter on review_status.
 *
 * 2) `sources` gains two columns Phase 5a's MCP server will need for license-aware
 *    redistribution:
 *      isbn    — for books (DOI is for journal articles; books ingested from PDFs need ISBN)
 *      license — redistribution terms ('CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0', 'public_domain',
 *                'copyrighted', 'unknown', etc.). Distinct from existing `access_level`,
 *                which is about reach (open vs paywalled), not redistribution rights.
 *                Phase 5a's serving layer will only emit verbatim quotes when the license
 *                permits redistribution; otherwise it surfaces paraphrase + citation.
 *
 * No data is rewritten. This is purely additive.
 */
async function runMigration(db) {
  // ── claims: review-state machine ──────────────────────────────────────────
  const claimsCols = await db.all('PRAGMA table_info(claims)');
  const claimsExisting = new Set(claimsCols.map(c => c.name));

  const claimsAdditions = [
    ['review_status', "TEXT NOT NULL DEFAULT 'unreviewed'"],
    ['reviewer_id',   'TEXT'],
    ['reviewed_at',   'TEXT'],
    ['superseded_by', 'INTEGER REFERENCES claims(id)'],
  ];

  let claimsAdded = 0;
  for (const [name, type] of claimsAdditions) {
    if (!claimsExisting.has(name)) {
      await db.exec(`ALTER TABLE claims ADD COLUMN ${name} ${type}`);
      claimsAdded++;
    }
  }

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_review_status ON claims(review_status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_superseded_by ON claims(superseded_by)`);

  // ── sources: license + isbn ────────────────────────────────────────────────
  const sourcesCols = await db.all('PRAGMA table_info(sources)');
  const sourcesExisting = new Set(sourcesCols.map(c => c.name));

  const sourcesAdditions = [
    ['isbn',    'TEXT'],
    ['license', 'TEXT'],
  ];

  let sourcesAdded = 0;
  for (const [name, type] of sourcesAdditions) {
    if (!sourcesExisting.has(name)) {
      await db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
      sourcesAdded++;
    }
  }

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_license ON sources(license)`);

  console.log(
    `[migration-024] claims: +${claimsAdded} review-state cols; ` +
    `sources: +${sourcesAdded} license/isbn cols. Indexes ready.`
  );
}

module.exports = { runMigration };
