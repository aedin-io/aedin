import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getEntityBySlug, getGlobiClaimsForEntity, getRelatedEntities, getCropWebGlobi, getAtlasGlobiSlice, normalizeInteractionRow, getInteractionRows, getGlobiClaimById } from './queries-d1.ts';

// Minimal D1 surface over better-sqlite3 (sync under the hood; returns promises).
function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async all() { return { results: stmt.all(...args), success: true }; },
        async first() { return stmt.get(...args) ?? null; },
      };
      return api;
    },
  };
}

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
    common_name TEXT, genus TEXT, taxonomic_resolution TEXT, bio_category TEXT);`);
  db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, authors TEXT,
    year INTEGER, publication TEXT, url TEXT, license TEXT);`);
  db.exec(`CREATE TABLE claim_critic_verdicts (staging_id INTEGER, critic_name TEXT, verdict TEXT);`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, source_id INTEGER, staging_id INTEGER, data_tier TEXT,
    review_status TEXT, interaction_category TEXT, interaction_type_raw TEXT,
    interaction_type_globi TEXT, effect_direction TEXT, chain_role TEXT, source_quote TEXT,
    source_page TEXT, reference_citation TEXT, reference_doi TEXT, reference_url TEXT,
    interaction_count INTEGER);`);
  db.prepare(`INSERT INTO entities (id,slug,scientific_name,bio_category) VALUES (1,'crop','Zea mays','plantae'),(2,'pest','Ostrinia nubilalis','invertebrate')`).run();
  db.prepare(`INSERT INTO sources (id,slug,title) VALUES (100,'src-a','A Study')`).run();
  db.prepare(`INSERT INTO claim_critic_verdicts VALUES (500,'entomologist','plausible')`).run();
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,source_id,staging_id,data_tier,review_status,interaction_category,source_quote,interaction_count) VALUES (10,1,2,100,500,'tier1_paper','ai_reviewed','herbivory','maize is eaten by borer',NULL)`).run();
  const g = db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,source_id,data_tier,review_status,chain_role,interaction_type_raw,source_quote,reference_citation,interaction_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 5; i++) g.run(20+i, 1, 2, null, 'tier2_globi', 'unreviewed', 'crop_interaction', 'eats', null, `cite-${i}`, i+1);
  g.run(30, 1, 2, null, 'tier2_globi', 'unreviewed', null, 'eats', null, 'x', 99);
  // ai_reviewed claim with empty source_quote — must be excluded by getEntityBySlug
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,source_id,staging_id,data_tier,review_status,interaction_category,source_quote,interaction_count) VALUES (11,1,2,100,500,'tier1_paper','ai_reviewed','herbivory','',NULL)`).run();
  return db;
}

test('getEntityBySlug returns literature claims grouped by category + critic verdicts', async () => {
  const DB = d1(fixture());
  const res = await getEntityBySlug(DB, 'crop');
  assert.equal(res.entity.scientific_name, 'Zea mays');
  assert.equal(res.total_claims, 1);
  assert.ok(res.claims_by_category.get('herbivory'));
  assert.equal(res.claims_by_category.get('herbivory')[0].critic_verdicts, 'entomologist|plausible');
});

test('getEntityBySlug returns null for unknown slug', async () => {
  const DB = d1(fixture());
  assert.equal(await getEntityBySlug(DB, 'nope'), null);
});

test('getGlobiClaimsForEntity caps at limit, orders by interaction_count desc, reports total, excludes no-chain_role', async () => {
  const DB = d1(fixture());
  const { claims, total } = await getGlobiClaimsForEntity(DB, 1, 3);
  assert.equal(total, 5);
  assert.equal(claims.length, 3);
  assert.equal(claims[0].interaction_count, 5);
  assert.equal(claims[0].provenance, 'globi');
  assert.equal(claims[0].interaction_type_raw, 'eats');
});

test('getEntityBySlug + getGlobiClaimsForEntity match on the object-side entity too', async () => {
  const DB = d1(fixture());
  const res = await getEntityBySlug(DB, 'pest');          // entity 2 is object of claim 10
  assert.equal(res.total_claims, 1);
  const { total } = await getGlobiClaimsForEntity(DB, 2, 200);
  assert.equal(total, 5);                                  // entity 2 is object of the 5 scoped globi
});

test('getEntityBySlug excludes ai_reviewed claims with empty source_quote', async () => {
  const DB = d1(fixture());
  // fixture includes claim 11: ai_reviewed with source_quote=''. Only claim 10 (non-empty quote) qualifies.
  const res = await getEntityBySlug(DB, 'crop');
  assert.equal(res.total_claims, 1);
});

test('getRelatedEntities returns co-claim partners by shared_count desc', async () => {
  const DB = d1(fixture());
  const rel = await getRelatedEntities(DB, 1, 8);
  assert.equal(rel[0].slug, 'pest');     // entity 2 shares the literature claim
  assert.ok(rel[0].shared_count >= 1);
});

// ── getCropWebGlobi ─────────────────────────────────────────────────────
// Separate fixture (does not touch fixture() above). Tritrophic GloBI chain:
//   crop(1) --crop_interaction--> pest(2)        [ring 1]
//   crop(1) --crop_interaction--> aphid(5)       [ring 1]
//   crop(1) --attractant------->  flower(4)      [ring 1]
//   pest(2) --biocontrol------->  predator(3)    [ring 2]
function globiWebFixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
    common_name TEXT, bio_category TEXT, primary_role TEXT);`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, data_tier TEXT, chain_role TEXT, interaction_category TEXT,
    interaction_type_raw TEXT, interaction_count INTEGER);`);
  db.prepare(`INSERT INTO entities (id,slug,scientific_name,common_name,bio_category,primary_role) VALUES
    (1,'crop','Zea mays','maize','plantae','crop'),
    (2,'pest','Ostrinia nubilalis','borer','invertebrate','pest_insect'),
    (3,'predator','Trichogramma','wasp','invertebrate','beneficial_predator'),
    (4,'flower','Fagopyrum esculentum','buckwheat','plantae','wild_plant'),
    (5,'aphid','Rhopalosiphum maidis','corn aphid','invertebrate','pest_insect')`).run();
  const ins = db.prepare(`INSERT INTO claims
    (id,subject_entity_id,object_entity_id,data_tier,chain_role,interaction_category,interaction_type_raw,interaction_count)
    VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(10, 1, 2, 'tier2_globi', 'crop_interaction', 'herbivory', 'eatenBy', 50);
  ins.run(11, 1, 5, 'tier2_globi', 'crop_interaction', 'herbivory', 'eatenBy', 20);
  ins.run(12, 1, 4, 'tier2_globi', 'attractant',       'mutualism', 'visitedBy', 10);
  ins.run(13, 2, 3, 'tier2_globi', 'biocontrol',       'predation', 'preyedUponBy', 30);
  // noise: a literature claim and a chain_role-less globi claim must be ignored
  ins.run(14, 1, 2, 'tier1_paper', 'crop_interaction', 'herbivory', 'eatenBy', 999);
  ins.run(15, 1, 3, 'tier2_globi', null,               'predation', 'preyedUponBy', 999);
  return db;
}

