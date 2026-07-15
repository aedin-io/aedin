'use strict';

/**
 * critic-prompts.js — Phase 2.5
 *
 * Generates a runtime "vouch this claim" prompt for any of the 5 specialty
 * critic agents (.claude/agents/{name}.md), using each agent's frontmatter
 * `description` as the identity prelude. Output contract is identical to
 * extractor-vouch (4-class JSON verdict) so vouch-staged-claims.js's parser
 * works unchanged.
 *
 * Why programmatic prompts instead of separate .md files per critic?
 *   The 5 specialty critic .md files are also used as runtime agents (Claude
 *   Code's Agent tool dispatches them for ad-hoc deep audits — see CLAUDE.md
 *   "two flavors: prompt-as-data (extractor, extractor-vouch) and runtime
 *   critic"). Forking each into a "*-vouch.md" prompt-as-data sibling would
 *   double the maintenance surface and let the two variants drift. Instead we
 *   compose the dispatch prompt at runtime from the agent's description, and
 *   the runtime variant stays the canonical home of the agent's identity.
 */

const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.resolve(__dirname, '../../.claude/agents');

const CRITIC_MODEL_DEFAULT = 'claude-sonnet-4-6';

const VERDICT_CONTRACT = `verdict ∈ { plausible | implausible | uncertain | out_of_scope }
- plausible: biologically reasonable AND source quote supports the structured fields. Default for typical in-specialty claims.
- implausible: clear biological/taxonomic error in your specialty; source contradicts the fields; direction inverted; entity types mismatch.
- uncertain: not obviously right or wrong; key facts unverifiable from your knowledge + the source quote.
- out_of_scope: outside your specialty (name who should review) OR not agroecological. Do NOT default to plausible for claims you can't evaluate.

Return ONE JSON object (no markdown, no preamble):
{"verdict":"plausible|implausible|uncertain|out_of_scope",
 "critic_confidence": <0.0-1.0>,
 "evidence_strength":"strong|moderate|weak|none",
 "reasoning":"one sentence (≤30 words)"}`;

let _agentCache = null;

function _loadAgentDescriptions() {
  if (_agentCache) return _agentCache;
  const critics = ['agroecologist', 'entomologist', 'plant-pathologist', 'soil-scientist', 'horticulturist', 'wildlife-ecologist'];
  const out = {};
  for (const name of critics) {
    const file = path.join(AGENTS_DIR, `${name}.md`);
    if (!fs.existsSync(file)) {
      throw new Error(`critic-prompts: agent file missing at ${file}`);
    }
    const raw = fs.readFileSync(file, 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fm) throw new Error(`critic-prompts: ${name}.md has no frontmatter`);
    const frontmatter = fm[1];
    const descMatch = frontmatter.match(/^description:\s*(?:"([^"]*)"|'([^']*)'|(.+))$/m);
    const description = descMatch
      ? (descMatch[1] !== undefined ? descMatch[1] : descMatch[2] !== undefined ? descMatch[2] : descMatch[3]).trim()
      : '';
    if (!description) throw new Error(`critic-prompts: ${name}.md frontmatter missing description`);
    out[name] = { name, description };
  }
  _agentCache = out;
  return out;
}

/**
 * renderPayloadForPrompt(targetTable, payload) → string
 *
 * Converts a staging payload into a human-readable claim block for the critic.
 * targetTable selects the rendering branch; unrecognized tables fall back to
 * JSON serialization so unknown shapes are never silently dropped.
 */
function renderPayloadForPrompt(targetTable, payload) {
  if (targetTable === 'entity_trait') {
    const value = payload.value_numeric ?? payload.value_text ?? payload.value_json ?? '(?)';
    return [
      `ENTITY: ${payload.scientific_name} (${payload.common_name || 'no common name'})`,
      `TRAIT: ${payload.trait_name} = ${value}${payload.unit ? ' ' + payload.unit : ''}`,
      `REGION: ${payload.regional_context || 'Global'}`,
      `EXTRACTED_CLAIM: ${payload.extracted_claim || ''}`,
      `SOURCE_QUOTE: "${payload.source_quote || ''}" (p.${payload.source_page ?? '?'})`,
    ].join('\n');
  }
  if (targetTable === 'attractor_relationship') {
    return [
      `SUBJECT: ${payload.subject_organism}`,
      `OBJECT: ${payload.object_organism}`,
      `CATEGORY: ${payload.interaction_category}`,
      `IMPACT_CLASS: ${payload.impact_class || 'unspecified'}`,
      `MECHANISM: ${payload.mechanism || ''}`,
      `EXTRACTED_CLAIM: ${payload.extracted_claim || ''}`,
      `SOURCE_QUOTE: "${payload.source_quote || ''}" (p.${payload.source_page ?? '?'})`,
    ].join('\n');
  }
  // Existing branches: interactions, crop_vulnerabilities, and generic fallback
  if (targetTable === 'interactions' || targetTable === 'crop_vulnerabilities') {
    return JSON.stringify(payload, null, 2);
  }
  // Unknown table — serialize so nothing is silently dropped
  return JSON.stringify(payload, null, 2);
}

