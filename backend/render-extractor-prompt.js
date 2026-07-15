#!/usr/bin/env node
/**
 * render-extractor-prompt.js — render the COMPLETE extractor user-prompt for one
 * chunk to a file, for subscription-mode (Agent-tool) re-ingestion.
 *
 * The API path (extract-source.js) builds this prompt internally and calls the
 * Anthropic API. In subscription-only mode we instead: render the prompt here →
 * dispatch a general-purpose Agent to read it and emit JSON → stage-from-json.
 * This reuses the EXACT same placeholder substitution as buildUserPrompt
 * (vocab + correction lessons + binomial glossary + candidate entities), so the
 * subscription path and API path produce identical prompts — including the new
 * species-resolution glossary (docs/common-name-species-resolution.md).
 *
 * Writes the rendered prompt to /tmp/claude/reingest/<base>-chunk<idx>.prompt.txt
 * and prints ONLY that path + a one-line summary (keeps the ~100K-char prompt
 * out of the orchestrator's context).
 *
 * Usage:
 *   node render-extractor-prompt.js <file.pdf> <chunkIdx> [chunkSize]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

// Suppress pdf-parse font warnings that pollute stdout (same as pdf-chunk.js).
const _w = process.stdout.write.bind(process.stdout);
process.stdout.write = (c, e, cb) => (typeof c === 'string' && /Ran out of space in font private use area/.test(c)) ? true : _w(c, e, cb);
const pdfParse = require('pdf-parse');

const { loadVocabulary, renderVocabularyMarkdown } = require('./lib/trait-vocabulary');
const { renderInteractionVocabularyMarkdown } = require('./lib/interaction-vocabulary');
const { renderCorrectionLessons } = require('./lib/prompt-fingerprint');
const { renderCandidateBlock } = require('./lib/candidate-entities');
const { buildGlossary, extractPairings, renderGlossaryMarkdown } = require('./lib/binomial-glossary');

const MAX_CONTENT = 80_000;
const DB_PATH = CORPUS_DB;
const OUT_DIR = process.env.RENDER_OUT_DIR || path.join(__dirname, 'reingest');
const EXTRACTOR_MD = path.resolve(__dirname, '../.claude/agents/extractor.md');

const file = process.argv[2];
const chunkIdx = parseInt(process.argv[3] || '0', 10);
const chunkSize = parseInt(process.argv[4] || String(MAX_CONTENT), 10);
if (!file || !fs.existsSync(file)) { console.error('Usage: node render-extractor-prompt.js <file.pdf> <chunkIdx> [chunkSize]'); process.exit(1); }

function extractorBody() {
  const raw = fs.readFileSync(EXTRACTOR_MD, 'utf8');
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error('extractor.md missing frontmatter');
  return m[1];
}

(async () => {
  const buf = fs.readFileSync(file);
  const fullText = file.toLowerCase().endsWith('.pdf') ? (await pdfParse(buf)).text : buf.toString('utf8');
  const totalChunks = Math.ceil(fullText.length / chunkSize);
  const chunk = fullText.slice(chunkIdx * chunkSize, chunkIdx * chunkSize + chunkSize);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  // Glossary spans the FULL document (cross-chunk species authority).
  const glossary = await buildGlossary(fullText, db);
  const pairings = extractPairings(fullText);
  const glossaryMd = renderGlossaryMarkdown(glossary, pairings);
  const vocab = await loadVocabulary(db);
  const lessonsMd = await renderCorrectionLessons(db);
  const allEntities = await db.all(`SELECT id, scientific_name, common_name, synonyms, bio_category, primary_role, genus FROM entities`);
  const candidatesMd = renderCandidateBlock(chunk.slice(0, MAX_CONTENT), allEntities, 15);
  await db.close();

  const rendered = extractorBody()
    .replace('{{TRAITS_VOCABULARY}}', renderVocabularyMarkdown(vocab))
    .replace('{{INTERACTION_VOCABULARY}}', renderInteractionVocabularyMarkdown())
    .replace('{{CORRECTION_LESSONS}}', lessonsMd)
    .replace('{{BINOMIAL_GLOSSARY}}', glossaryMd)
    .replace('{{CANDIDATE_ENTITIES}}', candidatesMd)
    .replace('{{DOCUMENT}}', chunk.slice(0, MAX_CONTENT));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const outFile = path.join(OUT_DIR, `${base}-chunk${chunkIdx}.prompt.txt`);
  fs.writeFileSync(outFile, rendered);

  const ambiguous = [...pairings.values()].filter(s => s.size > 1).length;
  console.error(`[render] ${base} chunk ${chunkIdx + 1}/${totalChunks} | ${chunk.length} chars | glossary: ${glossary.length} binomials, ${pairings.size} name-pairs (${ambiguous} ambiguous)`);
  console.log(outFile);
})().catch(e => { console.error(e.message); process.exit(1); });
