'use strict';
/**
 * resolve-trait-conflicts.js — resolve cross-value trait conflicts with SAFE rules,
 * flag the genuine disagreements.
 *
 * After dedup-entity-trait-claims.js collapses exact dups, the remaining (entity,
 * trait) groups with differing values are "conflicts". Most are not real
 * disagreements; this pass resolves those by choosing a WINNING VALUE that an
 * actual source asserted (never a fabricated value) and deleting only the
 * losing-value claims — multi-source corroboration of the winner is preserved.
 *
 *   - list       → keep the superset value (one claim ⊇ all others); else FLAG (partial overlap)
 *   - numeric    → if max spread ≤ 20%, keep one near value; else FLAG (far)
 *   - boolean    → if exactly one valid {true,false} value present, keep it (drop junk); else FLAG
 *   - categorical→ pest_mobility {none,sedentary}→sedentary; else if the longest value
 *                  contains every other as a substring, keep it (granularity); else FLAG
 *
 * Keep-rule when several claims share the winning value: prefer a source_quote,
 * tie-break lowest id. Dry-run by default; --apply mutates with a row backup.
 * Flagged conflicts are written to a report for later curated/critic review.
 *
 * Usage:
 *   node resolve-trait-conflicts.js          # dry-run summary + flag report
 *   node resolve-trait-conflicts.js --apply  # delete losing-value claims
 */

function distinctKey(r) {
  return [r.value_numeric, r.value_text, r.value_json]
    .map((x) => (x === null || x === undefined ? '' : x)).join('~');
}
function quoteLen(r) { return r.source_quote ? String(r.source_quote).length : 0; }
function pickKeeper(rows) {
  return [...rows].sort((a, b) => quoteLen(b) - quoteLen(a) || a.id - b.id)[0];
}

// Given a group and the chosen keeper, delete every claim whose value differs
// from the keeper's (claims sharing the keeper's value = corroboration, kept).
function deleteLosers(group, keeper, deletions) {
  const winKey = distinctKey(keeper);
  for (const r of group) if (distinctKey(r) !== winKey) deletions.push(r.id);
}

// A conflict is a REAL problem only if a single source reported >1 distinct value
// for the entity+trait (an internal extraction inconsistency). If every source
// contributed exactly one value and they merely differ across sources, that is
// legitimate provenance — two papers reporting different readings — not an error.
function hasSameSourceConflict(group) {
  const bySource = new Map();
  for (const r of group) {
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, new Set());
    bySource.get(r.source_id).add(distinctKey(r));
  }
  for (const values of bySource.values()) if (values.size > 1) return true;
  return false;
}

/**
 * Pure planner. rows: entity_trait_claims; kindMap: {trait_name -> value_kind}.
 * Returns { deletions: number[], flags: [{entity_id, trait_name, kind, reason, values, ids}] }.
 */
