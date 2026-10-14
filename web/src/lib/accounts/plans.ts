// Plans and credit prices — the ONE place to change pricing.
//
// 1 credit ≈ $0.01 retail. The per-action prices are ESTIMATES until the
// Phase 0 cost measurement (backend/measure-pipeline-cost.js) reports real
// cost per page; see docs/business-model.md.

export type PlanId = 'free' | 'researcher' | 'pro' | 'institutional';

export interface Plan {
  id: PlanId;
  name: string;
  /** Display prices in USD; billing truth lives in Stripe. */
  monthlyUsd: number | null;
  annualUsd: number | null;
  /** Credits granted each paid billing period. */
  monthlyCredits: number;
  seats: number;
  blurb: string;
  features: string[];
  /** Env var names holding the Stripe price ids (null = not self-serve). */
  stripePriceEnv: { monthly: string; annual: string; monthlyAcademic: string; annualAcademic: string } | null;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free', name: 'Free', monthlyUsd: 0, annualUsd: 0, monthlyCredits: 0, seats: 1,
    blurb: 'Browse, cite and download the open corpus.',
    features: ['Full website and AI-search access', 'Quarterly CC BY 4.0 snapshot on Zenodo', '100 API calls/day', '25 chat answers/month'],
    stripePriceEnv: null,
  },
  researcher: {
    id: 'researcher', name: 'Researcher', monthlyUsd: 15, annualUsd: 150, monthlyCredits: 2000, seats: 1,
    blurb: 'For academics and independent developers. Half price for verified academics.',
    features: ['2,000 credits/month', 'Live API and MCP access', '1 private workspace', 'Extraction and expert-review requests'],
    stripePriceEnv: {
      monthly: 'STRIPE_PRICE_RESEARCHER_MONTHLY', annual: 'STRIPE_PRICE_RESEARCHER_ANNUAL',
      monthlyAcademic: 'STRIPE_PRICE_RESEARCHER_MONTHLY_ACADEMIC', annualAcademic: 'STRIPE_PRICE_RESEARCHER_ANNUAL_ACADEMIC',
    },
  },
  pro: {
    id: 'pro', name: 'Pro', monthlyUsd: 79, annualUsd: 790, monthlyCredits: 12000, seats: 3,
    blurb: 'For consultants, labs and ag startups.',
    features: ['12,000 credits/month', '3 seats', 'Shared workspaces', 'CSV / GloBI export of private corpora'],
    stripePriceEnv: {
      monthly: 'STRIPE_PRICE_PRO_MONTHLY', annual: 'STRIPE_PRICE_PRO_ANNUAL',
      monthlyAcademic: 'STRIPE_PRICE_PRO_MONTHLY_ACADEMIC', annualAcademic: 'STRIPE_PRICE_PRO_ANNUAL_ACADEMIC',
    },
  },
  institutional: {
    id: 'institutional', name: 'Institutional', monthlyUsd: null, annualUsd: 5000, monthlyCredits: 0, seats: 0,
    blurb: 'Extension services, universities and companies. Custom contract.',
    features: ['Custom credit pool', 'SSO and SLA', 'Bulk extraction runs', 'Reserved expert-review capacity'],
    stripePriceEnv: null,
  },
};

/** Credit top-up pack (one-time purchase). */
export const TOPUP = { credits: 1000, usd: 10, priceEnv: 'STRIPE_PRICE_TOPUP_1000' };

/** Credits per action. Replace with measured values (5× P90 cost). */
export const PRICES = {
  extractionPerPage: 25,
  extractionPerPageContributed: 13, // 50% off: open-access + added to the public corpus
  chatAnswer: 2,
  apiCallsPer100: 1,
} as const;

export function isPlanId(x: unknown): x is PlanId {
  return typeof x === 'string' && x in PLANS;
}