/**
 * getRecentCorrectionsForPrompt(db, options = {}) → Promise<string>
 *
 * Fetches recent staging_field_corrections rows and formats them as a
 * human-readable block for injection into critic prompts. Returns '' when the
 * table is empty or the DB doesn't have the table yet.
 *
 * options.limit   — max rows to fetch (default 30)
 * options.maxChars — soft cap on total output characters (default 1500)
 */
async function getRecentCorrectionsForPrompt(db, options = {}) {
  const limit = options.limit || 30;
  const maxChars = options.maxChars || 1500;
  let rows;
  try {
    rows = await db.all(`
      SELECT field_path, action, original_value, corrected_value, note, created_at
      FROM staging_field_corrections
      ORDER BY created_at DESC
      LIMIT ?
    `, [limit]);
  } catch {
    // Table may not exist in test DBs; return empty string gracefully.
    return '';
  }
  if (!rows || !rows.length) return '';

  const lines = [];
  let totalChars = 0;
  for (const r of rows) {
    let line;
    if (r.action === 'edited') {
      line = `  - Field "${r.field_path}": original "${_truncate(r.original_value, 80)}" → corrected to "${_truncate(r.corrected_value, 80)}"`;
    } else if (r.action === 'rejected') {
      const note = r.note && String(r.note).trim() ? String(r.note).trim() : 'correct answer unknown / not stated in source';
      line = `  - Field "${r.field_path}": original "${_truncate(r.original_value, 80)}" rejected — ${_truncate(note, 100)}`;
    } else if (r.action === 'correct') {
      line = `  - Field "${r.field_path}": "${_truncate(r.original_value, 80)}" — confirmed correct`;
    } else {
      continue;
    }
    if (totalChars + line.length > maxChars) break;
    lines.push(line);
    totalChars += line.length + 1;
  }
  if (!lines.length) return '';
  return `\nRECENT REVIEWER CORRECTIONS (from prior verification work — use these as guidance for similar judgments):\n${lines.join('\n')}\n`;
}

/**
 * loadCriticIdentity(name) → { name, description }
 * Exposes one critic's frontmatter identity (the same source buildCriticPrompt
 * uses) so sibling prompt-composers (e.g. dedup) reuse it without re-parsing.
 */
function loadCriticIdentity(name) {
  const agents = _loadAgentDescriptions();
  const a = agents[name];
  if (!a) throw new Error(`critic-prompts: unknown critic '${name}'`);
  return { name: a.name, description: a.description };
}