test('getCropWebGlobi assembles ring-1 (crop_interaction+attractant) and ring-2 (biocontrol)', async () => {
  const DB = d1(globiWebFixture());
  const res = await getCropWebGlobi(DB, { id: 1, slug: 'crop' });
  assert.equal(res.focus, 'crop');
  const byId = new Map(res.nodes.map(n => [n.id, n]));
  assert.equal(byId.get(2).depth, 1);   // pest — ring 1
  assert.equal(byId.get(5).depth, 1);   // aphid — ring 1
  assert.equal(byId.get(4).depth, 1);   // flower — ring 1 (attractant)
  assert.equal(byId.get(3).depth, 2);   // predator — ring 2 (biocontrol)
  assert.equal(res.nodes.length, 4);    // focus (1) excluded
  assert.equal(res.edges.length, 4);    // 3 ring-1 + 1 ring-2; literature + null-chain_role excluded
  assert.ok(res.edges.every(e => e.provenance === 'globi'));
});

test('getCropWebGlobi reports category counts and tier1 totals', async () => {
  const DB = d1(globiWebFixture());
  const res = await getCropWebGlobi(DB, { id: 1, slug: 'crop' });
  const cat = new Map(res.categories.map(c => [c.category, c.n]));
  assert.equal(cat.get('herbivory'), 2);
  assert.equal(cat.get('mutualism'), 1);
  assert.equal(cat.get('predation'), 1);
  assert.equal(res.capped.tier1_total, 3);   // pest, aphid, flower
  assert.equal(res.capped.tier1_shown, 3);
});

test('getCropWebGlobi caps ring-1 by interaction_count desc', async () => {
  const DB = d1(globiWebFixture());
  const res = await getCropWebGlobi(DB, { id: 1, slug: 'crop' }, { tier1Cap: 1 });
  assert.equal(res.capped.tier1_total, 3);
  assert.equal(res.capped.tier1_shown, 1);
  const ring1 = res.nodes.filter(n => n.depth === 1);
  assert.equal(ring1.length, 1);
  assert.equal(ring1[0].id, 2);              // pest has highest interaction_count (50)
  // ring-2 only expands from kept ring-1, so predator (biocontrol of pest) survives
  assert.ok(res.nodes.some(n => n.id === 3 && n.depth === 2));
});

test('getCropWebGlobi returns empty shape for a crop with no GloBI chain', async () => {
  const DB = d1(globiWebFixture());
  const res = await getCropWebGlobi(DB, { id: 3, slug: 'predator' });
  // entity 3 is only a biocontrol *object*; it has no crop_interaction/attractant edges
  assert.equal(res.nodes.length, 0);
  assert.equal(res.edges.length, 0);
  assert.equal(res.categories.length, 0);
  assert.equal(res.capped.tier1_total, 0);
});

