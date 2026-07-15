'use strict';
/**
 * coverage-gap-report.js  —  Month-0 task 3 of the BD plan (commercial-bd-plan.md §6).
 *
 * "Given a list of target crops × regions × subject axes, here is claim coverage per
 *  cell, ranked by gap." The controller that decides which OA repository to drain next:
 *  ingest by repository, prioritize by coverage cell.
 *
 * Cells = crop × pressure-axis (pest / pathogen / beneficial), filtered to a region focus
 * (US-applicable by default; Pacific or all selectable). Region is reported as a coverage
 * summary, not a per-state matrix — at current volume per-state cells are mostly empty;
 * that granularity activates near the 25-31K MVP target.
 *
 * Usage:
 *   node coverage-gap-report.js [--region=US|Pacific|all] [--vertical=commodity|specialty|all]
 *                               [--min-claims=N] [--top=N] [--json]
 *
 * Read-only against globi.sqlite. No writes, no network, low memory.
 */
const Database = require('better-sqlite3');
const path = require('path');
const { normalizeRegion } = require('./lib/region-normalize');
const CFG = require('./coverage-targets.json');

// ---- args ----
const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const REGION = flag('region', 'US');
const VERTICAL = flag('vertical', 'all');
const MIN_CLAIMS = parseInt(flag('min-claims', '0'), 10) || 0;
const TOP = parseInt(flag('top', '40'), 10) || 40;
const JSON_OUT = args.includes('--json');
const GAP = CFG.gapThreshold || 15;

const focus = CFG.regionFocus[REGION];
if (!focus) { console.error(`unknown --region=${REGION}; choose ${Object.keys(CFG.regionFocus).join(' | ')}`); process.exit(1); }

// category -> axis lookup
const AXIS = {};
for (const [axis, cats] of Object.entries(CFG.axisRollup)) for (const c of cats) AXIS[c] = axis;
const axisOf = (cat) => AXIS[cat] || 'other';

const db = new Database(path.join(__dirname, 'globi.sqlite'), { readonly: true });

// ---- crop entity set + labels ----
// Crop = role-tagged crop (unconditional, survives taxonomy-corruption mislabels like
// Lycopersicon->invertebrate) OR a plant carrying an edibility/crop tag. The bio_category
// gate keeps stray edible-tagged arthropods (sunflower moth, leafhoppers) out of the set.
const cropRows = db.prepare(`
  SELECT id, scientific_name, genus FROM entities
  WHERE primary_role='crop'
     OR (bio_category='plantae' AND (crop_type IS NOT NULL OR edible IS NOT NULL OR vegetable IS NOT NULL))`).all();
const cropset = new Set(cropRows.map(r => r.id));
const sciName = new Map(cropRows.map(r => [r.id, r.scientific_name || `entity#${r.id}`]));

// ---- region focus test + bucketing ----
function regionParts(raw) {
  if (!raw) return [{ norm: normalizeRegion(null), raw: null }];
  return String(raw).split(/\s*(?:,|\/|\band\b)\s*/i).map(p => p.trim()).filter(Boolean)
    .map(p => ({ norm: normalizeRegion(p), raw: p }));
}
function inFocus(parts) {
  if (focus.matchAll) return true;
  for (const { norm, raw } of parts) {
    if (focus.includeGlobal && raw === 'Global') return true;
    if (norm.country && focus.countries.includes(norm.country)) return true;
    if (norm.scopes.some(s => focus.scopes.includes(s))) return true;
  }
  return false;
}
function bucket(parts) {
  for (const { norm, raw } of parts) {
    if (norm.subdivision) return norm.subdivision;
    if (norm.country) return norm.country;
    if (raw === 'Global') return 'Global';
    if (norm.scopes.length) return norm.scopes[0];
  }
  return parts[0] && parts[0].raw ? parts[0].raw : '(no region)';
}

// ---- scan ai_reviewed claims ----
const claims = db.prepare(`
  SELECT subject_entity_id sid, object_entity_id oid, interaction_category cat, regional_context rc
  FROM claims WHERE review_status='ai_reviewed'`).all();

const cropAgg = new Map();   // crop_id -> {pest,pathogen,beneficial,other,total, regions:Set}
const regionAgg = new Map(); // bucket -> {total, crops:Set}
let scannedInFocus = 0;

for (const c of claims) {
  const parts = regionParts(c.rc);
  if (!inFocus(parts)) continue;
  scannedInFocus++;
  const axis = axisOf(c.cat);
  const b = bucket(parts);

  // crop endpoint: both->subject tie-break; else whichever is crop-tagged
  let crop = null;
  const sIn = cropset.has(c.sid), oIn = cropset.has(c.oid);
  if (sIn) crop = c.sid; else if (oIn) crop = c.oid;

  if (crop != null) {
    let a = cropAgg.get(crop);
    if (!a) { a = { pest: 0, pathogen: 0, beneficial: 0, other: 0, total: 0, regions: new Set() }; cropAgg.set(crop, a); }
    a[axis]++; a.total++; a.regions.add(b);
    let r = regionAgg.get(b);
    if (!r) { r = { total: 0, crops: new Set() }; regionAgg.set(b, r); }
    r.total++; r.crops.add(crop);
  } else {
    let r = regionAgg.get(b);
    if (!r) { r = { total: 0, crops: new Set() }; regionAgg.set(b, r); }
    r.total++;
  }
}

