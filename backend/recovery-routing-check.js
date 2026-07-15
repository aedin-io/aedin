'use strict';
// Validation: for each of the 939 near-miss rows, compare the OLD out_of_scope
// specialist (the stale verdict) to what the CURRENT (fixed) router would pick.
// Recovery only helps rows where new pick != old OOS critic.
const Database = require('better-sqlite3');
const { pickDomainCritic } = require('./lib/critic-router');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const db = new Database(CORPUS_DB, { readonly: true });

const rows = db.prepare(`
  WITH backlog AS (
    SELECT id, payload, target_table FROM extraction_staging
    WHERE review_status='pending' AND source_id NOT IN (233,234)
      AND ai_vouch_status IN ('plausible','uncertain')),
  agg AS (
    SELECT b.id, b.payload, b.target_table,
      SUM(v.verdict='plausible') p, SUM(v.verdict='implausible') i, SUM(v.verdict='out_of_scope') o
    FROM backlog b JOIN claim_critic_verdicts v ON v.staging_id=b.id GROUP BY b.id)
  SELECT id, payload, target_table FROM agg WHERE p<2 AND i=0 AND o>=1
`).all();

let diff = 0, same = 0, parseErr = 0;
const transitions = {};
for (const r of rows) {
  const oos = db.prepare(`SELECT critic_name FROM claim_critic_verdicts WHERE staging_id=? AND verdict='out_of_scope'`).all(r.id).map(x => x.critic_name);
  let payload; try { payload = JSON.parse(r.payload); } catch { parseErr++; continue; }
  const newPick = pickDomainCritic(payload, r.target_table);
  // recoverable if the new router pick is NOT among the old OOS critics
  if (oos.includes(newPick)) { same++; }
  else { diff++; const k = oos.join('|') + ' -> ' + newPick; transitions[k] = (transitions[k] || 0) + 1; }
}
console.log(`rows=${rows.length} recoverable(new!=oldOOS)=${diff} unchanged(new==oldOOS)=${same} parseErr=${parseErr}`);
console.log('top transitions (oldOOS -> newPick):');
Object.entries(transitions).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(`  ${n}  ${k}`));

// Emit the recoverable id list (new router pick differs from the stale OOS critic).
const recoverableIds = [];
for (const r of rows) {
  const oos = db.prepare(`SELECT critic_name FROM claim_critic_verdicts WHERE staging_id=? AND verdict='out_of_scope'`).all(r.id).map(x => x.critic_name);
  let payload; try { payload = JSON.parse(r.payload); } catch { continue; }
  if (!oos.includes(pickDomainCritic(payload, r.target_table))) recoverableIds.push(r.id);
}
require('fs').writeFileSync('recovery-residual-ids.txt', recoverableIds.join(','));
console.log(`wrote ${recoverableIds.length} ids -> recovery-residual-ids.txt`);
db.close();
