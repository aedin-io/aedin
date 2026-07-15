/**
 * extract-source.js
 *
 * Core extraction module for the LLM pipeline.
 * Given a queue item (url or file_path), fetches the content,
 * calls Claude for structured extraction, and stages all claims for review.
 *
 * Exports: extractSource(queueItem, db) → { sourceId, stagedCount, newCropCount }
 */
'use strict';

require('dotenv').config();
const fs        = require('fs');
const https     = require('https');
const http      = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const { isFatalGuardError } = require('./lib/cost-guard');
const { buildGlossary, extractPairings, renderGlossaryMarkdown } = require('./lib/binomial-glossary');

const MAX_CONTENT = 80_000; // chars sent to Claude
const pdfParse   = require('pdf-parse');

const client = new Anthropic();

// ── HTTP fetch (copied from scrape-varieties.js) ──────────────────────────────
function fetchUrl(url, timeoutMs = 20_000, returnBuffer = false) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'AgroEcoExplorer/1.0 (data-extraction; contact: agroeco-bot)',
        'Accept': 'text/html,application/xhtml+xml,application/pdf,application/json,text/plain,*/*'
      }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        const next = new URL(res.headers.location, url).href;
        return fetchUrl(next, timeoutMs, returnBuffer).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(returnBuffer ? buf : buf.toString('utf8'));
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

// ── Strip HTML to plain text (copied from scrape-varieties.js) ───────────────
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

// ── JSON parse with 3-strategy fallback ──────────────────────────────────────
function parseJsonResponse(raw) {
  // 1. Direct parse
  try { return JSON.parse(raw); } catch {}
  // 2. Strip markdown fences
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(stripped); } catch {}
  // 3. Extract first {...} block
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {}
  }
  return null;
}

// ── Load extractor prompt from .claude/agents/extractor.md ────────────────────
// The agent file is the source-of-truth for the extraction prompt and JSON
// schema. This script consumes it at runtime; edit the agent file (not this
// script) to evolve the prompt.
const path = require('path');
const { loadVocabulary, renderVocabularyMarkdown } = require('./lib/trait-vocabulary');
const { renderInteractionVocabularyMarkdown } = require('./lib/interaction-vocabulary');
const { extractorMdSha, promptBundleSha, renderCorrectionLessons } = require('./lib/prompt-fingerprint');
const { renderCandidateBlock } = require('./lib/candidate-entities');
const EXTRACTOR_AGENT_PATH = path.resolve(__dirname, '../.claude/agents/extractor.md');

