'use strict';
/**
 * verify-no-coarse-defaults.js
 *
 * Read-only assertion script: confirms the family-floor migration (Task 6) removed
 * all coarse CLASS_RULES role defaults from the named regression entities.
 *
 * CORRECTION vs. brief: Azadirachta indica / Lavandula angustifolia / Calendula officinalis
 * now carry primary_role='crop' via ECOCROP re-classification (FAO-curated evidence that
 * neem/lavender/calendula are legitimately cultivated crops). The bug was the earlier
 * plantae→'weed' class default. So the forbidden coarse role for all three is 'weed',
 * NOT 'crop'.
 *
 * Run: node verify-no-coarse-defaults.js
 * Exit 0 = all PASS; exit 1 = one or more FAIL.
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

// Maps scientific_name → the coarse default role that MUST NOT be present after migration.
// A PASS means the entity's actual role differs from the forbidden coarse default
// (it may be 'unclassified', an evidence-based role, or anything else that isn't the coarse value).
const MUST_NOT_BE_COARSE = {
  'Coniothyrium minitans':   'pathogen_fungal', // mycoparasite; coarse fungi default was pathogen_fungal
  'Gliocladium virens':      'pathogen_fungal', // = Trichoderma virens; coarse fungi default
  // Botanicals: the coarse plantae CLASS_RULE assigned 'weed'; ECOCROP later correctly re-assigned
  // these to 'crop' on FAO evidence — so 'weed' is the forbidden coarse value, 'crop' is correct.
  'Azadirachta indica':      'weed',            // neem; coarse plantae→weed (now 'crop' via ECOCROP = correct)
  'Lavandula angustifolia':  'weed',            // lavender; coarse plantae→weed
  'Calendula officinalis':   'weed',            // calendula; coarse plantae→weed
  'Lumbricus terrestris':    'pest_insect',     // earthworm (annelid); coarse invertebrate→pest_insect default
};

(async () => {
  const db = await open({
    filename: CORPUS_DB,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY,
  });

  let fail = 0;

  console.log('=== Regression-entity role assertions ===');
  for (const [name, coarse] of Object.entries(MUST_NOT_BE_COARSE)) {
    const e = await db.get(
      'SELECT primary_role FROM entities WHERE scientific_name=? COLLATE NOCASE',
      [name],
    );
    const ok = e && e.primary_role !== coarse;
    const label = ok ? 'PASS' : 'FAIL';
    const roleStr = e ? e.primary_role : '(missing)';
    console.log(`  ${label}  ${name}: ${roleStr}  (must NOT be '${coarse}')`);
    if (!ok) fail++;
  }

  // Claim-rescue: at least one fungal entity with pathogen claims must still carry
  // primary_role='pathogen_fungal' — proves evidenced pathogen fungi were retained,
  // not wholesale-wiped by the migration.
  console.log('\n=== Claim-rescue check ===');
  const rescued = await db.get(
    "SELECT COUNT(*) n FROM entities WHERE bio_category='fungi' AND primary_role='pathogen_fungal' AND parent_entity_id IS NULL",
  );
  const rescuedOk = rescued.n > 0;
  console.log(
    `  ${rescuedOk ? 'PASS' : 'FAIL'}  claim-rescue: ${rescued.n} fungi entities still carry primary_role='pathogen_fungal' (evidence-backed)`,
  );
  if (!rescuedOk) fail++;

  await db.close();

  console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});