test('getCropWebGlobi: biocontrol edge with both ends in ring-1 keeps both at depth 1', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
    common_name TEXT, bio_category TEXT, primary_role TEXT);`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, data_tier TEXT, chain_role TEXT, interaction_category TEXT,
    interaction_type_raw TEXT, interaction_count INTEGER);`);
  db.prepare(`INSERT INTO entities (id,slug,scientific_name) VALUES (1,'crop','Zea mays'),(2,'pest','Pest sp'),(5,'aphid','Aphid sp')`).run();
  const ins = db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,chain_role,interaction_category,interaction_type_raw,interaction_count) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(10, 1, 2, 'tier2_globi', 'crop_interaction', 'herbivory', 'eatenBy', 50);
  ins.run(11, 1, 5, 'tier2_globi', 'crop_interaction', 'herbivory', 'eatenBy', 40);
  ins.run(12, 2, 5, 'tier2_globi', 'biocontrol',       'predation', 'preysOn',  30); // both ring-1
  const DB = d1(db);
  const res = await getCropWebGlobi(DB, { id: 1, slug: 'crop' });
  const byId = new Map(res.nodes.map(n => [n.id, n]));
  assert.equal(byId.get(2).depth, 1);
  assert.equal(byId.get(5).depth, 1);          // stays depth 1, not relabeled to 2
  assert.equal(res.nodes.length, 2);           // no spurious extra node
  assert.ok(res.edges.some(e => e.id === 12)); // the biocontrol edge is still emitted
});

test('getCropWebGlobi: tier2Cap limits ring-2 agents by interaction_count desc', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
    common_name TEXT, bio_category TEXT, primary_role TEXT);`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, data_tier TEXT, chain_role TEXT, interaction_category TEXT,
    interaction_type_raw TEXT, interaction_count INTEGER);`);
  db.prepare(`INSERT INTO entities (id,slug,scientific_name) VALUES (1,'crop','Zea mays'),(2,'pest','Pest sp'),(3,'waspA','Wasp A'),(4,'waspB','Wasp B')`).run();
  const ins = db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,chain_role,interaction_category,interaction_type_raw,interaction_count) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(10, 1, 2, 'tier2_globi', 'crop_interaction', 'herbivory', 'eatenBy', 50);
  ins.run(20, 2, 3, 'tier2_globi', 'biocontrol', 'predation', 'preysOn', 90); // higher
  ins.run(21, 2, 4, 'tier2_globi', 'biocontrol', 'predation', 'preysOn', 10); // lower
  const DB = d1(db);
  const res = await getCropWebGlobi(DB, { id: 1, slug: 'crop' }, { tier2Cap: 1 });
  const ring2 = res.nodes.filter(n => n.depth === 2);
  assert.equal(ring2.length, 1);
  assert.equal(ring2[0].id, 3);  // wasp A (90) kept over wasp B (10)
});

// ── getAtlasGlobiSlice ──────────────────────────────────────────────────
function atlasGlobiFixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
    common_name TEXT, bio_category TEXT, primary_role TEXT, taxonomy_path TEXT);`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, data_tier TEXT, chain_role TEXT, interaction_category TEXT,
    interaction_type_raw TEXT, interaction_count INTEGER);`);
  db.prepare(`INSERT INTO entities (id,slug,scientific_name,bio_category,primary_role,taxonomy_path) VALUES
    (1,'a','A sp','plantae','crop','Plantae|A'),
    (2,'b','B sp','invertebrate','pest_insect','Animalia|B'),
    (3,'c','C sp','invertebrate','beneficial_predator','Animalia|C')`).run();
  const ins = db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,chain_role,interaction_category,interaction_type_raw,interaction_count) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(10,1,2,'tier2_globi','crop_interaction','herbivory','eatenBy',100);
  ins.run(11,1,3,'tier2_globi','attractant','mutualism','visitedBy',40);
  ins.run(12,2,3,'tier2_globi','biocontrol','predation','preysOn',25);
  ins.run(13,1,2,'tier2_globi','crop_interaction','herbivory','eatenBy',5);
  // excluded noise: literature, null chain_role, null object
  ins.run(14,1,2,'tier1_paper','crop_interaction','herbivory','eatenBy',999);
  ins.run(15,1,3,'tier2_globi',null,'predation','preysOn',999);
  ins.run(16,1,null,'tier2_globi','crop_interaction','herbivory','eatenBy',999);
  return db;
}

test('getAtlasGlobiSlice returns globi edges, dedup nodes with evidence, category counts', async () => {
  const DB = d1(atlasGlobiFixture());
  const res = await getAtlasGlobiSlice(DB);
  assert.equal(res.edges.length, 4);                 // 10,11,12,13 only
  assert.ok(res.edges.every(e => e.provenance === 'globi'));
  assert.equal(res.total, 4);
  const byId = new Map(res.nodes.map(n => [n.id, n]));
  assert.equal(byId.get(1).evidence, 145);           // 100+40+5
  assert.equal(byId.get(2).evidence, 130);           // 100+25+5
  assert.equal(byId.get(3).evidence, 65);            // 40+25
  assert.equal(byId.get(1).taxonomy_path, 'Plantae|A');
  const cat = new Map(res.categories.map(c => [c.category, c.n]));
  assert.equal(cat.get('herbivory'), 2);             // 10,13
  assert.equal(cat.get('mutualism'), 1);
  assert.equal(cat.get('predation'), 1);
});

