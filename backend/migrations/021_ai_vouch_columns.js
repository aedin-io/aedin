'use strict';

/**
 * Adds AI-vouching columns to extraction_staging.
 *
 * Each row in extraction_staging now carries a separate AI-vouch verdict
 * (orthogonal to the existing review_status which is for human review).
 *
 *   ai_vouch_status  — 'pending' | 'plausible' | 'implausible' | 'uncertain'
 *   ai_vouch_note    — free-text reasoning from the vouching agent
 *   ai_vouched_by    — agent name (e.g. 'extractor-vouch', 'agroecologist')
 *   ai_vouched_at    — timestamp
 *
 * The intent: vouch-staged-claims.js dispatches Claude on each pending row,
 * captures verdict + reasoning, and the human-review UI later combines AI vouch
 * with human verdict for tier promotion.
 */
async function runMigration(db) {
  const cols = await db.all('PRAGMA table_info(extraction_staging)');
  const existing = new Set(cols.map(c => c.name));

  const newCols = [
    ['ai_vouch_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['ai_vouch_note',   'TEXT'],
    ['ai_vouched_by',   'TEXT'],
    ['ai_vouched_at',   'TEXT'],
  ];

  let added = 0;
  for (const [name, type] of newCols) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE extraction_staging ADD COLUMN ${name} ${type}`);
      added++;
    }
  }

  // Index for fast "find pending vouches" queries
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_staging_ai_vouch ON extraction_staging(ai_vouch_status)`);

  console.log(`[migration-021] ai_vouch_* columns: ${added} added (others pre-existing). Index ready.`);
}

module.exports = { runMigration };
