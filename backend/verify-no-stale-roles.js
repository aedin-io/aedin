#!/usr/bin/env node
'use strict';
/**
 * verify-no-stale-roles.js — assert that no entity holds a role which
 * re-evaluation would change.
 *
 * Sibling to verify-no-coarse-defaults.js, which verifies the RULES are
 * disabled. That check passed all along while thousands of entities still
 * carried what those rules had written — turning a rule off does not retract
 * its output. This closes that gap.
 *
 * It does NOT assert the stale-provenance candidate set is empty: that set can
 * never be empty, because some candidates legitimately hold a value a live rule
 * reproduces (ants: disabled hymenoptera rule -> enabled Formicidae rule). The
 * check is a DRY-RUN SWEEP that must change nothing — so the verifier and the
 * fixer are the same code path and cannot drift apart.
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { sweep } = require('./resweep-stale-roles.js');

(async () => {
  const db = await open({ filename: process.env.AEDIN_CORPUS_DB || CORPUS_DB, driver: sqlite3.Database });
  const { candidates, outcome, transitions } = await sweep(db, { apply: false });
  await db.close();

  const wouldChange = outcome.assigned || 0;
  if (wouldChange === 0) {
    console.log(`PASS — ${candidates.length} stale-provenance candidates, none defective `
      + `(re-evaluation changes no role).`);
    process.exit(0);
  }
  console.error(`FAIL — ${wouldChange} of ${candidates.length} candidates hold a role `
    + `re-evaluation would change:`);
  for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(v).padStart(6)}  ${k}`);
  }
  console.error('\nFix: node resweep-stale-roles.js --apply');
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