test('getAtlasGlobiSlice cap limits edges by interaction_count desc; total is pre-cap', async () => {
  const DB = d1(atlasGlobiFixture());
  const res = await getAtlasGlobiSlice(DB, { cap: 2 });
  assert.equal(res.edges.length, 2);
  assert.equal(res.cap, 2);
  assert.deepEqual(res.edges.map(e => e.id), [10, 11]);  // counts 100, 40
  assert.equal(res.total, 4);
});

test('getAtlasGlobiSlice empty when no tier2 globi', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT, common_name TEXT, bio_category TEXT, primary_role TEXT, taxonomy_path TEXT);`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, data_tier TEXT, chain_role TEXT, interaction_category TEXT, interaction_type_raw TEXT, interaction_count INTEGER);`);
  const res = await getAtlasGlobiSlice(d1(db));
  assert.equal(res.edges.length, 0);
  assert.equal(res.nodes.length, 0);
  assert.equal(res.total, 0);
});

test('getCropGlobiCounts: per-plant incident counts, global + country + subdivision filtered', async () => {
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, bio_category TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, data_tier TEXT, chain_role TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  raw.prepare("INSERT INTO entities VALUES (1,'plantae'),(2,'invertebrate'),(3,'plantae')").run();
  raw.prepare("INSERT INTO claims VALUES (10,1,2,'tier2_globi','crop_interaction'),(11,1,3,'tier2_globi','biocontrol')").run();
  raw.prepare("INSERT INTO claim_localities VALUES (10,'India','Tamil Nadu'),(10,'United States',''),(11,'Brazil','')").run();
  const { getCropGlobiCounts } = await import('./queries-d1.ts');
  const DB = d1(raw);

  const all = (await getCropGlobiCounts(DB, {})).counts;
  const m = new Map(all.map(r => [r.id, r.n]));
  assert.equal(m.get(1), 2);
  assert.equal(m.get(3), 1);
  assert.equal(m.get(2), undefined);

  const india = (await getCropGlobiCounts(DB, { country: 'India' })).counts;
  assert.deepEqual(india, [{ id: 1, n: 1 }]);

  const tn = (await getCropGlobiCounts(DB, { country: 'India', subdivision: 'Tamil Nadu' })).counts;
  assert.deepEqual(tn, [{ id: 1, n: 1 }]);

  const brazil = (await getCropGlobiCounts(DB, { country: 'Brazil' })).counts;
  assert.deepEqual(brazil.sort((a,b)=>a.id-b.id), [{ id: 1, n: 1 }, { id: 3, n: 1 }]);
  raw.close();
});

test('getCropGlobiCounts: a claim with multiple subdivisions in one country counts ONCE under a country filter', async () => {
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, bio_category TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, data_tier TEXT, chain_role TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  raw.prepare("INSERT INTO entities VALUES (1,'plantae'),(2,'invertebrate')").run();
  raw.prepare("INSERT INTO claims VALUES (10,1,2,'tier2_globi','crop_interaction')").run();
  // ONE claim, occurrences across TWO Indian subdivisions -> two claim_localities rows.
  raw.prepare("INSERT INTO claim_localities VALUES (10,'India','Tamil Nadu'),(10,'India','Karnataka')").run();
  const { getCropGlobiCounts } = await import('./queries-d1.ts');
  const DB = d1(raw);
  const india = (await getCropGlobiCounts(DB, { country: 'India' })).counts;
  assert.deepEqual(india, [{ id: 1, n: 1 }]);  // NOT 2 — the JOIN must not multiply the claim
  raw.close();
});

test('getCropWebGlobi region filter prunes both rings via claim_localities (EXISTS, not JOIN)', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
      common_name TEXT, bio_category TEXT, primary_role TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
      interaction_type_raw TEXT, interaction_category TEXT, chain_role TEXT, interaction_count INTEGER, data_tier TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  db.prepare("INSERT INTO entities VALUES (1,'crop','Crop',null,'plantae','crop'),(2,'pesta','PestA',null,'invertebrate',null),(3,'pestb','PestB',null,'invertebrate',null),(4,'pred','Pred',null,'invertebrate',null)").run();
  db.prepare(`INSERT INTO claims VALUES
    (10,2,1,'eats','herbivory','crop_interaction',50,'tier2_globi'),
    (11,3,1,'eats','herbivory','crop_interaction',40,'tier2_globi'),
    (12,4,2,'eats','predation','biocontrol',30,'tier2_globi')`).run();
  db.prepare("INSERT INTO claim_localities VALUES (10,'India','Tamil Nadu'),(10,'India','Karnataka'),(11,'Brazil',''),(12,'India','')").run();
  const { getCropWebGlobi } = await import('./queries-d1.ts');
  const DB = d1(db);

  const all = await getCropWebGlobi(DB, { id: 1, slug: 'crop' });
  assert.equal(all.capped.tier1_total, 2);

  const india = await getCropWebGlobi(DB, { id: 1, slug: 'crop' }, { country: 'India' });
  assert.equal(india.capped.tier1_total, 1);
  assert.equal(india.edges.filter(e => e.subject_id === 2 && e.object_id === 1).length, 1);
  assert.ok(india.nodes.some(n => n.id === 4 && n.depth === 2));

  const brazil = await getCropWebGlobi(DB, { id: 1, slug: 'crop' }, { country: 'Brazil' });
  assert.equal(brazil.capped.tier1_total, 1);
  assert.ok(!brazil.nodes.some(n => n.id === 4));
  db.close();
});

