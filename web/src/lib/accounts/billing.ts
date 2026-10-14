// Stripe billing: checkout, customer portal and webhook handling.
//
// Plans are resolved from Stripe *price ids* (env STRIPE_PRICE_*), not from
// metadata, so plan changes made in the Customer Portal are picked up too.
// Every webhook effect is idempotent (credit grants carry the Stripe object id
// as their ref) and processed event ids are recorded in stripe_event.
import Stripe from 'stripe';
import type { D1Like } from './db';
import { nowIso } from './db';
import { PLANS, TOPUP, isPlanId, type PlanId } from './plans';
import { grant, renewPeriod } from './credits';

export type Interval = 'monthly' | 'annual';
export interface BillingEnv { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; [k: string]: unknown }

export function stripeClient(env: BillingEnv): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Billing is not configured (STRIPE_SECRET_KEY missing).');
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

export function priceIdFor(env: BillingEnv, plan: PlanId, interval: Interval, academic: boolean): string | null {
  const e = PLANS[plan].stripePriceEnv;
  if (!e) return null;
  const name = academic
    ? (interval === 'annual' ? e.annualAcademic : e.monthlyAcademic)
    : (interval === 'annual' ? e.annual : e.monthly);
  // Fall back to the standard price if an academic price isn't configured.
  const v = env[name] ?? (academic ? env[interval === 'annual' ? e.annual : e.monthly] : undefined);
  return typeof v === 'string' && v ? v : null;
}

/** Reverse map: Stripe price id → plan + interval. */
export function planForPrice(env: BillingEnv, priceId: string | null | undefined): { plan: PlanId; interval: Interval } | null {
  if (!priceId) return null;
  for (const p of Object.values(PLANS)) {
    const e = p.stripePriceEnv;
    if (!e) continue;
    for (const [key, interval] of [['monthly', 'monthly'], ['monthlyAcademic', 'monthly'], ['annual', 'annual'], ['annualAcademic', 'annual']] as const) {
      if (env[e[key]] === priceId) return { plan: p.id, interval };
    }
  }
  return null;
}

/** Credits granted per paid invoice: annual plans get 12 months up front. */
export const creditsPerInvoice = (plan: PlanId, interval: Interval) =>
  PLANS[plan].monthlyCredits * (interval === 'annual' ? 12 : 1);

export interface SubscriptionRow {
  user_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
  plan: PlanId; status: string; current_period_end: string | null; seats: number;
}

export async function getSubscription(db: D1Like, userId: string): Promise<SubscriptionRow> {
  const row = await db.prepare('SELECT * FROM subscription WHERE user_id = ?').bind(userId).first<SubscriptionRow>();
  return row ?? { user_id: userId, stripe_customer_id: null, stripe_subscription_id: null, plan: 'free', status: 'none', current_period_end: null, seats: 1 };
}

async function upsertSubscription(db: D1Like, userId: string, fields: Partial<Omit<SubscriptionRow, 'user_id'>>) {
  const cur = await getSubscription(db, userId);
  const next = { ...cur, ...fields };
  await db.prepare(
    `INSERT INTO subscription (user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, seats, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id, plan = excluded.plan, status = excluded.status,
       current_period_end = excluded.current_period_end, seats = excluded.seats, updated_at = excluded.updated_at`,
  ).bind(userId, next.stripe_customer_id, next.stripe_subscription_id, next.plan, next.status,
    next.current_period_end, next.seats, nowIso()).run();
}

async function userIdForCustomer(db: D1Like, customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const r = await db.prepare('SELECT user_id FROM subscription WHERE stripe_customer_id = ?').bind(customerId).first<{ user_id: string }>();
  return r?.user_id ?? null;
}

async function ensureCustomer(stripe: Stripe, db: D1Like, user: { id: string; email: string; name?: string | null }) {
  const sub = await getSubscription(db, user.id);
  if (sub.stripe_customer_id) return sub.stripe_customer_id;
  const email = user.email.endsWith('@orcid.invalid') ? undefined : user.email;
  const c = await stripe.customers.create({ email, name: user.name ?? undefined, metadata: { userId: user.id } });
  await upsertSubscription(db, user.id, { stripe_customer_id: c.id });
  return c.id;
}

export type CheckoutRequest =
  | { kind: 'plan'; plan: PlanId; interval: Interval }
  | { kind: 'topup'; quantity: number };

export async function createCheckout(
  env: BillingEnv, db: D1Like,
  user: { id: string; email: string; name?: string | null; academicVerified?: boolean },
  req: CheckoutRequest, origin: string,
): Promise<string> {
  const stripe = stripeClient(env);
  const customer = await ensureCustomer(stripe, db, user);
  const common = {
    customer,
    client_reference_id: user.id,
    success_url: `${origin}/account?checkout=success`,
    cancel_url: `${origin}/account?checkout=cancelled`,
    allow_promotion_codes: true,
  };
  if (req.kind === 'topup') {
    const price = env[TOPUP.priceEnv];
    if (typeof price !== 'string' || !price) throw new Error('Top-ups are not configured.');
    const quantity = Math.min(20, Math.max(1, Math.floor(req.quantity) || 1));
    const s = await stripe.checkout.sessions.create({
      ...common, mode: 'payment', line_items: [{ price, quantity }],
      metadata: { userId: user.id, kind: 'topup', credits: String(TOPUP.credits * quantity) },
    });
    return s.url!;
  }
  const price = priceIdFor(env, req.plan, req.interval, !!user.academicVerified);
  if (!price) throw new Error(`The ${req.plan} plan is not available for self-serve checkout.`);
  const sub = await getSubscription(db, user.id);
  if (sub.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(sub.status)) {
    throw new Error('You already have a subscription. Use "Manage billing" to change plans.');
  }
  const s = await stripe.checkout.sessions.create({
    ...common, mode: 'subscription', line_items: [{ price, quantity: 1 }],
    metadata: { userId: user.id, kind: 'plan' },
    subscription_data: { metadata: { userId: user.id } },
  });
  return s.url!;
}

