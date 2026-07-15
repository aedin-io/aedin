#!/usr/bin/env node
/**
 * pdf-chunk.js — extract a single 80K-char chunk from a PDF.
 *
 * Usage:
 *   node pdf-chunk.js <file.pdf> <chunk-index> [chunk-size]
 *   node pdf-chunk.js <file.pdf> --glossary           # emit document binomial glossary
 *
 * Writes the chunk text to stdout. Chunk index is 0-based.
 * Used by the Claude-Code-driven ingestion path: we shell out to this
 * to get the text for a single chunk, hand it to the extractor agent,
 * then call stage-from-json.js with the agent's JSON output.
 *
 * --glossary mode (Follow-up B, docs/common-name-species-resolution.md):
 * scans the FULL document for the species binomials it names (cross-checked
 * against the entities taxonomy) and prints the glossary markdown to stdout.
 * Run ONCE per document and prepend the result to every chunk's extractor-agent
 * prompt, so a species named in one chunk is authoritative when resolving a
 * common name in another.
 *
 * Also prints a one-line header to stderr with [chunk N/M] info so
 * the caller can size --max-chunks correctly.
 */
'use strict';

const fs = require('fs');
// pdfjs-dist (used by pdf-parse) writes "Warning: Ran out of space in font
// private use area." messages to stdout for some PDFs (e.g. Dent IPM 2nd ed.,
// which has thousands per page). These pollute the chunk text and waste
// extractor-agent tokens. Filter them out at the stdout boundary.
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, encoding, cb) {
  if (typeof chunk === 'string' && /Warning: Ran out of space in font private use area/.test(chunk)) return true;
  return _origStdoutWrite(chunk, encoding, cb);
};
const _origConsoleLog = console.log;
console.log = function (...args) {
  const s = args.map(a => String(a)).join(' ');
  if (/Warning: Ran out of space in font private use area/.test(s)) return;
  _origConsoleLog.apply(console, args);
};
const pdfParse = require('pdf-parse');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const file = process.argv[2];
const GLOSSARY_MODE = process.argv.includes('--glossary');
const idx = parseInt(process.argv[3] || '0', 10);
const size = parseInt(process.argv[4] || '80000', 10);

if (!file || !fs.existsSync(file)) {
  console.error('Usage: node pdf-chunk.js <file.pdf> <chunk-index> [chunk-size]');
  console.error('       node pdf-chunk.js <file.pdf> --glossary');
  process.exit(1);
}

async function readFullText() {
  const buf = fs.readFileSync(file);
  if (file.toLowerCase().endsWith('.pdf')) {
    const parsed = await pdfParse(buf);
    return parsed.text;
  }
  return buf.toString('utf8');
}

(async () => {
  const text = await readFullText();

  if (GLOSSARY_MODE) {
    const { buildGlossary, extractPairings, renderGlossaryMarkdown } = require('./lib/binomial-glossary');
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    const glossary = await buildGlossary(text, db);
    const pairings = extractPairings(text);
    await db.close();
    const ambiguous = [...pairings.values()].filter(s => s.size > 1).length;
    console.error(`[glossary] ${glossary.length} binomials, ${pairings.size} common-name pairs (${ambiguous} ambiguous) from ${text.length} chars`);
    process.stdout.write(renderGlossaryMarkdown(glossary, pairings));
    return;
  }

  const total = Math.ceil(text.length / size);
  const offset = idx * size;
  const chunk = text.slice(offset, offset + size);
  console.error(`[chunk ${idx + 1}/${total}] offset=${offset} chars=${chunk.length} (file total: ${text.length} chars)`);
  process.stdout.write(chunk);
})().catch(e => { console.error(e.message); process.exit(1); });