test('getCropGlobiCounts: countries[] filters to member-country claims (literals, not binds)', async () => {
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, bio_category TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, data_tier TEXT, chain_role TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  raw.prepare("INSERT INTO entities VALUES (1,'plantae'),(2,'invertebrate')").run();
  raw.prepare("INSERT INTO claims VALUES (10,1,2,'tier2_globi','crop_interaction'),(11,1,2,'tier2_globi','crop_interaction')").run();
  raw.prepare("INSERT INTO claim_localities VALUES (10,'India',''),(10,'Japan',''),(11,'Brazil','')").run();
  const { getCropGlobiCounts } = await import('./queries-d1.ts');
  const DB = d1(raw);
  const asia = (await getCropGlobiCounts(DB, { countries: ['India','Japan'] })).counts;
  assert.deepEqual(asia, [{ id: 1, n: 1 }]);
});

test('getCropWebGlobi: countries[] prunes both rings to member-country claims', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT, common_name TEXT, bio_category TEXT, primary_role TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, interaction_type_raw TEXT, interaction_category TEXT, chain_role TEXT, interaction_count INTEGER, data_tier TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  db.prepare("INSERT INTO entities VALUES (1,'crop','Crop',null,'plantae','crop'),(2,'pa','PestA',null,'invertebrate',null),(3,'pb','PestB',null,'invertebrate',null)").run();
  db.prepare(`INSERT INTO claims VALUES
    (10,2,1,'eats','herbivory','crop_interaction',50,'tier2_globi'),
    (11,3,1,'eats','herbivory','crop_interaction',40,'tier2_globi')`).run();
  db.prepare("INSERT INTO claim_localities VALUES (10,'India',''),(11,'Brazil','')").run();
  const { getCropWebGlobi } = await import('./queries-d1.ts');
  const DB = d1(db);
  const asia = await getCropWebGlobi(DB, { id: 1, slug: 'crop' }, { countries: ['India','Japan'] });
  assert.equal(asia.capped.tier1_total, 1);
  assert.ok(asia.nodes.some(n => n.id === 2));
  assert.ok(!asia.nodes.some(n => n.id === 3));
});

// ── normalizeInteractionRow: region + citation per provenance ───────────────
// Minimal helper to build an InteractionSqlRow with sensible defaults.
function sqlRow(over = {}) {
  return {
    id: 1, interaction_category: 'pollination', interaction_type_raw: 'pollinates',
    interaction_type_globi: null, review_status: null, data_tier: 'tier2_globi',
    source_quote: null, reference_url: null, reference_citation: null, reference_doi: null,
    regional_context: null, country: null, subdivision: null,
    subject_entity_id: 1, object_entity_id: 2,
    source_authors: null, source_year: null, source_title: null, source_slug: null,
    source_id: null, effect_direction: null,
    subject_name: 'Apis mellifera', subject_common: 'honey bee', subject_slug: 'apis-mellifera',
    object_name: 'Malus domestica', object_common: 'apple', object_slug: 'malus-domestica',
    globi_countries: null, verdicts: null, mod_count: 0, ...over,
  };
}

test('normalizeInteractionRow: literature row takes region from regional_context, builds author-year citation', () => {
  const r = normalizeInteractionRow(sqlRow({
    review_status: 'ai_reviewed', data_tier: 'tier1_paper', source_quote: 'bees pollinate apple',
    regional_context: 'Guam', source_authors: 'Smith', source_year: 2020,
  }), 1);
  assert.equal(r.provenance, 'literature');
  assert.equal(r.region, 'Guam');
  assert.equal(r.citation, 'Smith (2020)');
  assert.equal(r.referenceCitation, null);
  assert.equal(r.observationUrl, null);
});

test('normalizeInteractionRow: globi row takes region from claim_localities concat, citation from reference_citation', () => {
  const r = normalizeInteractionRow(sqlRow({
    globi_countries: 'United States,Brazil,India,Japan',
    reference_citation: 'Jones 2011. Bee interactions dataset.', reference_doi: '10.1/x',
  }), 1);
  assert.equal(r.provenance, 'globi');
  assert.equal(r.region, 'Brazil, India +2');  // >2 → alphabetical, first two + "+N" (Brazil,India,Japan,United States)
  assert.equal(r.referenceCitation, 'Jones 2011. Bee interactions dataset.');
  assert.equal(r.referenceDoi, '10.1/x');
  assert.equal(r.citation, null);                        // globi has no author-year citation
});

test('normalizeInteractionRow: globi region formatting — empty/one/two/null cases', () => {
  assert.equal(normalizeInteractionRow(sqlRow({ globi_countries: null }), 1).region, null);
  assert.equal(normalizeInteractionRow(sqlRow({ globi_countries: '' }), 1).region, null);
  assert.equal(normalizeInteractionRow(sqlRow({ globi_countries: 'Fiji' }), 1).region, 'Fiji');
  assert.equal(normalizeInteractionRow(sqlRow({ globi_countries: 'Fiji,Guam' }), 1).region, 'Fiji, Guam');
});

