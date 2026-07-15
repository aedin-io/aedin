const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(r => r.name);
  const pick = (re) => tables.filter(t => re.test(t));

  async function schemaOf(t) {
    try { return (await db.all(`PRAGMA table_info(${t})`)).map(c => `${c.name}:${c.type}`); }
    catch (e) { return ['<error>', String(e).slice(0, 80)]; }
  }
  async function head(t, n = 2) {
    try { return await db.all(`SELECT * FROM ${t} LIMIT ${n}`); }
    catch (e) { return [{ error: String(e).slice(0, 200) }]; }
  }

  const orgT = pick(/organism|planner_org/i);
  const scoreT = pick(/score|companion/i);
  const triT = pick(/tritroph|predator|pest|beneficial|interact|claim/i);

  const out = { total_tables: tables.length, candidates: { org: orgT, score: scoreT, tri: triT }, schemas: {}, samples: {} };
  for (const t of [...orgT, ...scoreT, ...triT].slice(0, 14)) {
    out.schemas[t] = await schemaOf(t);
    out.samples[t] = await head(t, 2);
  }
  console.log(JSON.stringify(out, null, 2));
  await db.close();
})();
