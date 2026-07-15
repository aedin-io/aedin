#!/usr/bin/env node
/**
 * Follow-up C step 2: PDF-grounded classification of the sampled candidates.
 *
 * For each sampled claim, extract the FULL source document to text (pdftotext,
 * cached per file_path), normalize whitespace, then decide:
 *   (a) full binomial OR abbreviated "G. epithet" OR recurring bare epithet
 *       present somewhere in the document  -> extractor was document-grounded.
 *   (b) (already excluded upstream, but re-checked vs quote here for audit)
 *   (c) binomial absent from the entire document -> LLM guessed from prior.
 *   (skip) file_path null or PDF unreadable -> unauditable by this method.
 *
 * Deterministic + re-runnable. Emits a classified worksheet + summary counts.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'audit-species-overspec-sample.json'), 'utf8')
);

const textCache = new Map();
function docText(fp) {
  if (textCache.has(fp)) return textCache.get(fp);
  let txt = '';
  try {
    if (fp && fs.existsSync(fp)) {
      txt = execSync(`pdftotext -q ${JSON.stringify(fp)} -`, {
        maxBuffer: 1024 * 1024 * 64,
      }).toString();
    }
  } catch (e) {
    txt = ''; // unreadable -> treated as unauditable below
  }
  // collapse whitespace/newlines so PDF line-wraps don't split binomials
  txt = txt.replace(/\s+/g, ' ').toLowerCase();
  textCache.set(fp, txt);
  return txt;
}

function classify(row) {
  const fp = row.file_path;
  if (!fp) return { klass: 'skip', reason: 'null_file_path' };
  const doc = docText(fp);
  if (!doc) return { klass: 'skip', reason: 'pdf_unreadable_or_missing' };

  const parts = row.sci.trim().split(/\s+/);
  const genus = parts[0].toLowerCase();
  const epithet = parts[1].toLowerCase();
  const full = `${genus} ${epithet}`;
  const abbrev = new RegExp(`\\b${genus[0]}\\.?\\s+${epithet}\\b`);

  if (doc.includes(full)) return { klass: 'a', reason: 'full_binomial_in_doc' };
  if (abbrev.test(doc)) return { klass: 'a', reason: 'abbrev_binomial_in_doc' };
  // recurring bare epithet (>=2) means doc discusses this species under abbrev
  if (epithet.length >= 4) {
    const re = new RegExp(`\\b${epithet}\\b`, 'g');
    const n = (doc.match(re) || []).length;
    if (n >= 2) return { klass: 'a', reason: `bare_epithet_x${n}_in_doc` };
    if (n === 1) return { klass: 'review', reason: 'epithet_once_in_doc' };
  }
  return { klass: 'c', reason: 'binomial_absent_from_doc' };
}

const out = [];
const counts = { a: 0, c: 0, review: 0, skip: 0 };
for (const row of sample) {
  const res = classify(row);
  counts[res.klass]++;
  out.push({
    claim_id: row.claim_id,
    source_id: row.source_id,
    side: row.side,
    sci: row.sci,
    cat: row.cat,
    klass: res.klass,
    reason: res.reason,
    src_title: row.src_title,
    file_path: row.file_path,
    quote: (row.quote || '').slice(0, 240),
  });
}

// Summary
const auditable = counts.a + counts.c + counts.review;
console.log(JSON.stringify({
  sample_size: sample.length,
  counts,
  auditable_excl_skip: auditable,
  c_fraction_of_auditable: auditable ? +(counts.c / auditable).toFixed(3) : null,
  c_fraction_incl_review_as_c:
    auditable ? +((counts.c + counts.review) / auditable).toFixed(3) : null,
}, null, 2));

fs.writeFileSync(
  path.join(__dirname, 'audit-species-overspec-classified.json'),
  JSON.stringify(out, null, 2)
);
console.log('\nWrote classified worksheet -> backend/audit-species-overspec-classified.json');

// Print the (c) + review rows inline (these are the ones that matter)
console.log('\n=== (c) binomial-absent + (review) epithet-once rows ===');
for (const r of out.filter((x) => x.klass === 'c' || x.klass === 'review')) {
  console.log(`\n[${r.klass}] claim ${r.claim_id} (${r.side}) :: ${r.sci}  <${r.cat}>`);
  console.log(`    src#${r.source_id} ${r.src_title || ''}`);
  console.log(`    reason: ${r.reason}`);
  console.log(`    quote: ${r.quote}`);
}