test('normalizeInteractionRow: direction is "in" when entity is the object', () => {
  const r = normalizeInteractionRow(sqlRow({}), 2);  // entityId 2 == object_entity_id
  assert.equal(r.direction, 'in');
  assert.equal(r.partnerName, 'Apis mellifera');     // partner is the subject
});

// ── getInteractionRows: SQL joins claim_localities + reads regional_context ──
test('getInteractionRows: lit region from regional_context, globi region from claim_localities', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT, slug TEXT);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, authors TEXT, year INTEGER, title TEXT, slug TEXT);
    CREATE TABLE claim_critic_verdicts (staging_id INTEGER, critic_name TEXT, verdict TEXT);
    CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
      source_id INTEGER, staging_id INTEGER, data_tier TEXT, review_status TEXT, chain_role TEXT,
      interaction_category TEXT, interaction_type_raw TEXT, interaction_type_globi TEXT,
      effect_direction TEXT, source_quote TEXT, reference_url TEXT, reference_citation TEXT, reference_doi TEXT,
      regional_context TEXT, country TEXT, subdivision TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  db.prepare("INSERT INTO entities VALUES (1,'Apis mellifera','honey bee','apis-mellifera'),(2,'Malus domestica','apple','malus-domestica')").run();
  db.prepare("INSERT INTO sources VALUES (100,'Smith',2020,'Bee Study','bee-study')").run();
  // literature claim: region in regional_context
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,source_id,data_tier,review_status,interaction_category,interaction_type_raw,source_quote,regional_context)
    VALUES (10,1,2,100,'tier1_paper','ai_reviewed','pollination','pollinates','bees pollinate apple','Guam')`).run();
  // globi claim: region in claim_localities (3 countries), citation in reference_citation
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,review_status,chain_role,interaction_category,interaction_type_raw,reference_citation)
    VALUES (20,1,2,'tier2_globi','unreviewed','crop_interaction','pollination','visitsFlowersOf','Jones 2011 dataset')`).run();
  db.prepare("INSERT INTO claim_localities VALUES (20,'United States',''),(20,'Brazil',''),(20,'India','')").run();
  const DB = d1(db);

  const rows = await getInteractionRows(DB, 1);
  const lit = rows.find(r => r.id === 10);
  const globi = rows.find(r => r.id === 20);
  assert.equal(lit.region, 'Guam');
  assert.equal(lit.citation, 'Smith (2020)');
  assert.equal(globi.provenance, 'globi');
  assert.equal(globi.region, 'Brazil, India +1');  // 3 countries → first two + "+1" (PK alphabetical scan order)
  assert.equal(globi.referenceCitation, 'Jones 2011 dataset');
  db.close();
});

