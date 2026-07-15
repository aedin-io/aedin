'use strict';

const { levenshtein } = require('./levenshtein');
const { normalizeVarietyName } = require('./variety-normalize');

const FUZZY_MAX_DISTANCE = 2;      // Levenshtein cap for fuzzy_verified
const FUZZY_MAX_LENGTH_RATIO = 0.20; // distance / max(len) must be <= this

/** Normalize for comparison: variety-normalize (quotes/trademarks/space) + lowercase. */
function norm(s) {
  return normalizeVarietyName(s || '').toLowerCase();
}

/** Split a delimited synonym list into normalized non-empty tokens. */
function synonymList(raw) {
  if (!raw) return [];
  return String(raw).split(/[;|]/).map(s => norm(s)).filter(Boolean);
}

/**
 * Resolve a free-text organism/crop name against a pre-filtered slice of the
 * entities table. The caller is responsible for blocking (genus token or
 * first-letter bucket) so this never scans all 194K rows.
 *
 * @param {string} name
 * @param {{ entities: Array<{id,scientific_name,common_name,synonyms}> }} opts
 * @returns {{status:'verified'|'fuzzy_verified'|'unverified',
 *            entity_id:number|null, matched_on:string|null,
 *            distance:number, candidate_id:number|null}}
 */
function resolveEntity(name, { entities }) {
  const target = norm(name);
  const miss = { status: 'unverified', entity_id: null, matched_on: null, distance: Infinity, candidate_id: null };
  if (!target) return miss;

  let best = null; // { id, matched_on, distance, valueLen }

  for (const e of entities) {
    const cols = [
      ['scientific_name', norm(e.scientific_name)],
      ['common_name', norm(e.common_name)],
      ...synonymList(e.synonyms).map(s => ['synonym', s]),
    ];
    for (const [matched_on, value] of cols) {
      if (!value) continue;
      if (value === target) {
        return { status: 'verified', entity_id: e.id, matched_on, distance: 0, candidate_id: e.id };
      }
      const d = levenshtein(target, value, FUZZY_MAX_DISTANCE + 1);
      if (best === null || d < best.distance) {
        best = { id: e.id, matched_on, distance: d, valueLen: value.length };
      }
    }
  }

  if (best === null) return miss;

  // Denominator is the longer of the two strings (canonical edit-distance
  // normalization) so a short input can't sneak past on a low absolute distance.
  const maxLen = Math.max(target.length, best.valueLen, 1);
  const ratio = best.distance / maxLen;
  if (best.distance <= FUZZY_MAX_DISTANCE && ratio <= FUZZY_MAX_LENGTH_RATIO) {
    return { status: 'fuzzy_verified', entity_id: best.id, matched_on: best.matched_on, distance: best.distance, candidate_id: best.id };
  }
  return { status: 'unverified', entity_id: null, matched_on: null, distance: best.distance, candidate_id: best.id };
}

module.exports = { resolveEntity, FUZZY_MAX_DISTANCE, FUZZY_MAX_LENGTH_RATIO };
