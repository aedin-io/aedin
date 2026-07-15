import type { EntityTraitClaim } from './queries-d1';

// A condensed, display-ready summary of all sourced claims for ONE trait of an
// entity. The full claims list (EntityClaimsTable) shows every individual
// sourced value; this aggregates them for the sidebar so multiple readings of,
// say, pH read as a single "5.5–7" range instead of five separate rows.
export type TraitSummary = {
  trait: string;
  label: string;
  kind: 'numeric' | 'list' | 'categorical';
  display: string;
  count: number; // number of source claims aggregated
};

// Only the value-bearing fields are needed to aggregate.
type ClaimValue = Pick<EntityTraitClaim, 'value_numeric' | 'value_text' | 'value_json' | 'unit'>;

function humanize(trait: string): string {
  return trait.replace(/_cm$/, ' (cm)').replace(/_kg_t$/, ' (kg/t)').replace(/_/g, ' ');
}

function parseJson(s: string | null): unknown {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Trim a numeric like 6.0 → "6" but keep 5.5.
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/**
 * Aggregate one trait's claims. Returns null if there is nothing displayable.
 *  - numeric (value_numeric, or a value_json {min,max} range)  → min–max envelope
 *  - list    (value_json arrays)                               → union of members
 *  - categorical (value_text)                                  → distinct values
 */
export function summarizeTrait(trait: string, claims: ClaimValue[]): TraitSummary | null {
  if (!claims.length) return null;
  const unit = claims.map((c) => c.unit).find((u) => u) || '';

  const nums: number[] = [];
  const listItems = new Set<string>();
  let sawList = false;
  const texts = new Set<string>();

  for (const c of claims) {
    if (c.value_numeric != null) nums.push(c.value_numeric);
    const j = parseJson(c.value_json);
    if (Array.isArray(j)) {
      sawList = true;
      for (const x of j) listItems.add(String(x));
    } else if (j && typeof j === 'object') {
      const o = j as Record<string, unknown>;
      if (typeof o.min === 'number') nums.push(o.min);
      if (typeof o.max === 'number') nums.push(o.max);
    }
    if (c.value_text != null && c.value_text !== '') texts.add(c.value_text);
  }

  if (nums.length) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const u = unit ? ` ${unit}` : '';
    const body = min === max ? fmtNum(min) : `${fmtNum(min)}–${fmtNum(max)}`;
    return { trait, label: humanize(trait), kind: 'numeric', count: claims.length, display: body + u };
  }
  if (sawList) {
    return { trait, label: humanize(trait), kind: 'list', count: claims.length, display: [...listItems].join(', ') };
  }
  if (texts.size) {
    return { trait, label: humanize(trait), kind: 'categorical', count: claims.length, display: [...texts].join(' / ') };
  }
  return null;
}

/** Summarize every trait in a by-trait_name map (the shape getTraitsForEntity returns). */
export function summarizeTraits(byTrait: Map<string, ClaimValue[]>): TraitSummary[] {
  const out: TraitSummary[] = [];
  for (const [trait, claims] of byTrait) {
    const s = summarizeTrait(trait, claims);
    if (s) out.push(s);
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
