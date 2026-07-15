'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runScopedExpansion, SCOPED_TRIPLES_SQL, EXPAND_HARMFUL, ATTRACTOR, PEST_BIO, meetsEvidence } = require('./load-globi-scoped');

// corn(crop) <- aphid(herbivory); ladybug eats aphid (biocontrol);
// ladybug visitsFlowersOf marigold (attractant); plus an off-chain marine pair.
function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT,
    bio_category TEXT, family TEXT, primary_role TEXT, crop_type TEXT, edible INTEGER,
    scope_tier INTEGER)`);
  db.exec(`CREATE TABLE interactions (source_name TEXT, source_path TEXT, target_name TEXT,
    target_path TEXT, interaction_type TEXT, lat REAL, lng REAL, location TEXT,
    reference_citation TEXT, reference_doi TEXT, reference_url TEXT, source_citation TEXT)`);
  db.exec(`CREATE INDEX idx_src ON interactions(source_name)`);
  db.exec(`CREATE INDEX idx_tgt ON interactions(target_name)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, data_tier TEXT, interaction_type_raw TEXT,
    interaction_category TEXT, effect_direction TEXT, confidence_score REAL,
    applied_weight REAL, evidence_tier TEXT, valence_confidence TEXT, resolution_path TEXT,
    mechanism TEXT, impact_class TEXT, interaction_count INTEGER, locality_count INTEGER,
    country TEXT, subdivision TEXT, reference_citation TEXT, reference_doi TEXT,
    reference_url TEXT, source_count INTEGER, chain_role TEXT)`);
  const e = db.prepare(`INSERT INTO entities (scientific_name, bio_category, family, primary_role, crop_type, edible)
    VALUES (?,?,?,?,?,?)`);
  e.run('Zea mays', 'plantae', 'Poaceae', 'crop', 'grain', 1);
  e.run('Aphis maidis', 'invertebrate', 'Aphididae', 'pest_insect', null, null);
  e.run('Hippodamia convergens', 'invertebrate', 'Coccinellidae', 'biocontrol', null, null);
  e.run('Tagetes erecta', 'plantae', 'Asteraceae', null, null, null);
  e.run('Gadus morhua', 'vertebrate', 'Gadidae', null, null, null);
  e.run('Calanus finmarchicus', 'invertebrate', 'Calanidae', null, null, null);
  const i = db.prepare(`INSERT INTO interactions (source_name, target_name, interaction_type, location)
    VALUES (?,?,?,?)`);
  i.run('Aphis maidis', 'Zea mays', 'eats', 'IL');
  i.run('Hippodamia convergens', 'Aphis maidis', 'eats', 'IL');
  i.run('Hippodamia convergens', 'Tagetes erecta', 'visitsFlowersOf', 'IL');
  i.run('Gadus morhua', 'Calanus finmarchicus', 'eats', 'Atlantic');
  return db;
}

// Both-endpoints-in-frontier regression fixture: a second biocontrol that eats the
// aphid is discovered at L2, so at L3 BOTH ladybug and the second biocontrol are in
// the frontier. The L3 attractor edge (biocontrol -> marigold) must still fire
// orientation-independently when the plant sits in the source column.
function bothVisitedFixtureDb() {
  const db = fixtureDb();
  const e = db.prepare(`INSERT INTO entities (scientific_name, bio_category, family, primary_role, crop_type, edible)
    VALUES (?,?,?,?,?,?)`);
  e.run('Chrysoperla carnea', 'invertebrate', 'Chrysopidae', 'biocontrol', null, null);
  const i = db.prepare(`INSERT INTO interactions (source_name, target_name, interaction_type, location)
    VALUES (?,?,?,?)`);
  // second biocontrol eats the aphid -> discovered at L2 alongside the ladybug
  i.run('Chrysoperla carnea', 'Aphis maidis', 'eats', 'IL');
  // L3 attractor edge with the PLANT in the source column (reversed orientation):
  // marigold visited-by lacewing. Both lacewing & ladybug are in the L3 frontier.
  i.run('Tagetes erecta', 'Chrysoperla carnea', 'flowersVisitedBy', 'IL');
  return db;
}

test('scope gates: trimmed category sets + evidence threshold (agroecologist-validated)', () => {
  // competition/allelopathy are plant-plant interference with no natural enemy to
  // trace -> must NOT spawn tier-2 pest expansion.
  assert.ok(!EXPAND_HARMFUL.has('competition'), 'competition must not spawn expansion');
  assert.ok(!EXPAND_HARMFUL.has('allelopathy'), 'allelopathy must not spawn expansion');
  assert.ok(EXPAND_HARMFUL.has('herbivory'));
  assert.ok(EXPAND_HARMFUL.has('parasitism'));
  assert.ok(EXPAND_HARMFUL.has('disease_vector'), 'disease_vector expands to the vector’s enemy');
  // mutualism over-captures (ant-tending/dispersal/symbionts) -> dropped from attractor.
  assert.ok(!ATTRACTOR.has('mutualism'), 'generic mutualism must not be an attractor edge');
  assert.ok(ATTRACTOR.has('pollination') && ATTRACTOR.has('flower_visitor'));
  // pests restricted to invertebrate/microbe/fungi (vertebrate/plant pests have no
  // tractable classical biocontrol in this graph).
  assert.ok(PEST_BIO.has('invertebrate') && PEST_BIO.has('microbe') && PEST_BIO.has('fungi'));
  assert.ok(!PEST_BIO.has('vertebrate') && !PEST_BIO.has('plantae'));
  // evidence: >=3 records AND >=2 localities (AND, not OR).
  const opt = { minRecords: 3, minLocalities: 2 };
  assert.equal(meetsEvidence(3, 2, opt), true);
  assert.equal(meetsEvidence(2, 5, opt), false, 'too few records');
  assert.equal(meetsEvidence(9, 1, opt), false, 'too few localities');
});

test('tier-expansion query is index-driven (never full-scans interactions)', () => {
  // Regression guard for the production OOM/scan defect: the prepared query must
  // SEARCH interactions via idx_source_name/idx_target_name, NOT SCAN the 27.5M-row
  // table. CROSS JOIN forces the frontier as the outer table so the plan is
  // deterministic regardless of ANALYZE stats or table size.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE interactions (source_name TEXT, target_name TEXT, interaction_type TEXT, location TEXT)`);
  db.exec(`CREATE INDEX idx_source_name ON interactions(source_name)`);
  db.exec(`CREATE INDEX idx_target_name ON interactions(target_name)`);
  db.exec(`CREATE TEMP TABLE _frontier (name TEXT PRIMARY KEY)`);
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + SCOPED_TRIPLES_SQL).all().map(r => r.detail);
  assert.ok(plan.some(d => /SEARCH i USING (COVERING )?INDEX/.test(d)),
    'interactions (alias i) must be index-searched; plan was: ' + JSON.stringify(plan));
  assert.ok(!plan.some(d => /\bSCAN i\b/.test(d)),
    'interactions (alias i) must NOT be full-scanned; plan was: ' + JSON.stringify(plan));
  db.close();
});

