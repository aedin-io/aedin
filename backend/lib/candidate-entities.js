'use strict';

const { resolveEntity } = require('./entity-resolver');

const BINOMIAL_RE = /\b[A-Z][a-z]+ [a-z]{3,}\b/g;

/** Distinct candidate binomials found in a chunk of text, in first-seen order. */
function extractBinomials(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text || '').matchAll(BINOMIAL_RE)) {
    const name = m[0];
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/** Genus-blocked slice for one candidate name. */
function sliceFor(name, entities) {
  const genus = name.split(/\s+/)[0].toLowerCase();
  return entities.filter(e => (e.genus || '').toLowerCase() === genus
    || (e.scientific_name || '').toLowerCase().startsWith(genus + ' '));
}

/**
 * Build the `## Candidate entities seen near this corpus` markdown block:
 * up to `limit` resolved candidates, each `scientific · common · bio · role`.
 * Returns '' when nothing resolves (extractor then sees an empty section).
 */
function renderCandidateBlock(text, entities, limit = 15) {
  const lines = [];
  const seenIds = new Set();
  for (const name of extractBinomials(text)) {
    const r = resolveEntity(name, { entities: sliceFor(name, entities) });
    if (r.status === 'unverified' || r.entity_id == null || seenIds.has(r.entity_id)) continue;
    seenIds.add(r.entity_id);
    const e = entities.find(x => x.id === r.entity_id);
    lines.push(`- ${e.scientific_name} · ${e.common_name || '—'} · ${e.bio_category || '—'} · ${e.primary_role || '—'}`);
    if (lines.length >= limit) break;
  }
  if (lines.length === 0) return '';
  return `## Candidate entities seen near this corpus\n${lines.join('\n')}\n`;
}

module.exports = { extractBinomials, renderCandidateBlock };
