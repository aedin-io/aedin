'use strict';
// Canonical SQLite paths. CORPUS_DB = the curated AEDIN corpus (aedin.sqlite);
// RAW_DB = the raw GloBI source (globi.sqlite, ~40GB). Both in backend/.
const path = require('path');
const BACKEND_DIR = path.resolve(__dirname, '..');
const CORPUS_DB = path.join(BACKEND_DIR, 'aedin.sqlite');
const RAW_DB = path.join(BACKEND_DIR, 'globi.sqlite');
const ATTACH_RAW_SQL = `ATTACH DATABASE '${RAW_DB}' AS raw`;
const ATTACH_CORPUS_SQL = `ATTACH DATABASE '${CORPUS_DB}' AS corpus`;
const RAW_TABLES = new Set([
  'interactions', 'interaction_locality_coverage', 'species_locality_coverage',
  'crop_locality_coverage', 'globi_fetch_log', 'claim_remap_log',
]);
module.exports = { CORPUS_DB, RAW_DB, BACKEND_DIR, ATTACH_RAW_SQL, ATTACH_CORPUS_SQL, RAW_TABLES };
