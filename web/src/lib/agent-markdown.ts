// "Markdown for Agents" — shared content negotiation + per-page markdown
// serializers. An agent that sends `Accept: text/markdown` gets a clean markdown
// representation of the same data the HTML page renders; browsers fall through to
// HTML. This is the free public agent-discovery surface — NOT a replacement for
// the metered API.
//
// Responses are `no-store`: Cloudflare's edge cache does NOT vary on Accept, so a
// cached HTML/markdown response would cross-contaminate representations. SSR pages
// run the worker per request today (cf-cache-status: DYNAMIC), so this is correct.
// CAVEAT: if a real edge Cache Rule is ever added for these routes, it MUST key on
// Accept, or cached HTML will start being served to agents and break negotiation.

export function wantsMarkdown(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/markdown');
}

export function markdownResponse(markdown: string): Response {
  return new Response(markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'x-markdown-tokens': String(Math.ceil(markdown.length / 4)),
      'cache-control': 'no-store',
      vary: 'accept',
    },
  });
}

// Convenience for SSR pages: returns a markdown Response when the request wants
// markdown, else null (caller falls through to HTML). `build` is a thunk so the
// markdown is only serialized when actually requested. Using it via
// `const r = negotiateMarkdown(...); if (r) return r;` also sidesteps an Astro
// quirk where helpers used only inside a frontmatter `return` are mis-flagged
// as unused.
export function negotiateMarkdown(request: Request, build: () => string): Response | null {
  return wantsMarkdown(request) ? markdownResponse(build()) : null;
}

const SITE = 'https://aedin.io';
const n = (x: number) => x.toLocaleString('en-US');

// ---------- Homepage ----------

interface HomeStats {
  total_servable_claims: number;
  total_entities_with_claims: number;
  total_sources: number;
  total_globi_interactions: number;
  sample_entities: { slug: string | null; scientific_name: string; common_name: string | null; claim_count: number }[];
  top_sources: { slug: string | null; title: string; year: number | null; claim_count: number }[];
}
interface HomeRegion { slug: string | null; region: string; claim_count: number }
interface HomeInteraction { term: string; claim_count: number }

export function homepageMarkdown(stats: HomeStats, regions: HomeRegion[], interactions: HomeInteraction[]): string {
  const lines: string[] = [
    '# AEDIN — AgroEcological Database of Interactions',
    '',
    'A citable agroecological knowledge base for academic researchers and AI / bot consumers. ' +
      'Atomic claims about pest, pathogen, beneficial-insect, pollinator, mycorrhizal, soil, and ' +
      'crop-trait interactions — each carrying a verbatim source quote and page citation — plus ' +
      'aggregated GloBI interaction data. Claims are AI-extracted from open-access literature and ' +
      'verified by an automated multi-critic consensus process (not human-reviewed); confirm the ' +
      'verbatim quote and original source before citing.',
    '',
    '## Holdings',
    `- Verified claims: ${n(stats.total_servable_claims)}`,
    `- Entities: ${n(stats.total_entities_with_claims)}`,
    `- Source documents: ${n(stats.total_sources)}`,
    `- Aggregated GloBI interactions: ${n(stats.total_globi_interactions)} (via GloBI — not independently verified)`,
    '',
    '## Entities with the most evidence',
    ...stats.sample_entities.slice(0, 6).map(
      (e) => `- [${e.scientific_name}${e.common_name ? ` (${e.common_name})` : ''}](${SITE}/entity/${e.slug}) — ${n(e.claim_count)} claims`,
    ),
    '',
    '## Most-cited sources',
    ...stats.top_sources.slice(0, 6).map(
      (s) => `- [${s.title}](${SITE}/source/${s.slug})${s.year ? ` (${s.year})` : ''} — ${n(s.claim_count)} claims`,
    ),
    '',
    '## Browse',
    `- Atlas (interaction network graph): ${SITE}/atlas`,
    `- Crop web (radial crop-centric view): ${SITE}/crop-web`,
    `- Data sources & licensing: ${SITE}/data-sources`,
    `- About & citation: ${SITE}/about`,
    `- API (in development) — request early access: ${SITE}/api`,
    `- Sitemap: ${SITE}/sitemap-index.xml`,
    '',
    'Tip: any SSR page returns markdown on `Accept: text/markdown` — including every `/entity/<slug>` dossier.',
  ];
  if (regions.length) {
    lines.push('', '## Browse by region',
      ...regions.map((r) => `- [${r.region}](${SITE}/region/${r.slug}) (${n(r.claim_count)})`));
  }
  if (interactions.length) {
    lines.push('', '## Browse by interaction',
      ...interactions.map((i) => `- [${i.term}](${SITE}/interaction/${i.term}) (${n(i.claim_count)})`));
  }
  lines.push('', '## Citation',
    'LeBouef V. 2026. AEDIN: AgroEcological Database of Interactions. https://aedin.io', '');
  return lines.join('\n');
}

