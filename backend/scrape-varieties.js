/**
 * scrape-varieties.js
 * Fetches crop variety data from university extension sources.
 * Uses content-hash caching to avoid redundant Claude API calls.
 *
 * Usage: node scrape-varieties.js
 *   --dry-run    Print what would be fetched/processed without writing to DB
 *   --force      Ignore cached hashes, re-process all sources
 *   --crop <name>  Only process sources for this common name (e.g. "Tomato")
 */

require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

// ── CLI flags ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');
const CROP_FILTER = (() => {
  const idx = args.indexOf('--crop');
  return idx !== -1 ? args[idx + 1]?.toLowerCase() : null;
})();

const SOURCES_FILE = './variety-sources.json';
const DB_FILE      = CORPUS_DB;
const MAX_CONTENT  = 80_000; // chars sent to Claude

// ── DB setup ──────────────────────────────────────────────────────────────────
async function getDb() {
  const db = await open({ filename: DB_FILE, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS crop_varieties (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      species_name  TEXT NOT NULL,
      variety_name  TEXT NOT NULL,
      region        TEXT,
      source_name   TEXT,
      source_url    TEXT,
      maturity_days TEXT,
      yield_notes   TEXT,
      water_needs   TEXT,
      climate_notes TEXT,
      traits_json   TEXT,
      last_scraped  TEXT,
      UNIQUE(species_name, variety_name, region, source_name)
    );

    CREATE TABLE IF NOT EXISTS variety_source_cache (
      source_url   TEXT PRIMARY KEY,
      content_hash TEXT,
      last_fetched TEXT,
      last_changed TEXT
    );
  `);

  return db;
}

// ── HTTP fetch ─────────────────────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'AgroEcoExplorer/1.0 (crop-variety-scraper; contact: agroeco-bot)',
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*'
      }
    }, res => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        const next = new URL(res.headers.location, url).href;
        return fetchUrl(next, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

// ── Strip HTML to readable text ────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .trim();
}

// ── Claude extraction ──────────────────────────────────────────────────────────
async function extractWithClaude(client, pageText, speciesName, sourceName) {
  const truncated = pageText.slice(0, MAX_CONTENT);
  const prompt = `You are a crop data extractor. From the following university extension page about ${speciesName}, extract a JSON array of crop variety entries.

Each entry must have these fields (use null if unknown):
- variety_name: string (cultivar name, required — skip entries without a clear variety name)
- maturity_days: string or null (e.g. "90-110", "70", "early", "late season")
- yield_notes: string or null (brief yield description)
- water_needs: "low" | "moderate" | "high" | null
- climate_notes: string or null (heat tolerance, frost tolerance, altitude, humidity, etc.)
- other_traits: object or null (any additional structured traits like disease resistance, flavor, size, color)

Return ONLY a valid JSON array. No markdown fences, no explanation, no preamble.
If no variety data is found, return an empty array: []

Page content from ${sourceName}:
${truncated}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = msg.content[0]?.text?.trim() || '[]';

  // Try multiple extraction strategies in order
  // 1. Direct parse
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch {}
  // 2. Strip markdown fences (``` or ```json) and retry
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { const p = JSON.parse(stripped); return Array.isArray(p) ? p : []; } catch {}
  // 3. Extract the first [...] array found anywhere in the response
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { const p = JSON.parse(arrMatch[0]); return Array.isArray(p) ? p : []; } catch {}
  }

  console.warn('  ⚠ Claude returned non-JSON; skipping parse');
  if (process.env.DEBUG_CLAUDE) console.warn('  Raw response:', raw.slice(0, 500));
  return [];
}

// ── Parse structured DB / CSV responses ───────────────────────────────────────
function parseStructured(content, contentType) {
  // JSON array response
  if (contentType?.includes('application/json') || content.trimStart().startsWith('[') || content.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(content);
      const rows = Array.isArray(data) ? data : (data.results || data.varieties || data.data || []);
      return rows.map(r => ({
        variety_name:  r.variety_name || r.name || r.cultivar || r.variety || null,
        maturity_days: r.maturity_days || r.maturity || r.days_to_maturity || null,
        yield_notes:   r.yield_notes   || r.yield || null,
        water_needs:   r.water_needs   || r.water || null,
        climate_notes: r.climate_notes || r.climate || r.notes || null,
        other_traits:  r.other_traits  || r.traits || null
      })).filter(r => r.variety_name);
    } catch {
      return [];
    }
  }

  // CSV — very basic (assumes header row: variety_name, maturity_days, ...)
  if (contentType?.includes('text/csv') || content.trimStart().startsWith('"') || content.includes(',')) {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
    return lines.slice(1).map(line => {
      const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i] || null; });
      return {
        variety_name:  obj.variety_name || obj.name || obj.cultivar || null,
        maturity_days: obj.maturity_days || obj.maturity || null,
        yield_notes:   obj.yield_notes   || obj.yield || null,
        water_needs:   obj.water_needs   || obj.water || null,
        climate_notes: obj.climate_notes || obj.climate || null,
        other_traits:  null
      };
    }).filter(r => r.variety_name);
  }

  return [];
}

