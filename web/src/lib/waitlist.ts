// Waitlist capture helpers — pure/testable validation + Cloudflare Turnstile
// verification. Kept separate from the endpoint so the logic is unit-testable
// once the web test harness lands (see commercial-bd-plan.md §12 Task 1).

/**
 * Normalize + validate an email. Returns the lowercased/trimmed address, or
 * null if it isn't a plausible address. Intentionally RFC-lite: one `@`, a
 * non-empty local part, and a dotted domain — enough to reject typos and
 * junk without rejecting valid-but-unusual real addresses.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/**
 * Verify a Cloudflare Turnstile token against the siteverify endpoint.
 *
 * Degrades gracefully: when no secret is configured (local dev, or before the
 * Turnstile widget keys are added in production) it returns true so the form
 * still works — spam is then guarded only by the honeypot. It tightens
 * automatically the moment TURNSTILE_SECRET is set.
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | null,
  ip: string | null,
): Promise<boolean> {
  if (!secret) return true; // not configured → skip (honeypot still applies)
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false; // network/parse failure → fail closed
  }
}

/**
 * Allowed API use-case options shown as checkboxes on the waitlist form.
 * Single source of truth: rendered by about.astro and validated by the
 * /api/waitlist endpoint. Stored as a comma-joined string of `value`s.
 */
export const USE_CASES: { value: string; label: string }[] = [
  { value: 'academic',     label: 'Academic research / teaching' },
  { value: 'ai-grounding', label: 'AI / LLM grounding (RAG, chatbots)' },
  { value: 'ipm-advisory', label: 'IPM / pest-management advisory' },
  { value: 'agtech',       label: 'Ag-tech product / integration' },
  { value: 'bulk-data',    label: 'Bulk data / dataset licensing' },
  { value: 'other',        label: 'Other' },
];

const VALID_USE_CASES = new Set(USE_CASES.map((u) => u.value));

/**
 * Filter submitted use-case values against the allow-list, dedupe, and join
 * into a comma-separated string for storage. Anything not in USE_CASES is
 * dropped (defends against tampering); returns '' when nothing valid is sent.
 */
export function sanitizeUseCases(raw: unknown[]): string {
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && VALID_USE_CASES.has(v) && !out.includes(v)) out.push(v);
  }
  return out.join(',');
}