function _truncate(s, n) {
  if (s == null) return '(null)';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * buildCriticPrompt(criticName, opts = {}) →
 *   { systemPrompt, body, model, name }
 *
 * opts.targetTable + opts.payload: when both are provided, {{CLAIM}} is
 * substituted inline via renderPayloadForPrompt(targetTable, payload) so
 * callers get a fully-rendered prompt. When omitted the body retains the
 * {{CLAIM}} placeholder — used by batch-prepare scripts that embed one
 * template and let the subagent substitute per-claim at runtime.
 *
 * opts.recentCorrections: optional string returned by getRecentCorrectionsForPrompt().
 * When provided it is injected between the specialty-focus section and the claim.
 */
function buildCriticPrompt(criticName, opts = {}) {
  const agents = _loadAgentDescriptions();
  const agent = agents[criticName];
  if (!agent) throw new Error(`critic-prompts: unknown critic '${criticName}'`);

  const model = opts.model || CRITIC_MODEL_DEFAULT;

  const systemPrompt =
    `You are the ${agent.name} critic in AgroEco's multi-critic consensus pipeline. ` +
    `Specialty: ${agent.description} ` +
    `Return ONE JSON object, no markdown. Verify only what is checkable from taxonomy + ecology training + the source quote; do not invent or speculate; do not defer to a source that is itself biologically implausible.`;

  const correctionsBlock = opts.recentCorrections || '';

  // The agroecologist is the cross-domain SYNTHESIZER and is ALWAYS one of the
  // two critics, so it is the load-bearing voice for the ≥2-plausible consensus
  // gate. A generic "out_of_scope if outside your specialty" makes it wrongly
  // abstain on narrow crop-trait values (days-to-harvest, pH, optimal temp),
  // which caps the claim at 1 plausible and structurally blocks promotion no
  // matter how the specialist votes. So it gets a wide-scope instruction; the
  // four specialists keep the honest-abstention rule (their out_of_scope is the
  // routing signal we want). See docs/phase-3-passlog.md Pass 13 post-mortem #1.
  const scopeInstruction = agent.name === 'agroecologist'
    ? `As the cross-domain synthesizer you are in scope for ANY agroecological claim — interactions, organism biology, AND crop-trait / agronomic values (days-to-harvest, pH, temperature envelopes, growth habit, uses, hardiness). Judge its biological/agronomic plausibility. Do NOT return \`out_of_scope\` merely because a claim is narrow, horticultural, or a single trait value — that is still within your remit. Reserve \`out_of_scope\` only for genuinely non-agroecological content (e.g. code, unrelated chemistry).`
    : `Evaluate parts that intersect your specialty; return \`out_of_scope\` if the claim is entirely outside it. An honest out_of_scope is more useful than a noisy plausible.`;

  const body =
    `# Multi-critic vouching — ${agent.name}\n\n` +
    `Evaluate ONE extracted agroecological claim for **plausibility within your specialty** (not truth).\n\n` +
    `## Verdict\n${VERDICT_CONTRACT}\n\n` +
    `## Checks\n` +
    `1. Entity types fit the role (predator=animal that predates; pathogen = ANY canonical plant-pathogen class — fungus/oomycete, bacterium/phytoplasma, virus/viroid, NEMATODE, or PARASITIC PLANT (per Agrios); crop=cultivated plant; pollinator=flower-visiting animal). Plant-parasitic nematodes (Meloidogyne, Heterodera, Pratylenchus, Radopholus, …) and parasitic plants (Cuscuta, Striga, Orobanche, …) ARE plant pathogens — a pathogen / pathogen_pressure framing for them is VALID; do NOT mark implausible or out_of_scope on "it is a pest / an animal / an angiosperm, not a pathogen" grounds (the only legitimate caveat is host-range overreach). They are simultaneously "pests" in the IPM management sense and "pathogens" in the etiological sense; this corpus uses the pathology framing.\n` +
    `2. Subject/object direction not inverted (common extraction error).\n` +
    `3. Stage-dependent roles (Lepidoptera larva ≠ adult; nymph ≠ adult).\n` +
    `4. Source quote supports the structured fields; flag inconsistency.\n` +
    `5. Eponymous-pathogen: if a virus name contains the host name as substring, confirm direction.\n` +
    `6. Species-from-common-name: if the structured claim names a SPECIES (binomial) but the source quote only contains a COMMON NAME with no binomial, mark implausible — the extractor likely guessed. Family/genus rank with confidence_score ≤0.6 is acceptable; a confident species is not (closes the Pass-12 / Pass-13 bug class).\n\n` +
    `## Your specialty\n${agent.description}\n\n` +
    `${scopeInstruction}\n` +
    correctionsBlock +
    `\n## Claim\n{{CLAIM}}\n`;

  // Substitute {{CLAIM}} inline when caller supplies targetTable + payload.
  // Leave the placeholder intact when omitted (batch-template mode).
  const renderedBody = (opts.targetTable != null && opts.payload != null)
    ? body.replace('{{CLAIM}}', renderPayloadForPrompt(opts.targetTable, opts.payload))
    : body;

  return { name: agent.name, systemPrompt, body: renderedBody, model };
}

/**
 * One-line entity-resolution annotation for the critic prompt. Empty string
 * for pre-Grounding rows (status null) so existing behavior is unchanged.
 */
function renderResolutionAnnotation(status, { subject, object }) {
  if (!status) return '';
  const fmt = id => (id ? `resolved(#${id})` : 'unresolved');
  return `Entity resolution: overall=${status}; subject=${fmt(subject)}, object=${fmt(object)}.`;
}

module.exports = { buildCriticPrompt, getRecentCorrectionsForPrompt, renderPayloadForPrompt, renderResolutionAnnotation, loadCriticIdentity, CRITIC_MODEL_DEFAULT };