test('frontier batching (batchSize:1) yields the full, correct scoped result', () => {
  // Guards the memory-bounding refactor against ABSOLUTE expected counts (not a
  // self-comparison — a bug in shared code would break both sides equally and hide).
  // The both-visited fixture has 2-name L2/L3 frontiers, so batchSize:1 splits them
  // into separate batches; the result must be identical to a single pass: BOTH
  // biocontrols attract the marigold, so attractant=2 and 5 claims total.
  const db = bothVisitedFixtureDb();
  runScopedExpansion(db, { batchSize: 1, minRecords: 1, minLocalities: 1 });
  const tier = (name) => (db.prepare('SELECT scope_tier FROM entities WHERE scientific_name = ?').get(name) || {}).scope_tier;
  assert.equal(tier('Zea mays'), 0);
  assert.equal(tier('Aphis maidis'), 1);
  assert.equal(tier('Hippodamia convergens'), 2);
  assert.equal(tier('Chrysoperla carnea'), 2);
  assert.equal(tier('Tagetes erecta'), 3);
  const byRole = Object.fromEntries(
    db.prepare(`SELECT chain_role, COUNT(*) n FROM claims GROUP BY chain_role`).all().map(r => [r.chain_role, r.n]));
  assert.equal(byRole.crop_interaction, 1);
  assert.equal(byRole.biocontrol, 2);
  assert.equal(byRole.attractant, 2, 'both biocontrols must attract the marigold even when split across batches');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claims').get().n, 5);
  db.close();
});

