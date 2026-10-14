# Accounts, billing and credits: setup

The code ships with accounts **switched off**. The site works exactly as
before until the `ACCOUNTS` database binding exists, and each sign-in
provider appears only once its credentials are set. Do the steps in order;
each one is independently useful.

Secrets go in as Pages secrets (Cloudflare dashboard → Workers & Pages →
agroeco → Settings → Variables and secrets, type **Secret**), or with
`npx wrangler pages secret put NAME --project-name=agroeco`. Never commit them.

## 1. Accounts database (required)

```bash
cd web
npx wrangler d1 create aedin-accounts          # prints a database_id
npx wrangler d1 execute aedin-accounts --remote --file=d1/accounts.sql
```

Uncomment the `ACCOUNTS` block at the bottom of `web/wrangler.toml` and paste
the `database_id`. Then set:

| Secret | Value |
|---|---|
| `BETTER_AUTH_SECRET` | a random 32+ character string: `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `https://aedin.io` |

This database is separate from the corpus database on purpose: corpus
rebuilds and republishes can never touch users, billing or credits.

## 2. Email (Resend), for magic-link sign-in

1. Create an account at resend.com and add the domain `aedin.io`.
2. Add the DNS records Resend shows (SPF, DKIM, and optionally DMARC) in
   Cloudflare DNS, and wait for "Verified".
3. Create an API key with "Sending access".

| Secret | Value |
|---|---|
| `RESEND_API_KEY` | the key |
| `EMAIL_FROM` | `AEDIN <noreply@aedin.io>` (optional; this is the default) |

## 3. Sign-in providers (each optional)

Redirect URIs to register with each provider:

| Provider | Redirect URI |
|---|---|
| Google | `https://aedin.io/api/auth/callback/google` |
| Microsoft | `https://aedin.io/api/auth/callback/microsoft` |
| ORCID | `https://aedin.io/api/auth/oauth2/callback/orcid` |

For local testing, add the same paths on `http://localhost:8788`.

**Google:** Google Cloud Console → APIs & Services → Credentials → Create
OAuth client ID (Web application). Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Microsoft (school, work and personal accounts):**
1. Go to Entra admin center (entra.microsoft.com) → App registrations → New registration.
2. Under supported account types, choose "Accounts in any organizational
   directory and personal Microsoft accounts".
3. Add the redirect URI as a "Web" platform.
4. Under Certificates & secrets → New client secret.
5. Set `MICROSOFT_CLIENT_ID` (the Application (client) ID) and `MICROSOFT_CLIENT_SECRET`.
6. Recommended: under Token configuration → Add optional claim → ID token, add
   `verified_primary_email` and `verified_secondary_email`. Without them,
   Microsoft emails count as unverified. Users still sign in fine, but a school
   email only counts toward academic pricing after one magic-link sign-in, and
   a Microsoft sign-in won't merge into an existing account with the same email.
   That is deliberate: it blocks the "nOAuth" account-takeover pattern.

**ORCID:** sign in at orcid.org → Developer tools → register a public API
client with the redirect URI. Set `ORCID_CLIENT_ID` and `ORCID_CLIENT_SECRET`.
ORCID is **link-only**: its public API returns no email, so users sign in some
other way first, then click "Link ORCID iD" on /account. Linking marks them
academic-verified, and afterwards they can sign in with ORCID directly. For
testing, use sandbox.orcid.org and set `ORCID_ENV=sandbox`.

## 4. Stripe (billing)

1. Create the account at stripe.com and stay in **Test mode** until everything works.
2. In Product catalog, create the products and prices below. Use recurring
   prices for the plans and a one-time price for the top-up. Put each price id
   (`price_…`) in the matching secret.

| Product | Price | Secret |
|---|---|---|
| Researcher | $15 / month | `STRIPE_PRICE_RESEARCHER_MONTHLY` |
| Researcher | $150 / year | `STRIPE_PRICE_RESEARCHER_ANNUAL` |
| Researcher (academic) | $7.50 / month | `STRIPE_PRICE_RESEARCHER_MONTHLY_ACADEMIC` |
| Researcher (academic) | $75 / year | `STRIPE_PRICE_RESEARCHER_ANNUAL_ACADEMIC` |
| Pro | $79 / month | `STRIPE_PRICE_PRO_MONTHLY` |
| Pro | $790 / year | `STRIPE_PRICE_PRO_ANNUAL` |
| Pro (academic) | $39.50 / month | `STRIPE_PRICE_PRO_MONTHLY_ACADEMIC` |
| Pro (academic) | $395 / year | `STRIPE_PRICE_PRO_ANNUAL_ACADEMIC` |
| Credits | $10 one-time (1,000 credits) | `STRIPE_PRICE_TOPUP_1000` |

   Any academic price you leave unset falls back to the standard one.
3. Go to Developers → API keys and set `STRIPE_SECRET_KEY` (`sk_test_…`, later `sk_live_…`).
4. Go to Developers → Webhooks → Add endpoint `https://aedin.io/api/billing/webhook`
   with these events:
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`

   Then set `STRIPE_WEBHOOK_SECRET` (`whsec_…`).
5. Go to Settings → Billing → Customer portal and turn on: cancel subscription,
   switch plans (add the Researcher and Pro prices), and update payment method.
6. Before going live, repeat steps 2–4 in live mode. Live mode has its own
   price ids, keys and webhook secret.

## 5. Make yourself admin

Sign in once, then run:

```bash
npx wrangler d1 execute aedin-accounts --remote \
  --command "UPDATE \"user\" SET role = 'admin' WHERE email = 'you@example.org'"
```

`/admin` lists users, adjusts credits, toggles academic status and shows the
API waitlist.

## How credits behave

- **Plan credits:** each paid invoice grants the plan's credits (12 months'
  worth up front for annual plans).
- **Resets:** unused plan credits reset at the next renewal or on cancellation.
  Spending draws on plan credits first, then top-ups.
- **Top-ups:** top-up credits never expire.
- **Prices:** credit prices per action live in
  `web/src/lib/accounts/plans.ts` (`PRICES`). Update them from the cost
  measurement (`docs/business-model.md`).

## Local development

```bash
cd web
# uncomment the ACCOUNTS block in wrangler.toml (any id works locally)
npx wrangler d1 execute aedin-accounts --local --file=d1/accounts.sql
printf 'BETTER_AUTH_SECRET=dev-secret-dev-secret-dev-secret-1\nBETTER_AUTH_URL=http://localhost:8788\n' > .dev.vars
npm run build && npx wrangler pages dev dist --port 8788
```

Without `RESEND_API_KEY`, magic links are printed in the wrangler log instead
of being emailed.