export async function createPortal(env: BillingEnv, db: D1Like, userId: string, origin: string): Promise<string> {
  const sub = await getSubscription(db, userId);
  if (!sub.stripe_customer_id) throw new Error('No billing account yet.');
  const s = await stripeClient(env).billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: `${origin}/account` });
  return s.url;
}

export async function verifyWebhook(env: BillingEnv, body: string, signature: string | null): Promise<Stripe.Event> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  if (!signature) throw new Error('missing stripe-signature');
  return stripeClient(env).webhooks.constructEventAsync(
    body, signature, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider(),
  );
}

// Field access is defensive (`any`) because Stripe moves fields between API
// versions (e.g. invoice.subscription → invoice.parent.subscription_details).
const invoiceSubscriptionId = (inv: any): string | null =>
  inv.parent?.subscription_details?.subscription ?? inv.subscription ?? null;
const invoiceMetadataUserId = (inv: any): string | null =>
  inv.parent?.subscription_details?.metadata?.userId ?? inv.subscription_details?.metadata?.userId ?? null;
const invoicePriceId = (inv: any): string | null => {
  const line = inv.lines?.data?.find((l: any) => (l.amount ?? 0) >= 0) ?? inv.lines?.data?.[0];
  return line?.pricing?.price_details?.price ?? line?.price?.id ?? line?.plan?.id ?? null;
};
const toIso = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : null);

async function userExists(db: D1Like, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return !!(await db.prepare('SELECT 1 FROM "user" WHERE id = ?').bind(userId).first());
}

/**
 * Apply a verified Stripe event. Returns a short description for logs.
 * Events for unknown/deleted users are acknowledged (not retried forever) and
 * reported as such, so they can be reconciled by hand from the Stripe dashboard.
 */
export async function handleEvent(env: BillingEnv, db: D1Like, event: { id: string; type: string; data: { object: any } }): Promise<string> {
  const seen = await db.prepare('SELECT 1 FROM stripe_event WHERE id = ?').bind(event.id).first();
  if (seen) return 'duplicate';
  const o = event.data.object;
  let outcome = 'ignored';

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = o.metadata?.userId ?? o.client_reference_id;
      if (!(await userExists(db, userId))) { outcome = `unknown user ${userId}`; break; }
      if (o.mode === 'payment' && o.metadata?.kind === 'topup' && o.payment_status === 'paid') {
        await grant(db, userId, parseInt(o.metadata.credits, 10) || TOPUP.credits, 'topup', o.id);
        outcome = 'topup granted';
      } else if (o.mode === 'subscription') {
        await upsertSubscription(db, userId, { stripe_customer_id: o.customer, stripe_subscription_id: o.subscription });
        outcome = 'subscription linked';
      }
      break;
    }
    case 'invoice.paid': {
      const subId = invoiceSubscriptionId(o);
      if (!subId) break; // one-off invoice (top-ups are handled at checkout)
      const userId = invoiceMetadataUserId(o) ?? await userIdForCustomer(db, o.customer);
      const resolved = planForPrice(env, invoicePriceId(o));
      if (!(await userExists(db, userId)) || !resolved) { outcome = `unresolved (user=${userId}, price=${invoicePriceId(o)})`; break; }
      await upsertSubscription(db, userId, {
        stripe_customer_id: o.customer, stripe_subscription_id: subId, plan: resolved.plan, status: 'active',
      });
      await renewPeriod(db, userId, creditsPerInvoice(resolved.plan, resolved.interval), o.id);
      outcome = `granted ${creditsPerInvoice(resolved.plan, resolved.interval)} (${resolved.plan}/${resolved.interval})`;
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const userId = o.metadata?.userId ?? await userIdForCustomer(db, o.customer);
      const item = o.items?.data?.[0];
      const resolved = planForPrice(env, item?.price?.id);
      if (!(await userExists(db, userId))) { outcome = `unknown user ${userId}`; break; }
      await upsertSubscription(db, userId, {
        stripe_customer_id: o.customer, stripe_subscription_id: o.id, status: o.status,
        current_period_end: toIso(item?.current_period_end ?? o.current_period_end),
        ...(resolved ? { plan: resolved.plan, seats: PLANS[resolved.plan].seats } : {}),
      });
      outcome = `synced ${o.status}`;
      break;
    }
    case 'customer.subscription.deleted': {
      const userId = o.metadata?.userId ?? await userIdForCustomer(db, o.customer);
      if (!(await userExists(db, userId))) { outcome = `unknown user ${userId}`; break; }
      await upsertSubscription(db, userId, { stripe_subscription_id: null, plan: 'free', status: 'canceled', current_period_end: null, seats: 1 });
      await renewPeriod(db, userId, 0, `cancel:${o.id}`);
      outcome = 'canceled';
      break;
    }
  }

  await db.prepare('INSERT OR IGNORE INTO stripe_event (id, type, processed_at) VALUES (?, ?, ?)')
    .bind(event.id, event.type, nowIso()).run();
  return outcome;
}

export { isPlanId };
