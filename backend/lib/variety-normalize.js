'use strict';

/**
 * Normalize a variety/cultivar name for storage and dedup purposes.
 *
 * Rules (extracted from sync-grin-varieties.js for shared use):
 *   - Trim leading/trailing whitespace
 *   - Strip surrounding single ASCII quotes (GRIN often writes 'Cherokee Purple')
 *   - Remove trademark symbols (™, ®, ©)
 *   - Replace remaining ASCII single quotes with the right single curly quote
 *   - Collapse internal whitespace to single spaces
 *
 * Returns '' for null/undefined/empty inputs.
 */
function normalizeVarietyName(name) {
  const CURLY_RIGHT_QUOTE = '’'; // right single quotation mark
  return (name || '').trim()
    .replace(/^'|'$/g, '')        // surrounding single quotes
    .replace(/[™®©]/g, '') // ™ ® ©
    .replace(/'/g, CURLY_RIGHT_QUOTE) // remaining ASCII single quotes → curly right
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normalizeVarietyName };
