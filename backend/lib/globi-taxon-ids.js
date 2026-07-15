'use strict';

function tokens(idsString) {
  if (!idsString) return [];
  return String(idsString).split(/[|;]/).map(t => t.trim()).filter(Boolean);
}

function parseGbifKey(idsString) {
  for (const tok of tokens(idsString)) {
    const m = /^gbif:(\d+)$/i.exec(tok);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function parseTaxonIds(idsString) {
  const out = { gbif: null, ncbi: null, col: null, itis: null, eol: null, wd: null };
  for (const tok of tokens(idsString)) {
    const m = /^([a-z]+):(.+)$/i.exec(tok);
    if (!m) continue;
    const prefix = m[1].toLowerCase();
    const val = m[2].trim();
    if (prefix === 'gbif') out.gbif = /^\d+$/.test(val) ? parseInt(val, 10) : out.gbif;
    else if (prefix in out) out[prefix] = val;
  }
  return out;
}

module.exports = { parseGbifKey, parseTaxonIds };
