'use strict';
// Identify pending, non-passing book-corpus rows whose subject/object is a
// plant-parasitic NEMATODE or a PARASITIC PLANT — the claims the (now-corrected)
// pest-vs-pathogen convention should flip. Emits ids for reset + re-critique.
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const db = new Database(CORPUS_DB, { readonly: true });

const NEMATODE = /\b(nematode|nematoda|meloidogyne|radopholus|rotylenchulus|pratylenchus|heterodera|globodera|ditylenchus|aphelenchoides|bursaphelenchus|xiphinema|helicotylenchus|tylenchulus|hoplolaimus|scutellonema|nacobbus|belonolaimus|anguina|hirschmanniella|root[\s-]?knot|reniform|root[\s-]?lesion|cyst[\s-]+nematode|burrowing[\s-]+nematode)\b/i;
const PARASITIC = /\b(cuscuta|cassytha|orobanche|phelipanche|striga|alectra|viscum|arceuthobium|dendrophthoe|dodder|broomrape|witchweed|mistletoe)\b/i;

const rows = db.prepare(`
  WITH backlog AS (
    SELECT es.id, es.payload FROM extraction_staging es
    WHERE es.review_status='pending' AND es.source_id NOT IN (233,234)
      AND es.ai_vouch_status IN ('plausible','uncertain')),
  agg AS (
    SELECT b.id, b.payload, SUM(v.verdict='plausible') p, SUM(v.verdict='implausible') i
    FROM backlog b JOIN claim_critic_verdicts v ON v.staging_id=b.id GROUP BY b.id)
  SELECT id, payload, p, i FROM agg WHERE NOT (p>=2 AND i=0)
`).all();

const ids = [];
let nem = 0, par = 0, rejected = 0, short = 0;
for (const r of rows) {
  const flat = r.payload || '';
  const isNem = NEMATODE.test(flat), isPar = PARASITIC.test(flat);
  if (!isNem && !isPar) continue;
  ids.push(r.id);
  if (isNem) nem++; if (isPar) par++;
  if (r.i >= 1) rejected++; else short++;
}
require('fs').writeFileSync('recovery-nematode-ids.txt', ids.join(','));
console.log(`nematode/parasitic non-passing rows: ${ids.length} (nematode-matched ${nem}, parasitic ${par}; was-rejected ${rejected}, oos/short ${short})`);
console.log(`wrote ${ids.length} ids -> recovery-nematode-ids.txt`);
db.close();
