'use strict';
const path = require('path');
const fs = require('fs');

/**
 * Resolve which SQLite file the web BUILD reads.
 *
 * - Default (dev, plain `npm run build`): the live curated DB
 *   `backend/aedin.sqlite` (entities/claims/sources/…). NOT the raw 44 GB
 *   `globi.sqlite` GloBI download — the web build never reads that.
 * - Deploy (`AEDIN_USE_PUBLISHED=1`, set by `npm run deploy`): a frozen
 *   snapshot `backend/aedin-published.sqlite` produced by `npm run freeze-db`.
 *
 * The frozen snapshot decouples a code deploy from whatever in-progress edits
 * sit in the live DB (e.g. a concurrent ingestion session). We hard-error when
 * the snapshot is missing so a deploy can never *silently* fall back to the
 * live working state — that fallback is exactly the contamination we're
 * preventing.
 *
 * `AEDIN_DB_PATH` overrides the snapshot path explicitly (tests / CI).
 */
function resolveBuildDbPath() {
  const root = path.join(__dirname, '..', '..', '..'); // web/scripts/lib -> repo root
  const live = path.join(root, 'backend', 'aedin.sqlite');
  if (process.env.AEDIN_USE_PUBLISHED !== '1') return live;
  const snap = process.env.AEDIN_DB_PATH || path.join(root, 'backend', 'aedin-published.sqlite');
  if (!fs.existsSync(snap)) {
    throw new Error(
      `[build] AEDIN_USE_PUBLISHED=1 but no published snapshot at ${snap}.\n` +
        'Run `npm run freeze-db` after your D1 data publish, then deploy.',
    );
  }
  return snap;
}

module.exports = { resolveBuildDbPath };
