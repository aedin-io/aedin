/**
 * run-role-agent.js
 *
 * LLM-powered role assignment agent. Uses Claude API to:
 *   1. Classify entities with no rule match (--unmatched)
 *   2. Classify a single entity (--entity ID)
 *   3. Review correction patterns and suggest new rules (--review-corrections)
 *
 * Usage:
 *   node run-role-agent.js --unmatched                # classify unmatched entities
 *   node run-role-agent.js --entity 12345             # classify single entity
 *   node run-role-agent.js --review-corrections       # analyze unreviewed corrections
 *   node run-role-agent.js --batch 20                 # process up to N (default 10)
 *   node run-role-agent.js --dry-run                  # show suggestions without applying
 *   node run-role-agent.js --model claude-sonnet-4-6  # override model (default sonnet)
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const Anthropic = require('@anthropic-ai/sdk');
const {
  computeInteractionProfile,
  preloadRules,
  evaluateRules,
  assignRole,
  logCorrection,
  getUnreviewedCorrections,
  markCorrectionsReviewed,
} = require('./lib/role-engine');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const PROMPT_PATH = path.join(__dirname, 'prompts', 'role-agent.md');

const client = new Anthropic();

function getArgValue(args, flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const mode = args.includes('--review-corrections') ? 'review'
    : args.includes('--entity') ? 'single'
    : args.includes('--biocontrol') ? 'biocontrol'
    : 'unmatched';
  const batchSize = parseInt(getArgValue(args, '--batch', '10'), 10);
  const entityId = getArgValue(args, '--entity', null);
  const model = getArgValue(args, '--model', 'claude-sonnet-4-6');

  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  console.log(`=== Role Agent (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`Mode: ${mode}, Model: ${model}, Batch: ${batchSize}\n`);

  if (mode === 'review') {
    await reviewCorrections(db, systemPrompt, model, dryRun);
  } else if (mode === 'single') {
    await classifySingle(db, parseInt(entityId, 10), systemPrompt, model, dryRun);
  } else if (mode === 'biocontrol') {
    await classifyBiocontrol(db, systemPrompt, model, batchSize, dryRun);
  } else {
    await classifyUnmatched(db, systemPrompt, model, batchSize, dryRun);
  }

  await db.close();
  console.log('\nDone.');
}

// ── Classify unmatched entities ─────────────────────────────────────────────

async function classifyUnmatched(db, systemPrompt, model, batchSize, dryRun) {
  const cache = await preloadRules(db);

  // Find entities with no rule match
  const entities = await db.all(`
    SELECT e.id, e.scientific_name, e.common_name, e.family, e.genus,
           e.bio_category, e.primary_role, e.kingdom, e.phylum, e.taxon_class, e.taxon_order, e.taxonomy_path
    FROM entities e
    LEFT JOIN role_assignment_log ral ON e.id = ral.entity_id
    WHERE e.parent_entity_id IS NULL
      AND (ral.entity_id IS NULL OR ral.assignment_source LIKE 'fallback%')
    LIMIT ?
  `, [batchSize * 5]); // fetch extra to filter

  // Filter to truly unmatched
  const unmatched = [];
  for (const e of entities) {
    const result = await evaluateRules(db, e, null, cache);
    if (!result && unmatched.length < batchSize) {
      const profile = await computeInteractionProfile(db, e.id);
      unmatched.push({ entity: e, profile });
    }
  }

  if (unmatched.length === 0) {
    console.log('No unmatched entities found (all have rule matches).');
    return;
  }

  console.log(`Found ${unmatched.length} unmatched entities. Calling Claude...\n`);

  // Build batch prompt
  const entityDescriptions = unmatched.map((u, i) => {
    const e = u.entity;
    const p = u.profile;
    return `### Entity ${i + 1}: ${e.scientific_name}
- **ID**: ${e.id}
- **Common name**: ${e.common_name || 'unknown'}
- **Bio category**: ${e.bio_category}
- **Family**: ${e.family || 'unknown'}
- **Genus**: ${e.genus || 'unknown'}
- **Kingdom**: ${e.kingdom || 'unknown'}
- **Class**: ${e.taxon_class || 'unknown'}
- **Order**: ${e.taxon_order || 'unknown'}
- **Current role**: ${e.primary_role}
- **Interaction profile (as subject)**: ${JSON.stringify(p.asSubject)} (total: ${p.totalSubject})
- **Interaction profile (as object)**: ${JSON.stringify(p.asObject)} (total: ${p.totalObject})`;
  }).join('\n\n');

  const userPrompt = `Classify the following ${unmatched.length} entities. For each, provide a JSON object with role, confidence, and reasoning.

Return a JSON array (one object per entity, in order):

${entityDescriptions}

Respond with ONLY a JSON array, no markdown, no explanation.`;

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = msg.content[0]?.text?.trim() || '';
  let results;
  try {
    // Strip markdown code fences if present
    const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    results = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse Claude response:', err.message);
    console.error('Raw response:', raw.substring(0, 500));
    return;
  }

  if (!Array.isArray(results)) {
    console.error('Expected JSON array, got:', typeof results);
    return;
  }

  // Apply results
  let applied = 0;
  for (let i = 0; i < Math.min(results.length, unmatched.length); i++) {
    const r = results[i];
    const e = unmatched[i].entity;
    const p = unmatched[i].profile;

    console.log(`${e.scientific_name} (${e.bio_category}/${e.family || '?'}):`);
    console.log(`  Role: ${r.role} (confidence: ${r.confidence})`);
    console.log(`  Reasoning: ${r.reasoning}`);

    if (r.confidence >= 0.7 && r.role) {
      if (!dryRun) {
        const oldRole = e.primary_role;
        await assignRole(db, e.id, r.role, `agent:${r.confidence}`, {
          confidence: r.confidence,
          profile: p,
        });
        if (oldRole !== r.role) {
          await logCorrection(db, e.id, e.scientific_name, oldRole, r.role, 'agent', r.reasoning);
        }
      }
      console.log(`  -> ${dryRun ? 'WOULD APPLY' : 'APPLIED'}`);
      applied++;
    } else {
      console.log(`  -> SKIPPED (low confidence or no role)`);
    }
    console.log('');
  }

  console.log(`Applied: ${applied}/${results.length}`);
}

// ── Classify biocontrol-relevant entities ───────────────────────────────────

async function classifyBiocontrol(db, systemPrompt, model, batchSize, dryRun) {
  // Target: unclassified entities that appear as subjects in biocontrol claims
  // These are organisms the data says are doing biocontrol but have no role assignment
  const entities = await db.all(`
    SELECT DISTINCT e.id, e.scientific_name, e.common_name, e.family, e.genus,
           e.bio_category, e.primary_role, e.kingdom, e.phylum, e.taxon_class, e.taxon_order, e.taxonomy_path
    FROM entities e
    JOIN claims c ON c.subject_entity_id = e.id
    WHERE c.interaction_category = 'biocontrol'
      AND e.primary_role IN ('unclassified', 'neutral')
      AND e.parent_entity_id IS NULL
    ORDER BY e.scientific_name
    LIMIT ?
  `, [batchSize]);

  if (entities.length === 0) {
    console.log('No unclassified biocontrol-relevant entities found.');
    return;
  }

  console.log(`Found ${entities.length} unclassified entities with biocontrol claims.\n`);

  // Process in sub-batches of 20 (to fit in context window)
  const subBatchSize = 20;
  let totalApplied = 0;

  for (let offset = 0; offset < entities.length; offset += subBatchSize) {
    const batch = entities.slice(offset, offset + subBatchSize);
    console.log(`--- Sub-batch ${Math.floor(offset / subBatchSize) + 1} (${batch.length} entities) ---\n`);

    // Build profiles and descriptions
    const items = [];
    for (const e of batch) {
      const profile = await computeInteractionProfile(db, e.id);
      items.push({ entity: e, profile });
    }

    const entityDescriptions = items.map((u, i) => {
      const e = u.entity;
      const p = u.profile;
      return `### Entity ${i + 1}: ${e.scientific_name}
- **ID**: ${e.id}
- **Common name**: ${e.common_name || 'unknown'}
- **Bio category**: ${e.bio_category}
- **Family**: ${e.family || 'unknown'}
- **Genus**: ${e.genus || 'unknown'}
- **Kingdom**: ${e.kingdom || 'unknown'}
- **Class**: ${e.taxon_class || 'unknown'}
- **Order**: ${e.taxon_order || 'unknown'}
- **Current role**: ${e.primary_role}
- **Interaction profile (as subject)**: ${JSON.stringify(p.asSubject)} (total: ${p.totalSubject})
- **Interaction profile (as object)**: ${JSON.stringify(p.asObject)} (total: ${p.totalObject})`;
    }).join('\n\n');

    const userPrompt = `Classify the following ${batch.length} entities. These are organisms that appear as subjects in biocontrol claims — they are eating/parasitizing other organisms in the database.

For each, provide a JSON object with role, confidence (0.0-1.0), and reasoning.

Also, if you see a pattern where multiple entities from the same genus should share a role, include a "suggested_rule" object with: rule_type ("taxonomy_genus"), match_value (the genus name, lowercase), assigned_role, priority (70), and reason.

Return a JSON array (one object per entity, in order):

${entityDescriptions}

Respond with ONLY a JSON array, no markdown, no explanation.`;

    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const raw = msg.content[0]?.text?.trim() || '';
      let results;
      try {
        const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
        results = JSON.parse(jsonStr);
      } catch (err) {
        console.error('Failed to parse Claude response:', err.message);
        console.error('Raw response:', raw.substring(0, 500));
        continue;
      }

      if (!Array.isArray(results)) {
        console.error('Expected JSON array, got:', typeof results);
        continue;
      }

      let batchApplied = 0;
      const suggestedRules = new Map();

      for (let i = 0; i < Math.min(results.length, items.length); i++) {
        const r = results[i];
        const e = items[i].entity;
        const p = items[i].profile;

        console.log(`${e.scientific_name} (${e.bio_category}/${e.family || '?'}):`);
        console.log(`  Role: ${r.role} (confidence: ${r.confidence})`);
        console.log(`  Reasoning: ${r.reasoning}`);

        if (r.confidence >= 0.7 && r.role) {
          if (!dryRun) {
            const oldRole = e.primary_role;
            await assignRole(db, e.id, r.role, `agent:${r.confidence}`, {
              confidence: r.confidence,
              profile: p,
            });
            if (oldRole !== r.role) {
              await logCorrection(db, e.id, e.scientific_name, oldRole, r.role, 'agent', r.reasoning);
            }
          }
          console.log(`  -> ${dryRun ? 'WOULD APPLY' : 'APPLIED'}`);
          batchApplied++;
        } else {
          console.log(`  -> SKIPPED (low confidence or no role)`);
        }

        // Collect suggested rules
        if (r.suggested_rule && r.suggested_rule.match_value) {
          const key = r.suggested_rule.match_value.toLowerCase();
          if (!suggestedRules.has(key)) suggestedRules.set(key, r.suggested_rule);
        }

        console.log('');
      }

      // Insert suggested genus rules
      if (suggestedRules.size > 0 && !dryRun) {
        console.log(`\nInserting ${suggestedRules.size} suggested genus rules...`);
        for (const [, rule] of suggestedRules) {
          try {
            const ins = await db.run(`
              INSERT INTO role_rules (rule_type, match_field, match_value, assigned_role, priority, reason, source)
              VALUES (?, 'genus', ?, ?, ?, ?, 'agent')
            `, [rule.rule_type || 'taxonomy_genus', rule.match_value.toLowerCase(), rule.assigned_role, rule.priority || 70, rule.reason || '']);
            console.log(`  + ${rule.match_value} -> ${rule.assigned_role} (rule #${ins.lastID})`);
          } catch (err) {
            if (err.message.includes('UNIQUE')) {
              console.log(`  ~ ${rule.match_value} -> ${rule.assigned_role} (already exists)`);
            } else {
              console.log(`  ! ${rule.match_value}: ${err.message}`);
            }
          }
        }
      }

      totalApplied += batchApplied;
      console.log(`Sub-batch applied: ${batchApplied}/${results.length}\n`);
    } catch (err) {
      console.error(`API error in sub-batch: ${err.message}`);
      continue;
    }
  }

  console.log(`\nTotal applied: ${totalApplied}/${entities.length}`);
}

// ── Classify single entity ──────────────────────────────────────────────────

async function classifySingle(db, entityId, systemPrompt, model, dryRun) {
  const entity = await db.get('SELECT * FROM entities WHERE id = ?', [entityId]);
  if (!entity) {
    console.error('Entity not found:', entityId);
    return;
  }

  const profile = await computeInteractionProfile(db, entityId);

  console.log(`Entity: ${entity.scientific_name} (${entity.bio_category}/${entity.family || '?'})`);
  console.log(`Current role: ${entity.primary_role}`);
  console.log(`Profile: ${JSON.stringify(profile)}\n`);

  const userPrompt = `Classify this entity:

- **Scientific name**: ${entity.scientific_name}
- **Common name**: ${entity.common_name || 'unknown'}
- **Bio category**: ${entity.bio_category}
- **Family**: ${entity.family || 'unknown'}
- **Genus**: ${entity.genus || 'unknown'}
- **Kingdom**: ${entity.kingdom || 'unknown'}
- **Class**: ${entity.taxon_class || 'unknown'}
- **Order**: ${entity.taxon_order || 'unknown'}
- **Current role**: ${entity.primary_role}
- **Interaction profile (as subject)**: ${JSON.stringify(profile.asSubject)} (total: ${profile.totalSubject})
- **Interaction profile (as object)**: ${JSON.stringify(profile.asObject)} (total: ${profile.totalObject})

Respond with a single JSON object: { "role": "...", "confidence": 0.0-1.0, "reasoning": "...", "suggested_rules": [...] }`;

  const msg = await client.messages.create({
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = msg.content[0]?.text?.trim() || '';
  let result;
  try {
    const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    result = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse response:', raw.substring(0, 500));
    return;
  }

  console.log('Agent response:');
  console.log(`  Role: ${result.role} (confidence: ${result.confidence})`);
  console.log(`  Reasoning: ${result.reasoning}`);

  if (result.suggested_rules && result.suggested_rules.length > 0) {
    console.log('  Suggested rules:');
    for (const rule of result.suggested_rules) {
      console.log(`    ${rule.rule_type}: ${rule.match_value} -> ${rule.assigned_role} (${rule.reason})`);
    }
  }

  if (!dryRun && result.role && result.confidence >= 0.7) {
    const oldRole = entity.primary_role;
    await assignRole(db, entity.id, result.role, `agent:${result.confidence}`, {
      confidence: result.confidence,
      profile,
    });
    if (oldRole !== result.role) {
      await logCorrection(db, entity.id, entity.scientific_name, oldRole, result.role, 'agent', result.reasoning);
    }
    console.log(`\n-> Applied: ${oldRole} -> ${result.role}`);
  } else if (dryRun) {
    console.log('\n-> DRY RUN (not applied)');
  } else {
    console.log('\n-> Not applied (low confidence)');
  }
}

// ── Review corrections ──────────────────────────────────────────────────────

async function reviewCorrections(db, systemPrompt, model, dryRun) {
  const corrections = await getUnreviewedCorrections(db);
  if (corrections.length === 0) {
    console.log('No unreviewed corrections found.');
    return;
  }

  console.log(`Found ${corrections.length} unreviewed corrections.\n`);

  // Group by family
  const byFamily = {};
  for (const c of corrections) {
    const key = c.family || 'unknown';
    if (!byFamily[key]) byFamily[key] = [];
    byFamily[key].push(c);
  }

  // Build summary
  const correctionSummary = Object.entries(byFamily).map(([family, items]) => {
    const changes = items.map(c => `${c.scientific_name}: ${c.old_role} -> ${c.new_role}${c.reason ? ' (' + c.reason + ')' : ''}`);
    return `**Family ${family}** (${items.length} corrections, bio_category: ${items[0].bio_category}):\n${changes.map(ch => '  - ' + ch).join('\n')}`;
  }).join('\n\n');

  // Load current rules for context
  const currentRules = await db.all('SELECT rule_type, match_value, assigned_role, priority FROM role_rules WHERE enabled = 1 ORDER BY priority DESC LIMIT 50');
  const rulesContext = currentRules.map(r => `${r.rule_type}: ${r.match_value} -> ${r.assigned_role} (pri=${r.priority})`).join('\n');

  const userPrompt = `Review these manual corrections and identify patterns that should become new rules.

## Corrections to review:
${correctionSummary}

## Current rules (top 50 by priority):
${rulesContext}

Analyze the corrections and respond with JSON:
{
  "patterns": [
    {
      "description": "...",
      "suggested_rule": {
        "rule_type": "taxonomy_family|taxonomy_genus|...",
        "match_field": "family|genus|...",
        "match_value": "...",
        "assigned_role": "...",
        "priority": 50,
        "reason": "..."
      },
      "affected_count": N
    }
  ],
  "one_offs": [
    { "entity": "...", "reason": "..." }
  ],
  "summary": "Brief summary of findings"
}`;

  console.log('Calling Claude for correction analysis...\n');

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = msg.content[0]?.text?.trim() || '';
  let result;
  try {
    const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    result = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse response:', raw.substring(0, 500));
    return;
  }

  console.log('=== Correction Analysis ===\n');
  console.log(result.summary || '(no summary)');

  if (result.patterns && result.patterns.length > 0) {
    console.log('\nPatterns found:');
    for (const p of result.patterns) {
      console.log(`\n  ${p.description}`);
      if (p.suggested_rule) {
        const r = p.suggested_rule;
        console.log(`  -> Suggested rule: ${r.rule_type} ${r.match_field}=${r.match_value} -> ${r.assigned_role} (pri=${r.priority})`);
        console.log(`     Reason: ${r.reason}`);
        console.log(`     Would affect ~${p.affected_count} entities`);

        if (!dryRun) {
          // Insert the suggested rule
          try {
            const ins = await db.run(`
              INSERT INTO role_rules (rule_type, match_field, match_value, assigned_role, priority, reason, source)
              VALUES (?, ?, ?, ?, ?, ?, 'agent')
            `, [r.rule_type, r.match_field, r.match_value, r.assigned_role, r.priority || 50, r.reason]);
            console.log(`     INSERTED as rule #${ins.lastID}`);
          } catch (err) {
            console.log(`     SKIPPED (${err.message})`);
          }
        }
      }
    }
  }

  if (result.one_offs && result.one_offs.length > 0) {
    console.log('\nOne-off corrections (no pattern):');
    for (const o of result.one_offs) {
      console.log(`  - ${o.entity}: ${o.reason}`);
    }
  }

  // Mark corrections as reviewed
  if (!dryRun) {
    const ids = corrections.map(c => c.id);
    await markCorrectionsReviewed(db, ids);
    console.log(`\nMarked ${ids.length} corrections as reviewed.`);
  }
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
