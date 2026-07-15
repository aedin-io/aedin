'use strict';
/**
 * region-normalize (canonical, CommonJS). Parses a free-text regional_context into
 * { scopes, country, subdivision, raw }. Source of truth for the region vocabulary;
 * web/scripts/region-normalize.js re-exports from here so the atlas build and the
 * backend gate/drop scripts cannot drift. See docs/promoted-localities.md.
 */
const fs = require('fs');
const path = require('path');

const regionsJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'regions.json'), 'utf8'));

const { CANONICAL_SCOPES, COARSE_REGION_TO_SCOPES, scopesForCountry, GLOBAL } = require('./region-vocab');

const CANONICAL_SET = new Set(CANONICAL_SCOPES);
// Every recognized supranational string (canonical + coarse + Global). Used by the gate
// so a coarse/Global value still counts as "located" even when it maps to no country.
const RECOGNIZED_SUPRANATIONAL = new Set([
  ...CANONICAL_SCOPES, ...Object.keys(COARSE_REGION_TO_SCOPES), GLOBAL,
]);

const SUBDIVISION_OVERRIDES = {
  Hawaii:                     { country: 'Hawaii',                   subdivision: null },
  Guam:                       { country: 'Guam',                     subdivision: null },
  'American Samoa':           { country: 'American Samoa',           subdivision: null },
  'Northern Mariana Islands': { country: 'Northern Mariana Islands', subdivision: null },
  California:  { country: 'United States', subdivision: 'California' },
  Texas:       { country: 'United States', subdivision: 'Texas' },
  Florida:     { country: 'United States', subdivision: 'Florida' },
  Michigan:    { country: 'United States', subdivision: 'Michigan' },
  Washington:  { country: 'United States', subdivision: 'Washington' },
  'New Jersey':{ country: 'United States', subdivision: 'New Jersey' },
  Colorado:    { country: 'United States', subdivision: 'Colorado' },
  Georgia:     { country: 'United States', subdivision: 'Georgia' },
  England:     { country: 'United Kingdom', subdivision: 'England' },
};

const countriesLower = new Map();
for (const name of Object.keys(regionsJson)) countriesLower.set(name.toLowerCase(), name);

const subdivisionToCountry = new Map();
for (const [country, data] of Object.entries(regionsJson)) {
  for (const sub of data.subdivisions || []) {
    const key = sub.name.toLowerCase();
    if (!subdivisionToCountry.has(key)) subdivisionToCountry.set(key, { country, subdivision: sub.name });
  }
}

function normalizeRegion(raw) {
  // Fresh object per early-exit — never share a mutable result (the scopes[] array
  // could be mutated by a caller and corrupt every subsequent empty return).
  if (!raw) return { scopes: [], country: null, subdivision: null, raw: null };
  const trimmed = String(raw).trim();
  if (!trimmed) return { scopes: [], country: null, subdivision: null, raw: null };
  if (CANONICAL_SET.has(trimmed)) return { scopes: [trimmed], country: null, subdivision: null, raw: trimmed };
  if (COARSE_REGION_TO_SCOPES[trimmed]) return { scopes: [...COARSE_REGION_TO_SCOPES[trimmed]], country: null, subdivision: null, raw: trimmed };
  if (trimmed === GLOBAL) return { scopes: [], country: null, subdivision: null, raw: trimmed }; // recognized, filter-inert
  if (SUBDIVISION_OVERRIDES[trimmed]) {
    const o = SUBDIVISION_OVERRIDES[trimmed];
    return { scopes: scopesForCountry(o.country), country: o.country, subdivision: o.subdivision, raw: trimmed };
  }
  const countryHit = countriesLower.get(trimmed.toLowerCase());
  if (countryHit) return { scopes: scopesForCountry(countryHit), country: countryHit, subdivision: null, raw: trimmed };
  const subHit = subdivisionToCountry.get(trimmed.toLowerCase());
  if (subHit) return { scopes: scopesForCountry(subHit.country), country: subHit.country, subdivision: subHit.subdivision, raw: trimmed };
  return { scopes: [], country: null, subdivision: null, raw: trimmed };
}

function getRegionsJson() { return regionsJson; }

// Boolean gate: does this free-text region resolve to AT LEAST ONE locality
// (scope or country)? Splits multi-region strings on comma / " and " / slash so
// "United States, Australia" and "India and east Africa" count as located.
function hasResolvableLocality(raw) {
  if (!raw) return false;
  const parts = String(raw).split(/\s*(?:,|\/|\band\b)\s*/i).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const r = normalizeRegion(part);
    if (r.scopes.length || r.country || r.subdivision) return true;
    // Only 'Global' reaches here — it's recognized but deliberately scope-less, so the
    // line above can't catch it. (Canonical/coarse values already returned true above.)
    if (RECOGNIZED_SUPRANATIONAL.has(part)) return true;
  }
  return false;
}

module.exports = { normalizeRegion, getRegionsJson, hasResolvableLocality, RECOGNIZED_SUPRANATIONAL, SUBDIVISION_OVERRIDES };