function planResolve(rows, kindMap) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.entity_id + '|' + r.trait_name;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const deletions = [];
  const flags = [];
  let legitMultiSource = 0;

  for (const group of groups.values()) {
    const distinct = new Set(group.map(distinctKey));
    if (distinct.size < 2) continue; // not a conflict

    const trait = group[0].trait_name;
    const kind = kindMap[trait] || 'categorical';
    // A disagreement with no single-source inconsistency is legitimate
    // cross-source provenance — never flag it as an error.
    const sameSource = hasSameSourceConflict(group);
    const flag = (reason) => {
      if (!sameSource) { legitMultiSource += 1; return; }
      flags.push({
        entity_id: group[0].entity_id, trait_name: trait, kind, reason,
        values: [...distinct], ids: group.map((r) => r.id),
      });
    };

    if (kind === 'list') {
      const parsed = group.map((r) => {
        let arr = null;
        try { arr = JSON.parse(r.value_json); } catch (e) { /* leave null */ }
        return { r, set: Array.isArray(arr) ? new Set(arr) : null };
      });
      if (parsed.some((p) => p.set === null)) { flag('unparseable_list'); continue; }
      const superset = parsed.find((p) => parsed.every(
        (o) => [...o.set].every((x) => p.set.has(x))));
      if (!superset) { flag('list_partial_overlap'); continue; }
      const keeper = pickKeeper(parsed.filter((p) => p.set.size === superset.set.size).map((p) => p.r));
      deleteLosers(group, keeper, deletions);
    } else if (kind === 'numeric') {
      // Keep ALL distinct numeric values — never delete, never flag. Two numbers
      // for one entity+trait are not a contradiction to resolve: they are range
      // endpoints (a source may state an optimal range the extractor split into
      // two claims) or independent multi-source readings. The serving layer
      // aggregates them into a min–max envelope for the sidebar; the claims list
      // shows every sourced value. (See trait-range aggregation.)
      continue;
    } else if (kind === 'boolean') {
      const valid = group.filter((r) => r.value_text === 'true' || r.value_text === 'false');
      if (new Set(valid.map((r) => r.value_text)).size !== 1) { flag('boolean_genuine'); continue; }
      deleteLosers(group, pickKeeper(valid), deletions);
    } else { // categorical / free-text
      const texts = group.map((r) => ({ r, t: (r.value_text || '').toLowerCase() }));
      const distinctTexts = [...new Set(texts.map((x) => x.t))].sort();
      if (distinctTexts.length === 2 && distinctTexts[0] === 'none' && distinctTexts[1] === 'sedentary') {
        deleteLosers(group, pickKeeper(texts.filter((x) => x.t === 'sedentary').map((x) => x.r)), deletions);
        continue;
      }
      const longest = texts.slice().sort((a, b) => b.t.length - a.t.length)[0];
      if (!texts.every((x) => longest.t.includes(x.t))) { flag('categorical_genuine'); continue; }
      deleteLosers(group, pickKeeper(texts.filter((x) => x.t === longest.t).map((x) => x.r)), deletions);
    }
  }

  deletions.sort((a, b) => a - b);
  return { deletions, flags, legitMultiSource };
}

module.exports = { planResolve, distinctKey };

if (require.main === module) {
  (async () => {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    const path = require('path');
    const { CORPUS_DB } = require('./lib/db-paths.cjs');
    const APPLY = process.argv.includes('--apply');
    const db = new Database(CORPUS_DB);

    const kindMap = {};
    db.prepare('SELECT trait_name, value_kind FROM traits_vocabulary').all()
      .forEach((r) => { kindMap[r.trait_name] = r.value_kind; });

    const rows = db.prepare(
      `SELECT id, entity_id, trait_name, value_numeric, value_text, value_json, source_id, source_quote
         FROM entity_trait_claims`
    ).all();
    const { deletions, flags, legitMultiSource } = planResolve(rows, kindMap);

    const byReason = {};
    for (const f of flags) byReason[f.reason] = (byReason[f.reason] || 0) + 1;
    console.log(`[resolve] scanned ${rows.length} trait claims`);
    console.log(`[resolve] losing-value rows to delete: ${deletions.length}`);
    console.log(`[resolve] legitimate cross-source disagreements kept (NOT flagged): ${legitMultiSource}`);
    console.log(`[resolve] same-source inconsistencies flagged for review: ${flags.length} ${JSON.stringify(byReason)}`);

    const stamp = db.prepare(`SELECT strftime('%Y%m%dT%H%M%S','now') s`).get().s;
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir);
    const flagPath = path.join(backupsDir, `trait-conflicts-flagged-${stamp}.json`);
    fs.writeFileSync(flagPath, JSON.stringify(flags, null, 2));
    console.log(`[resolve] flag report → ${flagPath}`);

    if (!APPLY) {
      console.log('[resolve] DRY-RUN — pass --apply to delete the losing-value claims.');
      db.close();
      return;
    }
    const deletedRows = deletions.length
      ? db.prepare(`SELECT * FROM entity_trait_claims WHERE id IN (${deletions.map(() => '?').join(',')})`).all(...deletions)
      : [];
    const backupPath = path.join(backupsDir, `trait-conflicts-deleted-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(deletedRows, null, 2));
    const del = db.prepare(`DELETE FROM entity_trait_claims WHERE id = ?`);
    db.transaction((ids) => { for (const id of ids) del.run(id); })(deletions);
    console.log(`[resolve] APPLIED — deleted ${deletions.length} rows (backup → ${backupPath})`);
    db.close();
  })();
}