test('both-in-frontier L3 attractor edge fires orientation-independently', () => {
  const db = bothVisitedFixtureDb();
  runScopedExpansion(db, { minRecords: 1, minLocalities: 1 });
  const tier = (name) => db.prepare('SELECT scope_tier FROM entities WHERE scientific_name = ?').get(name).scope_tier;
  assert.equal(tier('Chrysoperla carnea'), 2);
  assert.equal(tier('Tagetes erecta'), 3);
  // attractant claim emitted for the reversed-orientation (plant-in-source) edge too
  const byRole = Object.fromEntries(
    db.prepare(`SELECT chain_role, COUNT(*) n FROM claims GROUP BY chain_role`).all().map(r => [r.chain_role, r.n]));
  assert.ok(byRole.attractant >= 1, 'attractant claim must fire regardless of src/tgt order');
  db.close();
});

// crop <- well-documented pest (3 records / 2 localities) AND a 1-record incidental
// pest. Both are crop interactors, but only the documented pest should expand to
// tier-2 (its enemy discovered); the incidental pest's enemy must stay out of scope.
function evidenceFixtureDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT,
    bio_category TEXT, family TEXT, primary_role TEXT, crop_type TEXT, edible INTEGER, scope_tier INTEGER)`);
  db.exec(`CREATE TABLE interactions (source_name TEXT, target_name TEXT, interaction_type TEXT, location TEXT,
    reference_citation TEXT, reference_doi TEXT, reference_url TEXT)`);
  db.exec(`CREATE INDEX idx_source_name ON interactions(source_name)`);
  db.exec(`CREATE INDEX idx_target_name ON interactions(target_name)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
    data_tier TEXT, interaction_type_raw TEXT, interaction_category TEXT, effect_direction TEXT,
    confidence_score REAL, applied_weight REAL, evidence_tier TEXT, valence_confidence TEXT,
    resolution_path TEXT, mechanism TEXT, impact_class TEXT, interaction_count INTEGER, locality_count INTEGER,
    country TEXT, subdivision TEXT, reference_citation TEXT, reference_doi TEXT, reference_url TEXT,
    source_count INTEGER, chain_role TEXT)`);
  const e = db.prepare(`INSERT INTO entities (scientific_name, bio_category, family, primary_role, crop_type, edible) VALUES (?,?,?,?,?,?)`);
  e.run('Zea mays', 'plantae', 'Poaceae', 'crop', 'grain', 1);
  e.run('Aphis maidis', 'invertebrate', 'Aphididae', 'pest_insect', null, null);   // documented pest
  e.run('Rarus incidentalis', 'invertebrate', 'Noisidae', null, null, null);       // 1-record incidental
  e.run('Hippodamia convergens', 'invertebrate', 'Coccinellidae', 'biocontrol', null, null);
  e.run('Predatorus rarus', 'invertebrate', 'Carabidae', 'biocontrol', null, null);
  const i = db.prepare(`INSERT INTO interactions (source_name, target_name, interaction_type, location) VALUES (?,?,?,?)`);
  // documented pest: 3 records across 2 localities -> passes evidence gate
  i.run('Aphis maidis', 'Zea mays', 'eats', 'IL'); i.run('Aphis maidis', 'Zea mays', 'eats', 'IA'); i.run('Aphis maidis', 'Zea mays', 'eats', 'IL');
  // incidental pest: 1 record -> fails evidence gate
  i.run('Rarus incidentalis', 'Zea mays', 'eats', 'IL');
  // enemy of documented pest: 3 records / 2 localities -> tier-2
  i.run('Hippodamia convergens', 'Aphis maidis', 'eats', 'IL'); i.run('Hippodamia convergens', 'Aphis maidis', 'eats', 'IA'); i.run('Hippodamia convergens', 'Aphis maidis', 'eats', 'IL');
  // enemy of incidental pest: well-documented, but must never be reached (Rarus not expanded)
  i.run('Predatorus rarus', 'Rarus incidentalis', 'eats', 'IL'); i.run('Predatorus rarus', 'Rarus incidentalis', 'eats', 'IA'); i.run('Predatorus rarus', 'Rarus incidentalis', 'eats', 'IL');
  return db;
}

test('default scope has NO evidence threshold (comprehensive coverage of sparse GloBI)', () => {
  // GloBI is sparse and many legitimate pests are endemic to a single locality, so
  // the default policy is comprehensive: rely on category + bio_category gates and
  // drop the evidence threshold. (User policy 2026-05-30: "many species only exist
  // in 1 locality; globi may not have 3 records for a real pest.") meetsEvidence
  // stays opt-in via explicit { minRecords, minLocalities } for callers who want it.
  const db = evidenceFixtureDb();
  runScopedExpansion(db);                                     // defaults — no threshold
  const tier = (n) => (db.prepare('SELECT scope_tier FROM entities WHERE scientific_name=?').get(n) || {}).scope_tier;
  // With the gate OFF, the 1-record incidental pest's enemy IS discovered (Rarus is
  // still invertebrate + herbivory, so category/bio_category gates pass it through).
  assert.equal(tier('Rarus incidentalis'), 1);
  assert.equal(tier('Predatorus rarus'), 2, 'with default ungated, the 1-record pest\'s enemy reaches tier-2');
  const biocontrol = db.prepare(`SELECT COUNT(*) n FROM claims WHERE chain_role='biocontrol'`).get().n;
  assert.equal(biocontrol, 2, 'both biocontrols (Hippodamia->Aphis, Predatorus->Rarus) emit at default scope');
  db.close();
});

test('evidence gate (opt-in {minRecords:3, minLocalities:2}): only well-documented pests expand to tier-2', () => {
  const db = evidenceFixtureDb();
  runScopedExpansion(db, { minRecords: 3, minLocalities: 2 });
  const tier = (n) => (db.prepare('SELECT scope_tier FROM entities WHERE scientific_name=?').get(n) || {}).scope_tier;
  assert.equal(tier('Zea mays'), 0);
  assert.equal(tier('Aphis maidis'), 1);          // documented pest, expanded
  assert.equal(tier('Hippodamia convergens'), 2); // its enemy discovered at tier-2
  assert.equal(tier('Rarus incidentalis'), 1);    // crop interactor (claim + tier-1) ...
  assert.equal(tier('Predatorus rarus'), null);   // ... but NOT expanded -> its enemy out of scope
  // both harmful crop edges still emit a tier-1 claim
  const crop1 = db.prepare(`SELECT COUNT(*) n FROM claims WHERE chain_role='crop_interaction'`).get().n;
  assert.equal(crop1, 2, 'both pests get a crop_interaction claim; only one expands');
  db.close();
});

test('--counts mode tallies tiers + claims without writing (read-only)', () => {
  // Asserts both the read-only property AND that counts mode produces the same
  // tally a real write run at the same gate params would. Uses the opt-in 3/2
  // gate explicitly so the expected values stay stable as the DEFAULT policy
  // widens. (The new default is ungated; see the "default scope has NO evidence
  // threshold" test for the comprehensive-coverage assertions.)
  const db = evidenceFixtureDb();
  const res = runScopedExpansion(db, { countsOnly: true, minRecords: 3, minLocalities: 2 });
  // no DB mutation
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claims').get().n, 0, 'counts mode must not insert claims');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities WHERE scope_tier IS NOT NULL').get().n, 0, 'counts mode must not set scope_tier');
  // gated-at-3/2 tally: Aphis expands, Rarus doesn't -> Predatorus never reached
  assert.equal(res.claimRoleCounts.crop_interaction, 2);
  assert.equal(res.claimRoleCounts.biocontrol, 1);            // Hippodamia -> Aphis only
  assert.deepEqual(res.tierCounts, { 0: 1, 1: 2, 2: 1 });     // crop=1, pests=2, biocontrol=1
  db.close();
});

test('BFS scopes the 4-step chain and excludes off-chain nodes', () => {
  const db = fixtureDb();
  runScopedExpansion(db, { minRecords: 1, minLocalities: 1 });
  const tier = (name) => db.prepare('SELECT scope_tier FROM entities WHERE scientific_name = ?').get(name).scope_tier;
  assert.equal(tier('Zea mays'), 0);
  assert.equal(tier('Aphis maidis'), 1);
  assert.equal(tier('Hippodamia convergens'), 2);
  assert.equal(tier('Tagetes erecta'), 3);
  assert.equal(tier('Gadus morhua'), null);
  assert.equal(tier('Calanus finmarchicus'), null);
  const byRole = Object.fromEntries(
    db.prepare(`SELECT chain_role, COUNT(*) n FROM claims GROUP BY chain_role`).all().map(r => [r.chain_role, r.n]));
  assert.equal(byRole.crop_interaction, 1);
  assert.equal(byRole.biocontrol, 1);
  assert.equal(byRole.attractant, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claims').get().n, 3);
  db.close();
});
