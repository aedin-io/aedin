'use strict';
// GRIN improvement-level + name-hygiene gate. Pure. Sets variety_type from improvement_level.
const PROMOTE_LEVELS = { 'Cultivar': 'cultivar', 'Landrace': 'landrace', 'Cultivated material': 'cultivar' };
const CODE_NAME = /^[A-Z]{1,4}[\s-]?\d{2,}$/;   // accession/breeding codes: T1118, LYC1743, EC-329392

function stripQuotes(s) {
  return String(s || '').trim().replace(/^[‘’']+|[‘’']+$/g, '').trim();
}

function grinGate(row) {
  const name = stripQuotes(row.plant_name);
  if (name.length < 2) return { promote: false, reason: 'no_name' };
  if (CODE_NAME.test(name)) return { promote: false, reason: 'code_name' };   // before improvement level — rejects codes even when Cultivar-tagged
  const variety_type = PROMOTE_LEVELS[row.improvement_level];
  if (!variety_type) return { promote: false, reason: 'improvement_level:' + (row.improvement_level || 'blank') };
  return { promote: true, variety_type, name };
}

module.exports = { grinGate, stripQuotes, CODE_NAME };