// A claim observed across multiple subdivisions of ONE country has multiple
// claim_localities rows with the same country. GROUP_CONCAT(DISTINCT country)
// must collapse them — region shows the country once, not "India, India".
test('getInteractionRows: multi-subdivision claim dedups the country in the region cell', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT, slug TEXT);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, authors TEXT, year INTEGER, title TEXT, slug TEXT);
    CREATE TABLE claim_critic_verdicts (staging_id INTEGER, critic_name TEXT, verdict TEXT);
    CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
      source_id INTEGER, staging_id INTEGER, data_tier TEXT, review_status TEXT, chain_role TEXT,
      interaction_category TEXT, interaction_type_raw TEXT, interaction_type_globi TEXT,
      effect_direction TEXT, source_quote TEXT, reference_url TEXT, reference_citation TEXT, reference_doi TEXT,
      regional_context TEXT, country TEXT, subdivision TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  db.prepare("INSERT INTO entities VALUES (1,'Apis mellifera','honey bee','apis-mellifera'),(2,'Malus domestica','apple','malus-domestica')").run();
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,review_status,chain_role,interaction_category,interaction_type_raw)
    VALUES (20,1,2,'tier2_globi','unreviewed','crop_interaction','pollination','visitsFlowersOf')`).run();
  // ONE claim, India under TWO subdivisions + Brazil → India must appear once.
  db.prepare("INSERT INTO claim_localities VALUES (20,'India','Tamil Nadu'),(20,'India','Karnataka'),(20,'Brazil','')").run();
  const DB = d1(db);

  const globi = (await getInteractionRows(DB, 1)).find(r => r.id === 20);
  assert.equal(globi.region, 'Brazil, India');  // 2 distinct countries — NOT "Brazil, India, India"
  db.close();
});

// ── getGlobiClaimById: served-GloBI guard + localities ──────────────────────
function globiClaimFixture() {
  // Uses the top-level `import Database from 'better-sqlite3'` (this is an ES
  // module — `require` is not available here).
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT, slug TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
      data_tier TEXT, review_status TEXT, chain_role TEXT, interaction_category TEXT,
      interaction_type_raw TEXT, reference_citation TEXT, reference_doi TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  db.prepare("INSERT INTO entities VALUES (1,'Apis mellifera','honey bee','apis-mellifera'),(2,'Malus domestica','apple','malus-domestica')").run();
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,review_status,chain_role,interaction_category,interaction_type_raw,reference_citation,reference_doi)
    VALUES (20,1,2,'tier2_globi','unreviewed','crop_interaction','pollination','visitsFlowersOf','Jones 2011 dataset','10.5/abc')`).run();
  // a literature claim sharing the id-space — must 404 from the globi route
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,review_status,interaction_category,interaction_type_raw)
    VALUES (30,1,2,'tier1_paper','ai_reviewed','pollination','pollinates')`).run();
  db.prepare("INSERT INTO claim_localities VALUES (20,'Brazil',''),(20,'India','Kerala')").run();
  return db;
}

test('getGlobiClaimById returns the pair, verb, citation and full locality list', async () => {
  const raw = globiClaimFixture();
  const c = await getGlobiClaimById(d1(raw), 20);
  assert.equal(c.subjectName, 'Apis mellifera');
  assert.equal(c.objectName, 'Malus domestica');
  assert.equal(c.objectSlug, 'malus-domestica');
  assert.equal(c.verb, 'visitsFlowersOf');
  assert.equal(c.referenceCitation, 'Jones 2011 dataset');
  assert.equal(c.referenceDoi, '10.5/abc');
  assert.equal(c.localities.length, 2);
  assert.deepEqual(c.localities[0], { country: 'Brazil', subdivision: '' });
  assert.deepEqual(c.localities[1], { country: 'India', subdivision: 'Kerala' });
  raw.close();
});

test('getGlobiClaimById returns null for a literature claim id (404 guard)', async () => {
  const raw = globiClaimFixture();
  const DB = d1(raw);
  assert.equal(await getGlobiClaimById(DB, 30), null);  // tier1_paper → not a served GloBI claim
  assert.equal(await getGlobiClaimById(DB, 999), null); // unknown id
  raw.close();
});

test('getGlobiClaimById returns the claim with localities:[] when it has no localities', async () => {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT, slug TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
      data_tier TEXT, review_status TEXT, chain_role TEXT, interaction_category TEXT,
      interaction_type_raw TEXT, reference_citation TEXT, reference_doi TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
  `);
  raw.prepare("INSERT INTO entities VALUES (1,'Apis mellifera','honey bee','apis-mellifera'),(2,'Malus domestica','apple','malus-domestica')").run();
  raw.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,data_tier,review_status,chain_role,interaction_category,interaction_type_raw)
    VALUES (40,1,2,'tier2_globi','unreviewed','crop_interaction','pollination','visitsFlowersOf')`).run();
  const c = await getGlobiClaimById(d1(raw), 40);
  assert.notEqual(c, null);                 // claim exists → not a 404
  assert.deepEqual(c.localities, []);       // no claim_localities rows → empty array, not null
  raw.close();
});

test('normalizeInteractionRow exposes sourceId, effectDirection, subjectName, objectName', () => {
  const r = normalizeInteractionRow(sqlRow({
    review_status: 'ai_reviewed',
    subject_entity_id: 1, object_entity_id: 2,
    source_id: 6, effect_direction: 'negative',
    subject_name: 'Pumpkin beetle', object_name: 'Bottle gourd',
  }), 1);
  assert.equal(r.sourceId, 6);
  assert.equal(r.effectDirection, 'negative');
  assert.equal(r.subjectName, 'Pumpkin beetle');
  assert.equal(r.objectName, 'Bottle gourd');
});

// ── getTraitRows: inherited provenance ─────────────────────────────────────
function traitFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
      common_name TEXT, bio_category TEXT);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, authors TEXT,
      year INTEGER, url TEXT);
    CREATE TABLE entity_trait_claims (
      id INTEGER PRIMARY KEY, entity_id INTEGER, trait_name TEXT,
      value_numeric REAL, value_text TEXT, value_json TEXT, unit TEXT,
      source_quote TEXT, source_page INTEGER, regional_context TEXT,
      source_id INTEGER, review_status TEXT,
      inherited_from_entity_id INTEGER
    );
  `);
  db.prepare(`INSERT INTO entities (id,slug,scientific_name) VALUES
    (10,'solanum-lycopersicum','Solanum lycopersicum'),
    (99,'test-variety','Test Variety')`).run();
  db.prepare(`INSERT INTO sources (id,slug,title,authors,year) VALUES (200,'src','Source','Auth',2024)`).run();
  // trait with inheritance
  db.prepare(`INSERT INTO entity_trait_claims
    (id,entity_id,trait_name,value_numeric,value_text,value_json,unit,source_quote,source_page,regional_context,source_id,review_status,inherited_from_entity_id)
    VALUES (7,99,'ph_min',5.5,null,null,null,null,null,null,200,'ai_reviewed',10)`).run();
  // trait without inheritance
  db.prepare(`INSERT INTO entity_trait_claims
    (id,entity_id,trait_name,value_numeric,value_text,value_json,unit,source_quote,source_page,regional_context,source_id,review_status,inherited_from_entity_id)
    VALUES (8,99,'days_to_harvest',null,'90',null,'days',null,null,null,200,'ai_reviewed',null)`).run();
  return db;
}

