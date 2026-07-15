/**
 * fix-trailing-periods-and-varieties.js
 *
 * Two fixes:
 *   1. Entities ending with a trailing period — strip the period.
 *      If stripping creates a duplicate, merge claims into existing entity and delete.
 *   2. Entities matching "Genus species var. X" / "Genus species subsp. X" / "Genus species f. X"
 *      — link as child variety under the parent "Genus species" entity.
 *
 * Usage:
 *   node fix-trailing-periods-and-varieties.js --dry-run   # preview
 *   node fix-trailing-periods-and-varieties.js             # apply
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

// Match "Genus species var. epithet", "Genus species subsp. epithet", "Genus species f. epithet"
// But NOT "f. sp." (forma specialis — a pathogen designation, not a variety)
// Allows hyphenated epithets (plantago-aquatica), × hybrid markers, and author citations before rank
const INFRASPECIFIC_RE = /^([A-Z][a-z]+ ×?[a-z][a-z-]+)(?:\s+[^(]*?)?\s+(var\.|subsp\.|f\.)\s+(\S+.*)$/;

function parseInfraspecific(name) {
  // Skip forma specialis (f. sp.) — these are pathogen host-form designations, not varieties
  if (/\bf\.\s*sp\./.test(name)) return null;
  const m = name.match(INFRASPECIFIC_RE);
  if (!m) return null;
  return { parentName: m[1], rank: m[2], epithet: m[3].trim() };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');

  console.log(`=== Fix Trailing Periods & Link Varieties ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  // ── Part 1: Trailing periods ────────────────────────────────────────────────
  const periodEntities = await db.all(`
    SELECT id, scientific_name FROM entities
    WHERE scientific_name LIKE '%.'
      AND parent_entity_id IS NULL
    ORDER BY scientific_name
  `);

  let stripped = 0, merged = 0, skippedPeriod = 0;
  const mergeLog = [];

  for (const e of periodEntities) {
    const name = e.scientific_name;
    const clean = name.replace(/\.$/, '').trim();

    // Skip if stripping leaves an empty or unchanged name
    if (!clean || clean === name) { skippedPeriod++; continue; }
    // Skip abbreviated genus entries like "Lobelia c" — these are garbage handled elsewhere
    if (/^[A-Z][a-z]+ [a-z]$/.test(clean)) { skippedPeriod++; continue; }
    // Skip author citation endings (e.g. "Fairm.", "Spreng.", "Everh.")
    // These typically have 3+ words where the last word is a short author abbreviation
    const words = clean.split(' ');
    if (words.length >= 3) {
      const lastWord = words[words.length - 1];
      // Author abbreviations: short capitalized word that was followed by period
      // e.g. "Phomopsis nicotianea Fairm" — the period was on author name
      if (/^[A-Z][a-z]{0,10}$/.test(lastWord) && words.length >= 3) {
        // This is "Genus species Author." — strip author entirely to get clean binomial
        // But only if the first two words look like a binomial
        if (/^[A-Z][a-z]+$/.test(words[0]) && /^[a-z]+$/.test(words[1])) {
          const binomial = words[0] + ' ' + words[1];
          // Check if binomial exists
          const existing = await db.get(
            'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE AND parent_entity_id IS NULL', [binomial]
          );
          if (existing) {
            // Merge into existing binomial
            if (!dryRun) {
              await db.run('UPDATE claims SET subject_entity_id = ? WHERE subject_entity_id = ?', [existing.id, e.id]);
              await db.run('UPDATE claims SET object_entity_id = ? WHERE object_entity_id = ?', [existing.id, e.id]);
              await db.run('DELETE FROM entities WHERE id = ?', e.id);
            }
            mergeLog.push(`  ${name} → merged into "${binomial}" (id ${existing.id})`);
            merged++;
            continue;
          } else {
            // Rename to just the binomial
            if (!dryRun) {
              await db.run('UPDATE entities SET scientific_name = ? WHERE id = ?', [binomial, e.id]);
            }
            stripped++;
            continue;
          }
        }
      }
    }

    // Simple trailing period on a binomial: "Lasthenia platyglossa." → "Lasthenia platyglossa"
    if (/^[A-Z][a-z]+ [a-z]+$/.test(clean)) {
      const existing = await db.get(
        'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE AND parent_entity_id IS NULL', [clean]
      );
      if (existing) {
        if (!dryRun) {
          await db.run('UPDATE claims SET subject_entity_id = ? WHERE subject_entity_id = ?', [existing.id, e.id]);
          await db.run('UPDATE claims SET object_entity_id = ? WHERE object_entity_id = ?', [existing.id, e.id]);
          await db.run('DELETE FROM entities WHERE id = ?', e.id);
        }
        mergeLog.push(`  ${name} → merged into "${clean}" (id ${existing.id})`);
        merged++;
      } else {
        if (!dryRun) {
          await db.run('UPDATE entities SET scientific_name = ? WHERE id = ?', [clean, e.id]);
        }
        stripped++;
      }
      continue;
    }

    // Anything else ending with period that doesn't fit above patterns — skip
    skippedPeriod++;
  }

  console.log('Part 1: Trailing Periods');
  console.log(`  Total found:   ${periodEntities.length}`);
  console.log(`  Stripped:       ${stripped}`);
  console.log(`  Merged (dupes): ${merged}`);
  console.log(`  Skipped:        ${skippedPeriod}`);
  if (mergeLog.length > 0 && mergeLog.length <= 30) {
    console.log('  Merges:');
    for (const l of mergeLog) console.log(l);
  }

  // ── Part 2: Link infraspecific entities as varieties ────────────────────────
  const candidates = await db.all(`
    SELECT id, scientific_name, bio_category, primary_role FROM entities
    WHERE parent_entity_id IS NULL
      AND (scientific_name LIKE '% var. %'
        OR scientific_name LIKE '% subsp. %'
        OR (scientific_name LIKE '% f. %' AND scientific_name NOT LIKE '%f. sp.%'))
    ORDER BY scientific_name
  `);

  let linked = 0, parentsCreated = 0, skippedVar = 0;
  const rankCounts = { 'var.': 0, 'subsp.': 0, 'f.': 0 };

  for (const e of candidates) {
    const parsed = parseInfraspecific(e.scientific_name);
    if (!parsed) { skippedVar++; continue; }

    // Find or create parent entity
    let parent = await db.get(
      'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE AND parent_entity_id IS NULL',
      [parsed.parentName]
    );

    if (!parent) {
      if (!dryRun) {
        await db.run(`
          INSERT INTO entities (scientific_name, bio_category, primary_role, source_table, data_completeness, created_at, updated_at)
          VALUES (?, ?, ?, 'globi', 'minimal', datetime('now'), datetime('now'))
        `, [parsed.parentName, e.bio_category || 'other', e.primary_role || 'unclassified']);
        parent = await db.get('SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE AND parent_entity_id IS NULL', [parsed.parentName]);
      }
      parentsCreated++;
    }

    if (parent || dryRun) {
      const varName = `${parsed.rank} ${parsed.epithet}`;
      if (!dryRun) {
        await db.run(
          'UPDATE entities SET parent_entity_id = ?, variety_name = ? WHERE id = ?',
          [parent.id, varName, e.id]
        );
      }
      rankCounts[parsed.rank]++;
      linked++;
    }
  }

  console.log('\nPart 2: Infraspecific → Varieties');
  console.log(`  Total candidates: ${candidates.length}`);
  console.log(`  Linked:           ${linked}`);
  console.log(`  Parents created:  ${parentsCreated}`);
  console.log(`  Skipped:          ${skippedVar}`);
  console.log(`  By rank:  var.: ${rankCounts['var.']}  subsp.: ${rankCounts['subsp.']}  f.: ${rankCounts['f.']}`);

  if (!dryRun) {
    const total = await db.get('SELECT COUNT(*) as c FROM entities WHERE parent_entity_id IS NULL');
    const varieties = await db.get('SELECT COUNT(*) as c FROM entities WHERE parent_entity_id IS NOT NULL');
    console.log(`\nAfter fix:`);
    console.log(`  Parent entities:  ${total.c}`);
    console.log(`  Variety entities: ${varieties.c}`);
  }

  await db.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
