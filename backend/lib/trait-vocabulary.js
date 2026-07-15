'use strict';

const { validateTraitValue } = require('./trait-value');
const { canonicalizeCategorical } = require('./trait-canonicalize');

/**
 * Loads traits_vocabulary into an in-memory map keyed by trait_name,
 * with JSON columns parsed. Renders the prompt-embed markdown table
 * that extract-source.js substitutes into extractor.md.
 */

async function loadVocabulary(db) {
  const rows = await db.all(`SELECT * FROM traits_vocabulary`);
  const out = {};
  for (const r of rows) {
    out[r.trait_name] = {
      trait_name: r.trait_name,
      value_kind: r.value_kind,
      expected_unit: r.expected_unit,
      applicable_bio_categories: JSON.parse(r.applicable_bio_categories),
      enum_values: r.enum_values ? JSON.parse(r.enum_values) : null,
      description: r.description,
      upstream_mappings: r.upstream_mappings ? JSON.parse(r.upstream_mappings) : {},
    };
  }
  return out;
}

function renderVocabularyMarkdown(vocab) {
  const lines = [];
  lines.push('| trait_name | value_kind | expected_unit | applicable_bio_categories | enum_values | description |');
  lines.push('|---|---|---|---|---|---|');
  for (const t of Object.values(vocab).sort((a, b) => a.trait_name.localeCompare(b.trait_name))) {
    lines.push([
      '|', t.trait_name,
      '|', t.value_kind,
      '|', t.expected_unit ?? '',
      '|', JSON.stringify(t.applicable_bio_categories),
      '|', t.enum_values ? JSON.stringify(t.enum_values) : '',
      '|', t.description, '|',
    ].join(' '));
  }
  return lines.join('\n');
}

function validateClaimAgainstVocab(vocab, claim) {
  const v = vocab[claim.trait_name];
  if (!v) return { ok: false, error: `unknown trait_name: ${claim.trait_name}` };
  if (v.expected_unit && claim.unit && claim.unit !== v.expected_unit) {
    return { ok: false, error: `${claim.trait_name}: unit '${claim.unit}' != expected '${v.expected_unit}'` };
  }
  // pick the value to validate based on which value_* field is filled
  let raw;
  if (v.value_kind === 'numeric') raw = claim.value_numeric;
  else if (v.value_kind === 'categorical' || v.value_kind === 'boolean') {
    raw = claim.value_text;
    if (v.value_kind === 'categorical' && v.enum_values && !v.enum_values.includes(raw)) {
      const canonical = canonicalizeCategorical(v, raw);
      if (v.enum_values.includes(canonical)) {
        claim.value_text = canonical;
        raw = canonical;
      }
    }
  }
  else {
    // range/list: payload may carry value_json as a native array/object (in-memory,
    // direct from extractor) OR a stringified JSON (post-storage round-trip).
    // Handle both shapes.
    const vj = claim.value_json;
    if (vj == null) raw = vj;
    else if (typeof vj === 'string') { try { raw = JSON.parse(vj); } catch { raw = vj; } }
    else raw = vj;
  }
  const r = validateTraitValue(v, raw);
  return r;
}

module.exports = { loadVocabulary, renderVocabularyMarkdown, validateClaimAgainstVocab };
