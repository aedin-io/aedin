#!/usr/bin/env node
/**
 * render-trait-extractor-prompt.js — render the targeted trait-table extractor
 * prompt for one chunk to a file, for subscription-mode (Agent-tool) extraction.
 * Mirrors render-extractor-prompt.js but emits the FOCUSED trait-table-extractor
 * prompt for a named trait subset (--traits). Reusable across source batches.
 *
 * Usage:
 *   node render-trait-extractor-prompt.js <source.(pdf|md|txt)> <chunkIdx> --traits=a,b,c [--chunk-size=N]
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { renderVocabularyMarkdown } = require('./lib/trait-vocabulary');

// Pure core (unit-tested): substitute placeholders. No DB, no FS.
function buildTraitPrompt(templateBody, vocab, targetTraits, { glossaryMd = '', candidatesMd = '', chunk } = {}) {
  const missing = targetTraits.filter(t => !vocab[t]);
  if (missing.length) throw new Error(`unknown traits: ${missing.join(', ')}`);
  const targetVocab = {};
  for (const t of targetTraits) targetVocab[t] = vocab[t];
  return templateBody
    .replace('{{TARGET_TRAITS}}', renderVocabularyMarkdown(targetVocab))
    .replace('{{TRAITS_VOCABULARY}}', renderVocabularyMarkdown(vocab))
    .replace('{{BINOMIAL_GLOSSARY}}', glossaryMd)
    .replace('{{CANDIDATE_ENTITIES}}', candidatesMd)
    .replace('{{DOCUMENT}}', chunk);
}

module.exports = { buildTraitPrompt };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  // Suppress pdf-parse font warnings (same as render-extractor-prompt.js).
  const _w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c, e, cb) => (typeof c === 'string' && /Ran out of space in font private use area/.test(c)) ? true : _w(c, e, cb);
  const pdfParse = require('pdf-parse');
  const { loadVocabulary } = require('./lib/trait-vocabulary');
  const { buildGlossary, extractPairings, renderGlossaryMarkdown } = require('./lib/binomial-glossary');
  const { renderCandidateBlock } = require('./lib/candidate-entities');

  const MAX_CONTENT = 80_000;
  const OUT_DIR = process.env.RENDER_OUT_DIR || path.join(__dirname, 'reingest');
  const TRAIT_MD = path.resolve(__dirname, '../.claude/agents/trait-table-extractor.md');

  const argv = process.argv.slice(2);
  const flag = (n) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : null; };
  const positional = argv.filter(s => !s.startsWith('--'));
  const file = positional[0];
  const chunkIdx = parseInt(positional[1] || '0', 10);
  const chunkSize = parseInt(flag('chunk-size') || String(MAX_CONTENT), 10);
  const targetTraits = (flag('traits') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!file || !fs.existsSync(file) || !targetTraits.length) {
    console.error('Usage: node render-trait-extractor-prompt.js <source.(pdf|md|txt)> <chunkIdx> --traits=a,b,c [--chunk-size=N]');
    process.exit(1);
  }

  function templateBody() {
    const raw = fs.readFileSync(TRAIT_MD, 'utf8');
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
    if (!m) throw new Error('trait-table-extractor.md missing frontmatter');
    return m[1];
  }

  (async () => {
    const buf = fs.readFileSync(file);
    const fullText = file.toLowerCase().endsWith('.pdf') ? (await pdfParse(buf)).text : buf.toString('utf8');
    const totalChunks = Math.ceil(fullText.length / chunkSize);
    const chunk = fullText.slice(chunkIdx * chunkSize, chunkIdx * chunkSize + chunkSize).slice(0, MAX_CONTENT);

    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    const vocab = await loadVocabulary(db);
    const glossary = await buildGlossary(fullText, db);
    const pairings = extractPairings(fullText);
    const glossaryMd = renderGlossaryMarkdown(glossary, pairings);
    const allEntities = await db.all(`SELECT id, scientific_name, common_name, synonyms, bio_category, primary_role, genus FROM entities`);
    const candidatesMd = renderCandidateBlock(chunk, allEntities, 15);
    await db.close();

    const rendered = buildTraitPrompt(templateBody(), vocab, targetTraits, { glossaryMd, candidatesMd, chunk });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    const outFile = path.join(OUT_DIR, `${base}-traits-chunk${chunkIdx}.prompt.txt`);
    fs.writeFileSync(outFile, rendered);
    console.error(`[render-traits] ${base} chunk ${chunkIdx + 1}/${totalChunks} | ${chunk.length} chars | traits: ${targetTraits.join(',')}`);
    console.log(outFile);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
