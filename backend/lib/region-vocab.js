'use strict';
/**
 * region-vocab — the single, fs-free source of truth for AgroEco's region vocabulary.
 * The DATA (canonical scopes, pruned scope→country rollup, coarse→parent map) lives in
 * the sibling region-vocab.json so BOTH this CJS module (Node: backend gate + atlas build)
 * AND web/src/lib/region-scopes.js (Vite worker bundle) can read it natively — Vite does
 * not CommonJS-transform cross-root source .js files, but it bundles .json natively. This
 * module adds the derived `scopesForCountry` inverse + the `GLOBAL` sentinel.
 * MUST stay fs-free / node-dep-free (it is bundled into the edge worker via the JSON).
 */

const { CANONICAL_SCOPES, SCOPE_COUNTRIES, COARSE_REGION_TO_SCOPES } = require('./region-vocab.json');

// 'Global' is recognized (passes the promotion gate) but maps to NO canonical scope —
// it is filter-inert (an "everywhere" claim that no specific region filter selects).
const GLOBAL = 'Global';

const _inverse = new Map();
for (const [scope, countries] of Object.entries(SCOPE_COUNTRIES)) {
  for (const c of countries) {
    if (!_inverse.has(c)) _inverse.set(c, []);
    if (!_inverse.get(c).includes(scope)) _inverse.get(c).push(scope);
  }
}
// Returns a fresh array (callers may keep/mutate the result; never hand out the live _inverse value).
function scopesForCountry(country) { return [...(_inverse.get(country) || [])]; }

module.exports = { CANONICAL_SCOPES, SCOPE_COUNTRIES, COARSE_REGION_TO_SCOPES, scopesForCountry, GLOBAL };