let _cachedPromptSpec = null;
function loadExtractorPrompt() {
  if (_cachedPromptSpec) return _cachedPromptSpec;

  const raw = fs.readFileSync(EXTRACTOR_AGENT_PATH, 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fm) throw new Error(`Extractor agent file at ${EXTRACTOR_AGENT_PATH} missing frontmatter`);
  const [, frontmatter, body] = fm;

  function fmField(key, fallback) {
    const re = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|(.+))$`, 'm');
    const m = frontmatter.match(re);
    if (!m) return fallback;
    return (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim();
  }

  _cachedPromptSpec = {
    systemPrompt: fmField('system_prompt', ''),
    model: fmField('model', 'claude-sonnet-4-6'),
    body,
  };
  if (!_cachedPromptSpec.systemPrompt) {
    throw new Error(`extractor.md frontmatter is missing system_prompt`);
  }
  if (!_cachedPromptSpec.body.includes('{{DOCUMENT}}')) {
    throw new Error(`extractor.md body is missing the {{DOCUMENT}} placeholder`);
  }
  return _cachedPromptSpec;
}

// ── Build Claude user prompt ──────────────────────────────────────────────────
async function buildUserPrompt(docText, db, glossaryMd) {
  const { body } = loadExtractorPrompt();
  const truncated = docText.slice(0, MAX_CONTENT);
  const vocab = await loadVocabulary(db);
  const lessonsMd = await renderCorrectionLessons(db);
  const allEntities = await db.all(`SELECT id, scientific_name, common_name, synonyms, bio_category, primary_role, genus FROM entities`);
  const candidatesMd = renderCandidateBlock(truncated, allEntities, 15);
  return body
    .replace('{{TRAITS_VOCABULARY}}', renderVocabularyMarkdown(vocab))
    .replace('{{INTERACTION_VOCABULARY}}', renderInteractionVocabularyMarkdown())
    .replace('{{CORRECTION_LESSONS}}', lessonsMd)
    .replace('{{BINOMIAL_GLOSSARY}}', glossaryMd || renderGlossaryMarkdown([]))
    .replace('{{CANDIDATE_ENTITIES}}', candidatesMd)
    .replace('{{DOCUMENT}}', truncated);
}

// ── Fetch content from queueItem (URL or file_path) ───────────────────────────
async function fetchContent(queueItem) {
  if (queueItem.url) {
    const isPdf = /\.pdf(\?.*)?$/i.test(queueItem.url);
    const rawBytes = await fetchUrl(queueItem.url, 30_000, true);
    if (isPdf || rawBytes.slice(0, 5).toString() === '%PDF-') {
      const parsed = await pdfParse(rawBytes);
      return parsed.text;
    }
    return stripHtml(rawBytes.toString('utf8'));
  }
  const ext = (queueItem.file_path || '').toLowerCase();
  if (ext.endsWith('.pdf')) {
    const buf = await require('fs/promises').readFile(queueItem.file_path);
    const parsed = await pdfParse(buf);
    return parsed.text;
  }
  return require('fs/promises').readFile(queueItem.file_path, 'utf8');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * extractSource(queueItem, db, opts)
 *
 * @param {object} queueItem  Row from extraction_queue: { id, url, file_path, source_type }
 * @param {object} db         sqlite promise-api db handle
 * @param {object} [opts]
 * @param {number} [opts.maxChunks=1]   How many MAX_CONTENT-sized slices to process
 *                                      sequentially. Default 1 = legacy single-call
 *                                      behavior (papers). Set higher for books, where
 *                                      the first 80K is front-matter (TOC/preface)
 *                                      and the meat lives at later offsets.
 * @param {number} [opts.chunkSize]     Chunk size in characters; defaults to
 *                                      MAX_CONTENT (80K). Override for unusual cases.
 * @returns {{ sourceId, stagedCount, newCropCount }}
 */
async function extractSource(queueItem, db, opts = {}) {
  const maxChunks = Math.max(1, parseInt(opts.maxChunks, 10) || 1);
  const chunkSize = Math.max(1000, parseInt(opts.chunkSize, 10) || MAX_CONTENT);
  const guard = opts.guard || null;

  const rawContent = await fetchContent(queueItem);
  const totalChunks = Math.min(maxChunks, Math.max(1, Math.ceil(rawContent.length / chunkSize)));

  // Document-level binomial glossary (Follow-up B): scan the FULL document once
  // for every species it names, so each chunk's prompt carries the document's
  // authoritative species even when the binomial lives in a different chunk than
  // the claim. docs/common-name-species-resolution.md.
  const glossary = await buildGlossary(rawContent, db);
  const pairings = extractPairings(rawContent);
  const glossaryMd = renderGlossaryMarkdown(glossary, pairings);
  if (glossary.length || pairings.size) {
    const ambiguous = [...pairings.values()].filter(s => s.size > 1).length;
    console.log(`  [glossary] ${glossary.length} binomials, ${pairings.size} common-name→species pairs (${ambiguous} ambiguous)`);
  }

  // ── Pre-compute prompt fingerprints (used when we open the extractor_runs row) ──
  const repoRoot = path.join(__dirname, '..');
  const extractorSha = extractorMdSha(repoRoot);
  const bundleSha = await promptBundleSha(repoRoot, db);
  const { model: EXTRACTION_MODEL } = loadExtractorPrompt();

  // runId is opened AFTER the first chunk resolves sourceId — extractor_runs.source_id
  // is NOT NULL (migration 038), and sourceId is derived inside chunk 0 from the LLM's
  // source_meta response on first-time extractions (queueItem.source_id may be null).
  let runId = null;
  let sourceId = queueItem.source_id || null;
  let totalStaged = 0;
  let totalNewCrops = 0;

  let chunkErrors = 0;
  try {
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const offset = chunkIdx * chunkSize;
      const chunk = rawContent.slice(offset, offset + chunkSize);
      if (chunkIdx > 0 && chunk.length < 2000) break; // skip insignificant tail
      if (maxChunks > 1) {
        console.log(`  [chunk ${chunkIdx + 1}/${totalChunks}] offset=${offset} chars=${chunk.length}`);
      }
      try {
        const r = await extractChunkAndStage(chunk, queueItem, db, sourceId, runId, guard, glossaryMd);
        if (r.sourceId) sourceId = r.sourceId;
        totalStaged += r.stagedCount;
        totalNewCrops += r.newCropCount;
        if (maxChunks > 1) {
          console.log(`  [chunk ${chunkIdx + 1}/${totalChunks}] staged=${r.stagedCount} newCrops=${r.newCropCount}`);
        }
        // ── Open extractor_runs row once we have a real sourceId ────────────
        // Do this AFTER chunk 0 so source_id is guaranteed non-null (NOT NULL constraint).
        if (sourceId && runId === null) {
          const runInsert = await db.run(
            `INSERT INTO extractor_runs (source_id, extractor_md_sha, prompt_bundle_sha, extraction_model)
             VALUES (?, ?, ?, ?)`,
            [sourceId, extractorSha, bundleSha, EXTRACTION_MODEL]
          );
          runId = runInsert.lastID;
          console.log('[extract-source] opened extractor_runs id=', runId,
            'after chunk', chunkIdx,
            'md_sha=', extractorSha.slice(0, 12), 'bundle=', bundleSha.slice(0, 12));
          // Backfill run_id on staging rows already inserted in this chunk
          // (they were staged with runId=null because the INSERT hadn't happened yet)
          await db.run(
            `UPDATE extraction_staging SET run_id = ? WHERE source_id = ? AND run_id IS NULL`,
            [runId, sourceId]
          );
        }
      } catch (err) {
        // Fatal cost-guard errors (spend ceiling, circuit breaker) must NOT be
        // swallowed — re-throw immediately so the outer driver aborts the run.
        if (isFatalGuardError(err)) throw err;
        chunkErrors++;
        console.warn(`  [chunk ${chunkIdx + 1}/${totalChunks}] FAILED: ${err.message} — continuing to next chunk`);
        // Don't propagate non-fatal: a single bad chunk shouldn't kill the book.
        // The failure mode this guards is "Claude returned non-JSON" on one chunk —
        // other chunks usually parse cleanly, and partial extraction is far better
        // than zero extraction. Throw only if EVERY chunk fails.
      }
    }

    if (chunkErrors === totalChunks) {
      throw new Error(`all ${totalChunks} chunks failed extraction`);
    }

    // ── Close run: success ──────────────────────────────────────────────────
    if (runId) {
      await db.run(
        `UPDATE extractor_runs SET completed_at=datetime('now'), status='complete', rows_staged=? WHERE id=?`,
        [totalStaged, runId]
      );
    }
    return { sourceId, stagedCount: totalStaged, newCropCount: totalNewCrops };
  } catch (err) {
    // ── Close run: failure ──────────────────────────────────────────────────
    if (runId) {
      await db.run(
        `UPDATE extractor_runs SET completed_at=datetime('now'), status='failed', notes=? WHERE id=?`,
        [String(err.message || err).slice(0, 1000), runId]
      );
    } else {
      // sourceId was never resolved (chunk 0 failed before upsert) — no extractor_runs row exists
      console.warn('[extract-source] extraction failed before extractor_runs row was opened (sourceId never resolved):', err.message);
    }
    throw err;
  }
}

/**
 * extractChunkAndStage — process a single MAX_CONTENT-sized text chunk.
 *
 * If `existingSourceId` is null this is the first chunk: derive source_meta
 * from the LLM response and upsert the `sources` row. On subsequent chunks
 * the caller passes the established sourceId and we skip the source upsert.
 *
 * @param {string|null} runId   extractor_runs.id for this extraction run (threads to staging rows).
 */
async function extractChunkAndStage(rawContent, queueItem, db, existingSourceId, runId = null, guard = null, glossaryMd = null) {
  const { systemPrompt, model } = loadExtractorPrompt();
  if (guard) guard.checkBeforeCall();
  let msg;
  try {
    msg = await client.messages.create({
      model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: await buildUserPrompt(rawContent, db, glossaryMd) }]
    });
    if (guard) guard.recordSuccess(model, msg.usage?.input_tokens, msg.usage?.output_tokens);
  } catch (e) {
    if (isFatalGuardError(e)) throw e;
    if (guard) {
      guard.recordFailure();
      if (guard.isNonRetryable(e)) {
        console.error(`[extract-source] non-retryable error class: ${e.name || 'Error'}: ${e.message}`);
      }
    }
    throw e;
  }

  const raw = msg.content[0]?.text?.trim() || '';

  // 3. Parse response
  const extracted = parseJsonResponse(raw);
  if (!extracted || typeof extracted !== 'object') {
    throw new Error('Claude returned non-JSON or malformed response');
  }

  const {
    source_meta = {},
    interactions = [],
    crop_vulnerabilities = [],
    biocontrol = [],
    crop_enrichment = [],
    new_crops = []
  } = extracted;

  // 4. Resolve / upsert source row (skip if caller passed an established sourceId)
  let sourceId = existingSourceId;
  if (sourceId == null) {
    const existingSource = queueItem.url
      ? await db.get('SELECT id FROM sources WHERE url = ?', queueItem.url)
      : await db.get('SELECT id FROM sources WHERE file_path = ?', queueItem.file_path);
    if (existingSource) {
      sourceId = existingSource.id;
    } else {
      const authorsValue = Array.isArray(source_meta.authors)
        ? source_meta.authors.join(', ')
        : (source_meta.authors && typeof source_meta.authors === 'object')
          ? JSON.stringify(source_meta.authors)
          : (source_meta.authors || null);
      const result = await db.run(
        `INSERT INTO sources (title, authors, publication, year, source_type, url, file_path, region_focus, crop_focus, ingested_at, extraction_model, extraction_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 1)`,
        [
          source_meta.title || queueItem.url || queueItem.file_path || 'Untitled',
          authorsValue,
          source_meta.publication || null,
          source_meta.year || null,
          source_meta.source_type || queueItem.source_type || 'unknown',
          queueItem.url || null,
          queueItem.file_path || null,
          source_meta.region_focus || null,
          source_meta.crop_focus || null,
          model,
        ]
      );
      sourceId = result.lastID;
    }
  }

  let stagedCount = 0;

  // 4b. Normalize organism names — resolve common names to scientific names via entities table
  const nameCache = new Map();
  async function resolveScientificName(name) {
    if (!name) return name;
    const key = name.toLowerCase();
    if (nameCache.has(key)) return nameCache.get(key);

    // Already looks like a scientific name (two+ Latin words, first capitalized)?
    if (/^[A-Z][a-z]+ [a-z]/.test(name)) {
      nameCache.set(key, name);
      return name;
    }

    // Try matching as common name in entities
    const ent = await db.get(
      'SELECT scientific_name FROM entities WHERE common_name = ? COLLATE NOCASE LIMIT 1',
      [name]
    );
    if (ent) {
      nameCache.set(key, ent.scientific_name);
      return ent.scientific_name;
    }

    // Try partial match
    const partial = await db.get(
      'SELECT scientific_name FROM entities WHERE common_name LIKE ? COLLATE NOCASE LIMIT 1',
      [`%${name}%`]
    );
    if (partial) {
      nameCache.set(key, partial.scientific_name);
      return partial.scientific_name;
    }

    nameCache.set(key, name);
    return name;
  }

  // Normalize interactions
  for (const item of interactions) {
    // Support both old (subject_crop) and new (subject_organism) field names
    const subKey = item.subject_organism ? 'subject_organism' : 'subject_crop';
    const objKey = item.object_organism ? 'object_organism' : 'object_crop';
    item[subKey] = await resolveScientificName(item[subKey]);
    item[objKey] = await resolveScientificName(item[objKey]);
    // Normalize to subject_crop/object_crop for staging payload compatibility
    item.subject_crop = item[subKey];
    item.object_crop = item[objKey];
  }
  // Normalize vulnerabilities
  for (const item of crop_vulnerabilities) {
    item.crop = await resolveScientificName(item.crop);
    item.pest_scientific_name = await resolveScientificName(item.pest_scientific_name);
  }
  // Normalize biocontrol
  for (const item of biocontrol) {
    item.beneficial_organism = await resolveScientificName(item.beneficial_organism);
    item.target_pest = await resolveScientificName(item.target_pest);
  }
  // Normalize enrichment
  for (const item of crop_enrichment) {
    item.scientific_name = await resolveScientificName(item.scientific_name);
  }
  // Normalize new_crops
  for (const entry of new_crops) {
    if (entry.scientific_name) {
      entry.scientific_name = await resolveScientificName(entry.scientific_name);
    }
  }

  // 5. Stage interaction claims
  for (const item of interactions) {
    try {
      await db.run(
        `INSERT INTO extraction_staging (queue_id, source_id, target_table, payload, run_id)
         VALUES (?, ?, 'interactions', ?, ?)`,
        [queueItem.id, sourceId, JSON.stringify(item), runId]
      );
      stagedCount++;
    } catch (err) {
      console.warn(`  ⚠ staging interaction failed: ${err.message}`);
    }
  }

  // 6. Stage crop_vulnerability claims
  for (const item of crop_vulnerabilities) {
    try {
      await db.run(
        `INSERT INTO extraction_staging (queue_id, source_id, target_table, payload, run_id)
         VALUES (?, ?, 'crop_vulnerabilities', ?, ?)`,
        [queueItem.id, sourceId, JSON.stringify(item), runId]
      );
      stagedCount++;
    } catch (err) {
      console.warn(`  ⚠ staging crop_vulnerability failed: ${err.message}`);
    }
  }

  // 6b. Stage biocontrol claims
  for (const item of biocontrol) {
    try {
      // Map to interactions format for staging: beneficial → pest is biocontrol
      const mapped = {
        subject_crop: item.beneficial_organism,
        subject_common_name: item.beneficial_common_name,
        object_crop: item.target_pest,
        object_common_name: item.target_pest_common_name,
        interaction_type: 'biocontrol',
        effect_direction: 'beneficial',
        mechanism: item.mechanism || item.control_type,
        confidence_score: item.confidence_score,
        evidence_tier: item.evidence_tier,
        extracted_claim: item.extracted_claim,
        source_quote: item.source_quote,
        source_page: item.source_page,
        regional_context: item.regional_context,
      };
      await db.run(
        `INSERT INTO extraction_staging (queue_id, source_id, target_table, payload, run_id)
         VALUES (?, ?, 'interactions', ?, ?)`,
        [queueItem.id, sourceId, JSON.stringify(mapped), runId]
      );
      stagedCount++;
    } catch (err) {
      console.warn(`  ⚠ staging biocontrol failed: ${err.message}`);
    }
  }

  // 7. Stage crop enrichment (only for entities that aren't already 'full')
  for (const item of crop_enrichment) {
    if (!item.scientific_name) continue;
    const ent = await db.get(
      'SELECT id, data_completeness FROM entities WHERE scientific_name = ? COLLATE NOCASE',
      item.scientific_name
    );
    if (ent && ent.data_completeness === 'full') continue; // nothing to add
    try {
      await db.run(
        `INSERT INTO extraction_staging (queue_id, source_id, target_table, payload, run_id)
         VALUES (?, ?, 'crops', ?, ?)`,
        [queueItem.id, sourceId, JSON.stringify(item), runId]
      );
      stagedCount++;
    } catch (err) {
      console.warn(`  ⚠ staging crop enrichment failed: ${err.message}`);
    }
  }

  // 8. Handle new crops
  let newCropCount = 0;
  for (const entry of new_crops) {
    const sciName = entry.scientific_name || entry;
    if (!sciName) continue;
    const existing = await db.get(
      'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE',
      sciName
    );
    if (!existing) {
      try {
        await db.run(
          `INSERT OR IGNORE INTO entities (scientific_name, common_name, bio_category, primary_role, source_table, data_completeness)
           VALUES (?, ?, 'plantae', 'crop', 'llm_extraction', 'manual')`,
          [sciName, entry.common_name || null]
        );
        await db.run(
          `INSERT OR IGNORE INTO pending_crops (scientific_name, common_name, region_context, source_id)
           VALUES (?, ?, ?, ?)`,
          [sciName, entry.common_name || null, entry.region_context || entry.region || null, sourceId]
        );
        newCropCount++;
      } catch (err) {
        console.warn(`  ⚠ inserting new crop ${sciName} failed: ${err.message}`);
      }
    }
  }

  return { sourceId, stagedCount, newCropCount };
}

module.exports = { extractSource };