// ── Upsert varieties into DB ───────────────────────────────────────────────────
async function upsertVarieties(db, speciesName, region, sourceName, sourceUrl, varieties) {
  const now = new Date().toISOString();
  let inserted = 0, updated = 0;

  for (const v of varieties) {
    if (!v.variety_name) continue;
    const existing = await db.get(
      'SELECT id FROM crop_varieties WHERE species_name=? AND variety_name=? AND region=? AND source_name=?',
      [speciesName, v.variety_name, region || null, sourceName]
    );

    const traitsJson = v.other_traits ? JSON.stringify(v.other_traits) : null;

    if (existing) {
      await db.run(
        `UPDATE crop_varieties SET maturity_days=?, yield_notes=?, water_needs=?, climate_notes=?,
         traits_json=?, source_url=?, last_scraped=?
         WHERE id=?`,
        [v.maturity_days || null, v.yield_notes || null, v.water_needs || null,
         v.climate_notes || null, traitsJson, sourceUrl, now, existing.id]
      );
      updated++;
    } else {
      await db.run(
        `INSERT INTO crop_varieties
         (species_name, variety_name, region, source_name, source_url, maturity_days,
          yield_notes, water_needs, climate_notes, traits_json, last_scraped)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [speciesName, v.variety_name, region || null, sourceName, sourceUrl,
         v.maturity_days || null, v.yield_notes || null, v.water_needs || null,
         v.climate_notes || null, traitsJson, now]
      );
      inserted++;
    }
  }

  return { inserted, updated };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(SOURCES_FILE)) {
    console.error(`Missing ${SOURCES_FILE}`);
    process.exit(1);
  }
  const sources = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !DRY_RUN) {
    console.error('ANTHROPIC_API_KEY not set in environment / .env file');
    process.exit(1);
  }

  const client = apiKey ? new Anthropic({ apiKey }) : null;
  const db = DRY_RUN ? null : await getDb();

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0, totalErrors = 0;

  for (const crop of sources) {
    if (CROP_FILTER && crop.common_name.toLowerCase() !== CROP_FILTER) continue;

    console.log(`\n── ${crop.common_name} (${crop.species_name})`);

    for (const src of crop.sources) {
      console.log(`  Fetching: ${src.name}`);
      console.log(`  URL: ${src.url}`);

      if (DRY_RUN) {
        console.log('  [dry-run] would fetch + process');
        continue;
      }

      // 1. Fetch content
      let content, contentType;
      try {
        content = await fetchUrl(src.url);
        contentType = null; // node http doesn't expose content-type easily here; infer from type field
      } catch (err) {
        console.error(`  ✗ Fetch failed: ${err.message}`);
        totalErrors++;
        continue;
      }

      // 2. Hash check
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const cached = await db.get('SELECT content_hash FROM variety_source_cache WHERE source_url=?', [src.url]);

      if (!FORCE && cached?.content_hash === hash) {
        console.log('  ✓ No change, skipping');
        totalSkipped++;
        continue;
      }

      // 3. Extract varieties
      let varieties = [];
      if (src.type === 'html') {
        if (!client) {
          console.error('  ✗ Cannot extract HTML without ANTHROPIC_API_KEY');
          totalErrors++;
          continue;
        }
        const text = stripHtml(content);
        console.log(`  Sending ${Math.min(text.length, MAX_CONTENT)} chars to Claude…`);
        try {
          varieties = await extractWithClaude(client, text, crop.species_name, src.name);
        } catch (err) {
          console.error(`  ✗ Claude error: ${err.message}`);
          totalErrors++;
          continue;
        }
      } else {
        varieties = parseStructured(content, contentType);
      }

      console.log(`  → ${varieties.length} varieties extracted`);

      // 4. Upsert into DB
      if (varieties.length > 0) {
        const { inserted, updated } = await upsertVarieties(
          db, crop.species_name, src.region, src.name, src.url, varieties
        );
        console.log(`  ✓ ${inserted} inserted, ${updated} updated`);
        totalInserted += inserted;
        totalUpdated  += updated;
      }

      // 5. Update cache
      const now = new Date().toISOString();
      const changed = !cached || cached.content_hash !== hash ? now : null;
      await db.run(
        `INSERT INTO variety_source_cache (source_url, content_hash, last_fetched, last_changed)
         VALUES (?,?,?,?)
         ON CONFLICT(source_url) DO UPDATE SET
           content_hash=excluded.content_hash,
           last_fetched=excluded.last_fetched,
           last_changed=COALESCE(excluded.last_changed, last_changed)`,
        [src.url, hash, now, changed]
      );
    }
  }

  if (db) await db.close();

  console.log('\n─────────────────────────────────────────');
  console.log(`Done. Inserted: ${totalInserted} | Updated: ${totalUpdated} | Skipped (no change): ${totalSkipped} | Errors: ${totalErrors}`);
  if (DRY_RUN) console.log('(dry-run mode — no DB writes)');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
