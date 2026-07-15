'use strict';
/**
 * ingest-checkpoint.js — the resume pointer for overnight ingestion.
 *
 * Pure decision over (manifest, lock, ingested-id set) → the next acquired-but-
 * un-ingested source. Because "next unit" is always recomputed from durable
 * state (the lock + the sources table), a token-window reset mid-run is safe:
 * the next firing recomputes and continues from where it left off.
 */
function nextUnit({ manifestEntries, lock, ingestedIds }) {
  for (const e of manifestEntries) {
    const acquired = lock[e.id] && lock[e.id].sha256;
    if (acquired && !ingestedIds.has(e.id)) return { kind: 'extract', entry: e };
  }
  return { kind: 'none' };
}

module.exports = { nextUnit };
