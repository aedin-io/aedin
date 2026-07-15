'use strict';
/**
 * fetch-uog-ceo-pdfs.cjs — enumerate UOG Cooperative Extension & Outreach (CEO)
 * publications via the publications-press.uog.edu Laravel API, then download
 * the ag/IPM-scope PDFs to literature/extension/ for the Pass-13+ ingest pipeline.
 *
 * API discovery notes (see GUAM-REINGEST-RESUME.md for the Pass-12 playbook):
 *   - publications-press.uog.edu is a Nuxt SPA backed by a Laravel API. The
 *     SPA viewer URL (/ceo/technicalreport/<slug>/<id>) is JS-only, but the
 *     underlying API is plain JSON over POST.
 *   - POST /api/department/getAll  body={department:"ceo"}        -> paginated 5/page;
 *     keys book/journalArticle/technicalReport; CEO has 238 in technicalReport
 *     (as of 2026-06-01). per_page is server-fixed, ignore client per_page hint.
 *   - POST /api/department/getItem body={type:"technical report",id:<id>}
 *     -> [record] with `price_link[0].link` containing the direct PDF URL on
 *     www.uog.edu/_resources/files/extension/... (allowlisted host).
 *   - `categories[].name` is the in-scope filter: keep
 *       "Agriculture - ..."  (Fruit/Vegetable/Herb Production, Pest Mgmt, etc.)
 *       "Insects" "Plant Diseases" "Soil*" "Water*" "Forestry*"
 *     and drop "Family ..." "Food Safety" "Recipes" "Urban Pests" etc.
 *
 * Usage:
 *   node backend/scripts/fetch-uog-ceo-pdfs.cjs --dry-run   # list, don't download
 *   node backend/scripts/fetch-uog-ceo-pdfs.cjs             # download missing PDFs
 */

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const argv = process.argv.slice(2);
const DRY  = argv.includes('--dry-run');

const API_BASE = 'https://publications-press.uog.edu/api';
const OUT_DIR  = path.join(__dirname, '..', '..', 'literature', 'extension');

// Category-name substrings: any match -> in-scope. Anything not matched is dropped.
const IN_SCOPE = [
  'agriculture',     // covers Agriculture - Fruit/Vegetable/Herb Production, Agriculture - Pest Management, etc.
  'insect',
  'plant disease',
  'pathogen',
  'soil',
  'water',
  'irrigation',
  'forestry',
  'agroforestry',
  'fertili',         // fertilizer/fertility
  'weed',
  'pesticide',
  'invasive',
  'horticulture',
  'nutrient',
];

const OUT_OF_SCOPE = [
  'family',
  'food safety',
  'recipe',
  'urban pest',
  'turfgrass',
  'lawn',
  'cooking',
  'finance',
  'business',
  'teen',
  'youth',
  'disaster',
  'native plants of guam',
];

function inScope(categories = []) {
  const names = categories.map(c => (c?.name || '').toLowerCase());
  if (names.some(n => OUT_OF_SCOPE.some(k => n.includes(k)))) return false;
  return names.some(n => IN_SCOPE.some(k => n.includes(k)));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return res.json();
}

function sanitizeFilename(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

async function downloadPdf(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.slice(0, 4).toString().startsWith('%PDF')) {
    throw new Error(`not a PDF (first bytes=${JSON.stringify(buf.slice(0, 16).toString())})`);
  }
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

(async () => {
  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Paginate getAll until we've collected every technicalReport entry
  const all = [];
  let page = 1, last = 1;
  do {
    const data = await postJson(`${API_BASE}/department/getAll?page=${page}`, { department: 'ceo' });
    const tr   = data.technicalReport;
    if (!tr) break;
    last = tr.last_page;
    for (const item of tr.data) {
      const m = item.model;
      all.push({ id: m.id, title: m.title, date: m.date });
    }
    process.stderr.write(`page ${page}/${last} (${tr.data.length} items)\n`);
    page++;
  } while (page <= last);

  process.stderr.write(`\nenumerated ${all.length} CEO technical reports\n`);

  // 2. For each, fetch full record to get categories + PDF url + cross-reference DB
  const db = new Database(CORPUS_DB, { readonly: true });
  const existingUrls = new Set(
    db.prepare(`SELECT url FROM sources WHERE url IS NOT NULL`).all().map(r => r.url)
  );
  const existingTitles = new Set(
    db.prepare(`SELECT lower(title) AS t FROM sources WHERE title IS NOT NULL`).all().map(r => r.t)
  );
  db.close();

  const inScopeRows = [];
  const dropped = { out_of_scope: 0, no_pdf: 0, already_in_db: 0, errors: 0 };

  for (let i = 0; i < all.length; i++) {
    const { id, title } = all[i];
    try {
      const body = await postJson(`${API_BASE}/department/getItem`, { type: 'technical report', id: String(id) });
      const rec  = Array.isArray(body) ? body[0] : body;
      if (!rec) { dropped.errors++; continue; }

      if (!inScope(rec.categories || [])) { dropped.out_of_scope++; continue; }

      const link = (rec.price_link || []).find(p => p?.link)?.link;
      if (!link || !link.toLowerCase().endsWith('.pdf')) { dropped.no_pdf++; continue; }

      if (existingUrls.has(link) || existingTitles.has((rec.title || '').toLowerCase())) {
        dropped.already_in_db++;
        continue;
      }

      inScopeRows.push({
        id, title: rec.title, pdf_url: link,
        date: rec.date,
        categories: (rec.categories || []).map(c => c.name).slice(0, 3),
      });
    } catch (e) {
      process.stderr.write(`  [err] id=${id}: ${e.message}\n`);
      dropped.errors++;
    }
  }

  process.stderr.write(`\nin_scope=${inScopeRows.length}  dropped: ${JSON.stringify(dropped)}\n`);

  // 3. Print plan (always) + download (unless --dry-run)
  console.log(`\n# Plan: ${inScopeRows.length} new in-scope PDFs to fetch from UOG CEO`);
  for (const r of inScopeRows) {
    console.log(`  id=${r.id}  ${r.title}`);
    console.log(`    ${r.pdf_url}`);
    console.log(`    cats: ${r.categories.join(' | ')}`);
  }

  if (DRY) {
    console.log(`\n(dry-run; no files written)`);
    return;
  }

  console.log(`\n# Downloading to ${OUT_DIR}/`);
  let okCount = 0, failCount = 0;
  for (const r of inScopeRows) {
    const fname = `uog_ceo_${r.id}_${sanitizeFilename(r.title)}.pdf`;
    const out   = path.join(OUT_DIR, fname);
    if (fs.existsSync(out)) { process.stderr.write(`  [skip exists] ${fname}\n`); okCount++; continue; }
    try {
      const bytes = await downloadPdf(r.pdf_url, out);
      console.log(`  [ok ${(bytes/1024).toFixed(1)}KB] ${fname}`);
      okCount++;
    } catch (e) {
      console.log(`  [FAIL] id=${r.id} ${e.message}`);
      failCount++;
    }
  }
  console.log(`\nDone. ok=${okCount}  fail=${failCount}`);
})().catch(e => { console.error(e); process.exit(1); });
