/**
 * region-scopes — re-exports the canonical region vocabulary DATA from
 * backend/lib/region-vocab.json (the single source of truth, also consumed by the
 * backend gate via region-vocab.js). JSON is the shared format because Vite bundles
 * .json natively into the edge worker, whereas it will NOT CommonJS-transform a
 * cross-root source .js. Worker-safe: pure data, no fs / node deps.
 *
 * Web only needs the data maps (SCOPE_COUNTRIES for the GloBI ?scope= rollup,
 * CANONICAL_SCOPES for the atlas build). The derived scopesForCountry() lives only in
 * the backend region-vocab.js (the atlas build now reads scopes[] off normalizeRegion).
 */
// `with { type: 'json' }` is required by Node's ESM loader (this file is imported
// under plain Node by build-atlas-data.js + the test runner) and is accepted by Vite
// for the worker bundle. Bare JSON import works in Vite but throws in Node.
import vocab from '../../../backend/lib/region-vocab.json' with { type: 'json' };

export const SCOPE_COUNTRIES = vocab.SCOPE_COUNTRIES;
export const CANONICAL_SCOPES = vocab.CANONICAL_SCOPES;
export const COARSE_REGION_TO_SCOPES = vocab.COARSE_REGION_TO_SCOPES;