// ---- resolve curated targets -> entity id sets ----
function resolveTarget(matchList) {
  const ids = new Set();
  for (const v of matchList) {
    let rows;
    if (v.includes(' ')) {
      rows = db.prepare(`SELECT id FROM entities WHERE scientific_name=? OR scientific_name LIKE ?`).all(v, v + ' %');
    } else {
      rows = db.prepare(`SELECT id FROM entities WHERE genus=? OR scientific_name=? OR scientific_name LIKE ?`).all(v, v, v + ' %');
    }
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}
const verticals = VERTICAL === 'all' ? Object.keys(CFG.verticals) : [VERTICAL];
const targetReport = [];
for (const vert of verticals) {
  for (const t of (CFG.verticals[vert] || [])) {
    const ids = resolveTarget(t.match);
    const acc = { pest: 0, pathogen: 0, beneficial: 0, other: 0, total: 0, regions: new Set() };
    for (const c of claims) {
      if (!(ids.has(c.sid) || ids.has(c.oid))) continue;
      const parts = regionParts(c.rc);
      if (!inFocus(parts)) continue;
      acc[axisOf(c.cat)]++; acc.total++; acc.regions.add(bucket(parts));
    }
    targetReport.push({ vertical: vert, label: t.label, ...acc, regions: acc.regions.size, gap: acc.total < GAP });
  }
}
targetReport.sort((a, b) => a.total - b.total);

// ---- crop coverage table ----
const cropTable = [...cropAgg.entries()]
  .map(([id, a]) => ({ crop: sciName.get(id) || `entity#${id}`, ...a, regions: a.regions.size }))
  .filter(r => r.total >= MIN_CLAIMS)
  .sort((a, b) => a.total - b.total);

const regionTable = [...regionAgg.entries()]
  .map(([b, r]) => ({ region: b, total: r.total, crops: r.crops.size }))
  .sort((a, b) => b.total - a.total);

// ---- output ----
if (JSON_OUT) {
  console.log(JSON.stringify({
    meta: { region: REGION, focusLabel: focus.label, vertical: VERTICAL, gapThreshold: GAP, aiReviewedInFocus: scannedInFocus, generatedFrom: 'globi.sqlite' },
    targetGaps: targetReport, cropCoverage: cropTable, regionCoverage: regionTable,
  }, null, 2));
  db.close();
  return;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (n, w = 5) => String(n).padStart(w);
console.log(`\n=== AEDIN coverage-gap report ===`);
console.log(`focus: ${focus.label} (--region=${REGION})   vertical: ${VERTICAL}   gap threshold: <${GAP} claims`);
console.log(`ai_reviewed claims in focus: ${scannedInFocus} / ${claims.length} total\n`);

console.log(`--- TARGET GAPS (curated BD-plan crops, ranked by total ascending) ---`);
console.log(`${pad('crop', 26)} ${pad('vert', 10)} ${num('pest')} ${num('path')} ${num('benef')} ${num('total')} ${num('regs')}  gap?`);
for (const r of targetReport) {
  console.log(`${pad(r.label, 26)} ${pad(r.vertical, 10)} ${num(r.pest)} ${num(r.pathogen)} ${num(r.beneficial)} ${num(r.total)} ${num(r.regions)}  ${r.gap ? 'GAP <' + GAP : ''}`);
}

console.log(`\n--- CROP COVERAGE (crops appearing in focus, thinnest first, top ${TOP}) ---`);
console.log(`${pad('crop (scientific)', 30)} ${num('pest')} ${num('path')} ${num('benef')} ${num('other')} ${num('total')} ${num('regs')}`);
for (const r of cropTable.slice(0, TOP)) {
  console.log(`${pad(r.crop, 30)} ${num(r.pest)} ${num(r.pathogen)} ${num(r.beneficial)} ${num(r.other)} ${num(r.total)} ${num(r.regions)}`);
}
console.log(`(... ${Math.max(0, cropTable.length - TOP)} more crops with >= ${MIN_CLAIMS} claims)`);

console.log(`\n--- REGION COVERAGE (within focus) ---`);
console.log(`${pad('region bucket', 26)} ${num('claims')} ${num('crops')}`);
for (const r of regionTable.slice(0, 25)) {
  console.log(`${pad(r.region, 26)} ${num(r.total)} ${num(r.crops)}`);
}
console.log('');
db.close();
