'use strict';
const { levenshtein } = require('./levenshtein');

const DIST_CAP = 2;
const RATIO_CAP = 0.20;

function normalizeVarietyName(raw) {
  return String(raw || '').trim().replace(/[™®]/g, '').replace(/'/g, '’');
}

function completenessOk(row) {
  const v = row && row.maturity_days;
  return v != null && v !== '' && Number.isFinite(Number(v));
}

// existing: [{id, variety_name}] already under the parent. normName: normalized incoming name.
function dedupDecision(existing, normName) {
  const lower = normName.toLowerCase();
  for (const e of existing) {
    if ((e.variety_name || '').toLowerCase() === lower) return { action: 'update', targetId: e.id };
  }
  for (const e of existing) {
    const en = (e.variety_name || '').toLowerCase();
    const dist = levenshtein(en, lower, DIST_CAP);
    if (dist > DIST_CAP) continue;                        // levenshtein returns cap+1 (sentinel) when over the cap
    const ratio = dist / Math.max(en.length, lower.length, 1);
    if (ratio <= RATIO_CAP) return { action: 'create-flag', targetId: e.id };
  }
  return { action: 'create' };
}

module.exports = { normalizeVarietyName, completenessOk, dedupDecision };
