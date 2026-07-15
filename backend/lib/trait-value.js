'use strict';

/**
 * Encode/decode/validate trait values per traits_vocabulary.value_kind.
 *
 * Storage shape on entity_trait_claims: three nullable columns
 * (value_numeric, value_text, value_json). Exactly one is non-null,
 * picked by value_kind:
 *   numeric     → value_numeric
 *   categorical → value_text
 *   boolean     → value_text ('true' | 'false')
 *   range       → value_json '{"min":<num>,"max":<num>}'
 *   list        → value_json '<JSON array>'
 */

function encodeTraitValue(vocab, value) {
  const kind = vocab.value_kind;
  if (kind === 'numeric') {
    return { value_numeric: Number(value), value_text: null, value_json: null };
  }
  if (kind === 'categorical') {
    return { value_numeric: null, value_text: String(value), value_json: null };
  }
  if (kind === 'boolean') {
    return { value_numeric: null, value_text: value ? 'true' : 'false', value_json: null };
  }
  if (kind === 'range') {
    return { value_numeric: null, value_text: null, value_json: JSON.stringify(value) };
  }
  if (kind === 'list') {
    return { value_numeric: null, value_text: null, value_json: JSON.stringify(value) };
  }
  throw new Error(`unknown value_kind: ${kind}`);
}

function decodeTraitValue(vocab, row) {
  const kind = vocab.value_kind;
  if (kind === 'numeric') return row.value_numeric;
  if (kind === 'categorical') return row.value_text;
  if (kind === 'boolean') return row.value_text === 'true';
  if (kind === 'range' || kind === 'list') return JSON.parse(row.value_json);
  throw new Error(`unknown value_kind: ${kind}`);
}

function validateTraitValue(vocab, value) {
  const kind = vocab.value_kind;
  if (kind === 'numeric') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `${vocab.trait_name}: not a finite number` };
    return { ok: true };
  }
  if (kind === 'categorical') {
    if (vocab.enum_values && !vocab.enum_values.includes(value)) {
      return { ok: false, error: `${vocab.trait_name}: '${value}' not in enum [${vocab.enum_values.join(',')}]` };
    }
    return { ok: true };
  }
  if (kind === 'boolean') {
    if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
      return { ok: false, error: `${vocab.trait_name}: not a boolean` };
    }
    return { ok: true };
  }
  if (kind === 'range') {
    if (!value || typeof value !== 'object' ||
        !Number.isFinite(Number(value.min)) || !Number.isFinite(Number(value.max))) {
      return { ok: false, error: `${vocab.trait_name}: range requires {min,max} numeric` };
    }
    return { ok: true };
  }
  if (kind === 'list') {
    if (!Array.isArray(value)) return { ok: false, error: `${vocab.trait_name}: list requires array` };
    return { ok: true };
  }
  return { ok: false, error: `${vocab.trait_name}: unknown value_kind ${kind}` };
}

module.exports = { encodeTraitValue, decodeTraitValue, validateTraitValue };
