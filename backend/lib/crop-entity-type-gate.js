'use strict';

/**
 * crop-entity-type-gate.js — deterministic entity-type validation for crop-slot claims.
 *
 * Targets the `field_mislabel` extraction-error class (Hermes extractor investigation,
 * 2026-06-16: ~30% of extraction errors): a non-plant organism placed in a CROP field
 * (e.g. a cultivated cucurbit, a fungus, or an animal landing in the crops table). A crop
 * MUST be a plant (or a cultivated fungus/alga). This is the deterministic, no-LLM half of
 * the fix — it complements the extractor prompt's entity-type sanity check.
 *
 * High-precision by design: only CLEAR animals (invertebrate/vertebrate) in a crop slot are
 * rejected; microbe is FLAGGED (rare-but-possible edge), and unknown/null/other is left
 * ALONE (never reject on missing taxonomy — false positives corrupt good crop data). Existing
 * crop-tagged entities are 100% plantae, so the reject path has ~zero false-positive risk.
 *
 * Pure: classify a resolved bio_category. No I/O.
 */

const ANIMAL = new Set(['invertebrate', 'vertebrate']);
const ANIMAL_KINGDOMS = new Set(['animalia', 'metazoa']);

/**
 * cropSlotVerdict(bioCategory, kingdom) -> { allowed, severity, reason }
 *   severity: 'ok' | 'flag' | 'reject'
 *
 * REJECT only a CONFIRMED animal in a crop slot — bio_category is invertebrate/vertebrate
 * AND the kingdom corroborates it (Animalia/Metazoa). This corroboration is load-bearing:
 * the audit (2026-06-16) found that the documented entity-taxonomy-corruption bug mis-tags
 * some plants as invertebrate with a NULL kingdom (e.g. `Lycopersicon esculentum` = tomato).
 * Rejecting on bio_category alone would false-reject those legitimate crop claims. So an
 * animal bio_category with an UNCONFIRMED kingdom is FLAGGED (suspect taxonomy), not rejected.
 *
 *   - invertebrate/vertebrate + kingdom Animalia/Metazoa -> reject (confirmed animal)
 *   - invertebrate/vertebrate + kingdom null/other       -> flag   (suspect corruption; verify)
 *   - microbe                                            -> flag   (rarely a crop)
 *   - plantae / fungi / other / null / '' (bio)          -> ok
 */
function cropSlotVerdict(bioCategory, kingdom) {
  const c = String(bioCategory == null ? '' : bioCategory).toLowerCase().trim();
  const k = String(kingdom == null ? '' : kingdom).toLowerCase().trim();
  if (ANIMAL.has(c)) {
    if (ANIMAL_KINGDOMS.has(k)) {
      return { allowed: false, severity: 'reject', reason: `crop-slot organism is a confirmed animal (${c}, kingdom ${kingdom})` };
    }
    return { allowed: true, severity: 'flag', reason: `crop-slot organism tagged ${c} but kingdom unconfirmed — suspect entity-taxonomy corruption, verify before trusting` };
  }
  if (c === 'microbe') {
    return { allowed: true, severity: 'flag', reason: 'crop-slot organism is microbe — verify it is a cultivated crop' };
  }
  return { allowed: true, severity: 'ok', reason: '' };
}

module.exports = { cropSlotVerdict };