test('getTraitRows surfaces inherited_from_entity_id, name, and slug', async () => {
  const { getTraitRows } = await import('./queries-d1.ts');
  const DB = d1(traitFixture());
  const rows = await getTraitRows(DB, 99);
  const inherited = rows.find(r => r.trait === 'ph_min');
  assert.equal(inherited.inheritedFromEntityId, 10);
  assert.equal(inherited.inheritedFromName, 'Solanum lycopersicum');
  assert.equal(inherited.inheritedFromSlug, 'solanum-lycopersicum');
  const direct = rows.find(r => r.trait === 'days_to_harvest');
  assert.equal(direct.inheritedFromEntityId, null);
  assert.equal(direct.inheritedFromName, null);
  assert.equal(direct.inheritedFromSlug, null);
});

// ── variety queries ─────────────────────────────────────────────────────────
function varietyFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT, common_name TEXT,
      parent_entity_id INTEGER, variety_type TEXT, grin_accession TEXT, scope_tier TEXT
    );
  `);
  // parent species (id=10) — no parent_entity_id
  db.prepare(`INSERT INTO entities VALUES (10,'solanum-lycopersicum','Solanum lycopersicum','tomato',NULL,NULL,NULL,NULL)`).run();
  // served varieties (scope_tier IS NOT NULL)
  db.prepare(`INSERT INTO entities VALUES (20,'brandywine','Solanum lycopersicum ''Brandywine''',NULL,10,'cultivar','PI 1234','species')`).run();
  db.prepare(`INSERT INTO entities VALUES (21,'cherokee-purple','Solanum lycopersicum ''Cherokee Purple''',NULL,10,'cultivar',NULL,'species')`).run();
  db.prepare(`INSERT INTO entities VALUES (22,'guam-red','Solanum lycopersicum ''Guam Red''',NULL,10,'landrace','PI 5678','species')`).run();
  // unserved variety (scope_tier IS NULL) — must be excluded from variety queries
  db.prepare(`INSERT INTO entities VALUES (23,'unserved-var','Solanum lycopersicum ''Unserved''',NULL,10,'cultivar',NULL,NULL)`).run();
  return db;
}

test('getParentSummary returns slug/scientific_name/common_name for a known id', async () => {
  const { getParentSummary } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  const parent = await getParentSummary(DB, 10);
  assert.equal(parent.slug, 'solanum-lycopersicum');
  assert.equal(parent.scientific_name, 'Solanum lycopersicum');
  assert.equal(parent.common_name, 'tomato');
});

test('getParentSummary returns null for unknown id', async () => {
  const { getParentSummary } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  assert.equal(await getParentSummary(DB, 999), null);
});

test('getVarietyTypeCounts groups served children by variety_type, excludes scope_tier=NULL', async () => {
  const { getVarietyTypeCounts } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  const counts = await getVarietyTypeCounts(DB, 10);
  // 2 cultivar (ids 20,21) + 1 landrace (id 22); id 23 is unserved → excluded
  const cultivar = counts.find(c => c.variety_type === 'cultivar');
  const landrace = counts.find(c => c.variety_type === 'landrace');
  assert.equal(cultivar.n, 2);
  assert.equal(landrace.n, 1);
  assert.equal(counts.length, 2);
});

test('getVarietyTypeCounts returns [] for a species with no served varieties', async () => {
  const { getVarietyTypeCounts } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  const counts = await getVarietyTypeCounts(DB, 999);
  assert.deepEqual(counts, []);
});

test('getVarietiesForSpecies returns served varieties ordered by scientific_name', async () => {
  const { getVarietiesForSpecies } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  const rows = await getVarietiesForSpecies(DB, 10);
  // brandywine < cherokee-purple < guam-red alphabetically; unserved excluded
  assert.equal(rows.length, 3);
  assert.equal(rows[0].slug, 'brandywine');
  assert.equal(rows[0].grin_accession, 'PI 1234');
  assert.equal(rows[0].variety_type, 'cultivar');
});

test('getVarietiesForSpecies paginates via limit/offset', async () => {
  const { getVarietiesForSpecies } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  const page1 = await getVarietiesForSpecies(DB, 10, { limit: 2, offset: 0 });
  const page2 = await getVarietiesForSpecies(DB, 10, { limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 1);
  assert.equal(page2[0].slug, 'guam-red');
});

test('getVarietiesForSpecies clamps limit to 200', async () => {
  const { getVarietiesForSpecies } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  // Requesting limit 9999 should still return all 3 served varieties (≤200 anyway)
  const rows = await getVarietiesForSpecies(DB, 10, { limit: 9999 });
  assert.equal(rows.length, 3);
});

test('getVarietiesForSpecies filters by type when opts.type is provided', async () => {
  const { getVarietiesForSpecies } = await import('./queries-d1.ts');
  const DB = d1(varietyFixture());
  const landraces = await getVarietiesForSpecies(DB, 10, { type: 'landrace' });
  assert.equal(landraces.length, 1);
  assert.equal(landraces[0].slug, 'guam-red');
});