// ---------- Entity ----------

interface MdEntity {
  scientific_name: string;
  common_name?: string | null; slug?: string | null;
  bio_category?: string | null; primary_role?: string | null;
  taxon_class?: string | null; taxon_order?: string | null; family?: string | null; genus?: string | null;
}
interface MdInteraction {
  id: number; provenance: string; direction: string; category: string | null; verb: string | null;
  partnerName: string | null; partnerCommon: string | null; partnerSlug: string | null;
  region: string | null; citation: string | null; referenceCitation: string | null; referenceDoi: string | null;
}
interface MdTrait { trait: string; value: string; unit: string | null; region: string | null; citation: string | null }
interface MdRelated { slug: string | null; scientific_name: string; common_name: string | null; shared_count: number }

const INTERACTION_CAP = 200;
const TRAIT_CAP = 100;

export function entityMarkdown(
  entity: MdEntity,
  data: { totalClaims: number; interactions: MdInteraction[]; traits: MdTrait[]; related: MdRelated[] },
): string {
  const title = `${entity.scientific_name}${entity.common_name ? ` (${entity.common_name})` : ''}`;
  const lines: string[] = [
    `# ${title}`,
    '',
    `${[entity.bio_category, entity.primary_role?.replace(/_/g, ' ')].filter(Boolean).join(' · ') || 'Entity'} — ` +
      `${n(data.totalClaims)} verified claim${data.totalClaims === 1 ? '' : 's'} in AEDIN. AI-extracted from ` +
      'open-access literature and multi-critic-verified (not human-reviewed); read the cited source before reuse.',
    `AEDIN entity: ${SITE}/entity/${entity.slug}`,
  ];

  const tax: string[] = [];
  for (const [label, val] of [['Class', entity.taxon_class], ['Order', entity.taxon_order], ['Family', entity.family], ['Genus', entity.genus]] as const) {
    if (val) tax.push(`- ${label}: ${val}`);
  }
  if (tax.length) lines.push('', '## Classification', ...tax);

  const ix = data.interactions;
  lines.push('', `## Interactions (${n(ix.length)}${ix.length > INTERACTION_CAP ? `; first ${INTERACTION_CAP} shown` : ''})`);
  for (const r of ix.slice(0, INTERACTION_CAP)) {
    const arrow = r.direction === 'out' ? '→' : '←';
    const partner = r.partnerSlug
      ? `[${r.partnerName ?? '(unnamed)'}](${SITE}/entity/${r.partnerSlug})`
      : (r.partnerName ?? '(unnamed)');
    const rel = [r.category, r.verb && r.verb !== r.category ? `(${r.verb})` : null].filter(Boolean).join(' ');
    const cite = r.citation || r.referenceCitation || null;
    const meta = [
      r.region ? `region: ${r.region}` : null,
      cite ? `cite: ${cite}${r.referenceDoi ? ` doi:${r.referenceDoi}` : ''}` : null,
      `[${r.provenance}](${SITE}/${r.provenance === 'globi' ? 'globi' : 'claim'}/${r.id})`,
    ].filter(Boolean);
    lines.push(`- ${arrow} **${partner}**${r.partnerCommon ? ` (${r.partnerCommon})` : ''}${rel ? ` — ${rel}` : ''} · ${meta.join(' · ')}`);
  }
  if (ix.length > INTERACTION_CAP) {
    lines.push(`- _…and ${n(ix.length - INTERACTION_CAP)} more — full set at ${SITE}/entity/${entity.slug}_`);
  }

  if (data.traits.length) {
    lines.push('', `## Traits (${n(data.traits.length)})`);
    for (const t of data.traits.slice(0, TRAIT_CAP)) {
      const meta = [t.region ? `region: ${t.region}` : null, t.citation ? `cite: ${t.citation}` : null].filter(Boolean);
      lines.push(`- **${t.trait}**: ${t.value}${t.unit ? ` ${t.unit}` : ''}${meta.length ? ` · ${meta.join(' · ')}` : ''}`);
    }
    if (data.traits.length > TRAIT_CAP) lines.push(`- _…and ${n(data.traits.length - TRAIT_CAP)} more_`);
  }

  if (data.related.length) {
    lines.push('', '## Related entities');
    for (const e of data.related) {
      lines.push(`- [${e.scientific_name}${e.common_name ? ` (${e.common_name})` : ''}](${SITE}/entity/${e.slug}) — ${n(e.shared_count)} shared claim${e.shared_count === 1 ? '' : 's'}`);
    }
  }

  lines.push('', '## Citation',
    `Cite AEDIN plus the source for each claim. Canonical: LeBouef V. 2026. AEDIN: AgroEcological Database of Interactions. ${SITE}/entity/${entity.slug}`,
    '');
  return lines.join('\n');
}
