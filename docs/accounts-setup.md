# Accounts, billing and credits: setup

Accounts ship **switched off**. The live site behaves exactly as before until
step 1 is done and deployed. After that, each sign-in method and billing only
appear once their keys are set, so you can do the steps one at a time.

Every step below says **where** to do it, **what to type or click**, **what you
should see**, and **how to check** it worked. Text in `CAPITALS` inside a
command is a placeholder: replace it, including the capitals, before running.

---

## Before you start (once)

Do this on **your own computer** in a terminal: WSL on Windows, or Terminal on
macOS/Linux.

1. Go to your copy of the repo and switch to the branch with the accounts code.
   Change `~/aedin` if your copy lives somewhere else:
   ```bash
   cd ~/aedin
   git fetch origin
   git checkout claude/optimistic-allen-3v9tdb
   git pull
   cd web
   npm install --legacy-peer-deps
   ```
   **Check:** `git branch --show-current` prints `claude/optimistic-allen-3v9tdb`,
   and `ls d1/accounts.sql` prints the file name with no error.

2. Log wrangler (Cloudflare's command-line tool) in to your Cloudflare account:
   ```bash
   npx wrangler login
   ```
   A browser tab opens. Click **Allow**, then come back to the terminal.

   **Check:**
   ```bash
   npx wrangler whoami
   ```
   It prints your Cloudflare email and account name.

All later commands are run from this same `web` folder.

### How secrets work (read once)

A *secret* is a password-like setting the website needs, such as an API key. It
is stored in Cloudflare, never in the code. Every secret in this guide is set
with one of these two forms:

- **Interactive.** Recommended for keys you copy from another website. Run the
  command, paste the value when it asks `Enter a secret value:`, and press Enter.
  The value isn't shown and isn't saved in your shell history.
  ```bash
  npx wrangler pages secret put SECRET_NAME --project-name=agroeco
  ```
- **One line.** Used below for values that aren't sensitive, or that the
  command generates itself:
  ```bash
  echo "THE_VALUE" | npx wrangler pages secret put SECRET_NAME --project-name=agroeco
  ```

You should see `✨ Success! Uploaded secret SECRET_NAME`.

**Check:** to list every secret set so far (names only; values stay hidden):
```bash
npx wrangler pages secret list --project-name=agroeco
```

**Using the dashboard instead:**
1. Go to https://dash.cloudflare.com → **Workers & Pages** → **agroeco** →
   **Settings** → **Variables and Secrets** → **+ Add**.
2. Set Type to **Secret**, then fill in Variable name and Value.
3. Choose environment **Production**, then click **Save**.

Secrets only take effect on the next deploy (step 6).

---

## 1. Accounts database (required)

1. Create the database. The flags make wrangler add it to `wrangler.toml` for
   you, so there's no file to edit:
   ```bash
   npx wrangler d1 create aedin-accounts --binding=ACCOUNTS --update-config
   ```
   **You should see:** `✅ Successfully created DB 'aedin-accounts'`. If it asks
   whether to add the database to your config, answer **Yes**.

   **Check:**
   ```bash
   tail -5 wrangler.toml
   ```
   The last lines look like this, with your own id:
   ```toml
   [[d1_databases]]
   binding = "ACCOUNTS"
   database_name = "aedin-accounts"
   database_id = "1a2b3c4d-0000-0000-0000-000000000000"
   ```

2. Create the tables:
   ```bash
   npx wrangler d1 execute aedin-accounts --remote --file=d1/accounts.sql
   ```
   Type `y` and press Enter if it asks you to confirm.

   **Check:**
   ```bash
   npx wrangler d1 execute aedin-accounts --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   ```
   The output lists `account`, `api_key`, `credit_ledger`, `session`,
   `stripe_event`, `subscription`, `user` and `verification`. Cloudflare may
   also list an internal `_cf_…` table; ignore it.

3. Set the two required secrets. The first command generates a random password
   and stores it directly, so you never see or copy it:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler pages secret put BETTER_AUTH_SECRET --project-name=agroeco
   echo "https://aedin.io" | npx wrangler pages secret put BETTER_AUTH_URL --project-name=agroeco
   ```
   **Check:** `npx wrangler pages secret list --project-name=agroeco` shows both
   `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.

   Run the `BETTER_AUTH_SECRET` command **only once**. Running it again signs
   everyone out.

4. Save the `wrangler.toml` change:
   ```bash
   git add wrangler.toml
   git commit -m "Bind accounts database"
   git push
   ```

Accounts go live when you deploy (step 6). Steps 2–5 can be done before or
after that.

---

## 2. Email sign-in links (Resend)

Without this, the "Email me a link" button can't send anything.

1. Go to https://resend.com and sign up.
2. Click **Domains** → **+ Add Domain**, enter `aedin.io`, keep the suggested
   region, and click **Add**.
3. Resend now shows 3–4 DNS records. For **each** one:
   1. In a second tab, go to https://dash.cloudflare.com → **aedin.io** →
      **DNS** → **Records** → **+ Add record**.
   2. Copy Type, Name and Content (and Priority for MX records) from Resend
      into the matching fields.
   3. Set **Proxy status** to **DNS only** (grey cloud).
   4. Click **Save**.
4. Back in Resend, click **Verify DNS Records**. It can take a few minutes up
   to an hour.

   **Check:** the domain status shows **Verified**.
5. Click **API Keys** → **+ Create API Key**. Use the name `aedin-site`,
   permission **Sending access**, and domain `aedin.io`. Click **Add**, then copy
   the key, which starts with `re_`.
6. Store the key (paste it when asked):
   ```bash
   npx wrangler pages secret put RESEND_API_KEY --project-name=agroeco
   ```
7. Optional: change the sender name or address. If you skip this, the default
   is `AEDIN <noreply@aedin.io>`.
   ```bash
   echo "AEDIN <noreply@aedin.io>" | npx wrangler pages secret put EMAIL_FROM --project-name=agroeco
   ```

---

## 3. Sign in with Google, Microsoft, ORCID (each optional)

Each button appears on /login only after its two secrets are set. You'll need
these redirect URIs:

| Provider | Redirect URI (paste exactly) |
|---|---|
| Google | `https://aedin.io/api/auth/callback/google` |
| Microsoft | `https://aedin.io/api/auth/callback/microsoft` |
| ORCID | `https://aedin.io/api/auth/oauth2/callback/orcid` |

### Google
1. Go to https://console.cloud.google.com, select or create a project (name it
   `AEDIN`).
2. Set up the consent screen:
   1. Click **APIs & Services** → **OAuth consent screen** → **Get started**.
   2. Enter app name `AEDIN` and your support email.
   3. Choose audience **External**, enter your contact email, and click **Create**.
3. Create the client:
   1. Click **APIs & Services** → **Credentials** → **+ Create credentials** →
      **OAuth client ID**.
   2. Set Application type to **Web application** and Name to `AEDIN web`.
   3. Under **Authorized redirect URIs**, click **+ Add URI** and paste the
      Google URI from the table.
   4. Click **Create**.
4. A box shows **Client ID** and **Client secret**. Store both, pasting each
   when asked:
   ```bash
   npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name=agroeco
   npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=agroeco
   ```
5. Under **OAuth consent screen** → **Audience**, click **Publish app**. Until
   you do, only test users you add can sign in.

### Microsoft (school, work and personal accounts)
1. Go to https://entra.microsoft.com and sign in with any Microsoft account.
2. Register the app:
   1. Click **Applications** → **App registrations** → **+ New registration**.
   2. Name: `AEDIN`.
   3. Supported account types: **Accounts in any organizational directory and
      personal Microsoft accounts**.
   4. Redirect URI: choose platform **Web** and paste the Microsoft URI from the
      table.
   5. Click **Register**.
3. On the app's **Overview** page, copy **Application (client) ID** and store it:
   ```bash
   npx wrangler pages secret put MICROSOFT_CLIENT_ID --project-name=agroeco
   ```
4. Create the client secret:
   1. Click **Certificates & secrets** → **+ New client secret**.
   2. Description: `aedin-site`. Expires: **24 months**.
   3. Click **Add**, then copy the **Value** column. It's only shown once; don't
      copy the "Secret ID".
   ```bash
   npx wrangler pages secret put MICROSOFT_CLIENT_SECRET --project-name=agroeco
   ```
   Put a reminder in your calendar to renew it before it expires.
5. Recommended: let school emails count as verified.
   1. Click **Token configuration** → **+ Add optional claim** → **ID**.
   2. Tick `verified_primary_email` and `verified_secondary_email`, then click **Add**.
   3. If asked about Microsoft Graph permissions, tick the box and click **Add**.

   Without this, Microsoft users still sign in fine, but a school email only
   counts for academic pricing after they sign in once with an email link.
   Unverified Microsoft emails also never merge into an existing account,
   which blocks a known account-takeover trick ("nOAuth").

### ORCID
ORCID can't create accounts, because ORCID doesn't share an email address.
Users sign in another way first, then click **Link ORCID iD** on /account.
Linking gives them academic pricing, and after that they can also sign in with
ORCID.

1. Sign in at https://orcid.org with your own ORCID iD.
2. Click your name (top right) → **Developer tools** → accept the terms →
   **Register for the free ORCID public API**.
3. Enter Application name `AEDIN`, website `https://aedin.io`, and a short
   description. Under **Redirect URIs**, paste the ORCID URI from the table.
4. Click **Save**. The page shows **Client ID** (`APP-…`) and **Client secret**.
   Store both:
   ```bash
   npx wrangler pages secret put ORCID_CLIENT_ID --project-name=agroeco
   npx wrangler pages secret put ORCID_CLIENT_SECRET --project-name=agroeco
   ```

---

## 4. Payments (Stripe)

Do everything in **Test mode** first. Test mode uses fake cards, such as
`4242 4242 4242 4242` with any future date and any CVC.

1. Sign up at https://dashboard.stripe.com/register. Turn on the **Test mode**
   toggle at the top right; the dashboard shows an orange "Test mode" banner.
2. Create the products. Go to **Product catalog** → **+ Add product** and fill
   it in as follows:
   1. Name: `AEDIN Researcher`.
   2. Pricing: **Recurring**, amount `15.00` USD, Billing period **Monthly**.
   3. Click **Add product**.
   4. Open the product, then click **+ Add another price** for each other price
      in the table below.

   Then do the same for `AEDIN Pro` and `AEDIN Credits`. For Credits, choose
   **One-off** instead of Recurring.

   | Product | Price | Billing period | Secret name |
   |---|---|---|---|
   | AEDIN Researcher | 15.00 | Monthly | `STRIPE_PRICE_RESEARCHER_MONTHLY` |
   | AEDIN Researcher | 150.00 | Yearly | `STRIPE_PRICE_RESEARCHER_ANNUAL` |
   | AEDIN Researcher | 7.50 | Monthly | `STRIPE_PRICE_RESEARCHER_MONTHLY_ACADEMIC` |
   | AEDIN Researcher | 75.00 | Yearly | `STRIPE_PRICE_RESEARCHER_ANNUAL_ACADEMIC` |
   | AEDIN Pro | 79.00 | Monthly | `STRIPE_PRICE_PRO_MONTHLY` |
   | AEDIN Pro | 790.00 | Yearly | `STRIPE_PRICE_PRO_ANNUAL` |
   | AEDIN Pro | 39.50 | Monthly | `STRIPE_PRICE_PRO_MONTHLY_ACADEMIC` |
   | AEDIN Pro | 395.00 | Yearly | `STRIPE_PRICE_PRO_ANNUAL_ACADEMIC` |
   | AEDIN Credits | 10.00 | One-off | `STRIPE_PRICE_TOPUP_1000` |

3. Store each price ID:
   1. Open the product and click the price row. Copy its **API ID** (or
      **Pricing ID**); it starts with `price_`.
   2. Run the matching command and paste the ID when asked:
   ```bash
   npx wrangler pages secret put STRIPE_PRICE_RESEARCHER_MONTHLY --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_RESEARCHER_ANNUAL --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_RESEARCHER_MONTHLY_ACADEMIC --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_RESEARCHER_ANNUAL_ACADEMIC --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_PRO_MONTHLY --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_PRO_ANNUAL --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_PRO_MONTHLY_ACADEMIC --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_PRO_ANNUAL_ACADEMIC --project-name=agroeco
   npx wrangler pages secret put STRIPE_PRICE_TOPUP_1000 --project-name=agroeco
   ```
   You can skip the four academic prices; academics then pay the standard price.

4. API key: go to **Developers** → **API keys**, click **Reveal test key** next
   to **Secret key**, and copy it (`sk_test_…`).
   ```bash
   npx wrangler pages secret put STRIPE_SECRET_KEY --project-name=agroeco
   ```

5. Webhook (this is how Stripe tells the site a payment succeeded):
   1. Go to **Developers** → **Webhooks** → **+ Add destination** (older
      dashboards: **+ Add endpoint**).
   2. Choose **Your account**, then **Select events** and tick these five:
      - `checkout.session.completed`
      - `invoice.paid`
      - `customer.subscription.created`
      - `customer.subscription.updated`
      - `customer.subscription.deleted`
   3. Click **Continue** → **Webhook endpoint**, set Endpoint URL to
      `https://aedin.io/api/billing/webhook`, and click **Create destination**.
   4. On the new webhook's page, click **Reveal** under **Signing secret** and
      copy it (`whsec_…`).
   ```bash
   npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name=agroeco
   ```

6. Customer portal (where users cancel or switch plans): go to **Settings** →
   **Billing** → **Customer portal** and turn on:
   - **Cancel subscriptions**.
   - **Switch plans**: add the AEDIN Researcher and AEDIN Pro products.
   - **Update payment methods**.

   Then click **Save**.

7. Going live, later: switch off Test mode and repeat steps 2–5. Live mode has
   different `price_…`, `sk_live_…` and `whsec_…` values, so run the same
   `secret put` commands again with the live values.

---

## 5. Make yourself admin

1. After deploying (step 6), sign in once at https://aedin.io/login with the
   email you want as admin.
2. Run this command, replacing `YOUR_EMAIL` with that email:
   ```bash
   npx wrangler d1 execute aedin-accounts --remote --command "UPDATE \"user\" SET role = 'admin' WHERE email = 'YOUR_EMAIL'"
   ```
   **Check:**
   ```bash
   npx wrangler d1 execute aedin-accounts --remote --command "SELECT email, role FROM \"user\" WHERE role = 'admin'"
   ```
   It shows your email with `admin`. Reload https://aedin.io/account and an
   **Admin** link appears next to your email. /admin lists users, adjusts
   credits, toggles academic status and shows the API waitlist.

---

## 6. Deploy

Production deploys only run from `main` (a guard in `scripts/assert-main-branch.cjs`).

1. Merge the branch into `main`, either with a pull request on GitHub or locally:
   ```bash
   git checkout main
   git pull
   git merge claude/optimistic-allen-3v9tdb
   git push
   ```
2. Deploy from your computer, where the corpus database lives:
   ```bash
   cd web
   npm run deploy
   ```

**Check:**
- https://aedin.io/login shows **Email me a link**, not "Accounts are not
  available yet". A button appears for each provider you set up.
- Enter your email, click **Email me a link**, and click the link in the email.
  You land on /account.
- In Stripe test mode: on /account, click **Monthly** under Researcher and pay
  with `4242 4242 4242 4242`. Back on /account, the plan says **Researcher** and
  the balance is **2,000**.

  If not, open Stripe → **Developers** → **Webhooks** → your webhook →
  **Event deliveries** and look for a red failed delivery.

---

## How credits behave

- **Plan credits:** each paid invoice grants the plan's credits (12 months'
  worth up front for annual plans).
- **Resets:** unused plan credits reset at the next renewal or on cancellation.
  Spending draws on plan credits first, then top-ups.
- **Top-ups:** top-up credits never expire.
- **Prices:** credit prices per action live in
  `web/src/lib/accounts/plans.ts` (`PRICES`). Update them from the cost
  measurement (`docs/business-model.md`).

---

## Local development (optional, for testing changes on your computer)

This uses a throwaway local database and never touches the real one.

1. In `web/wrangler.toml`, the `ACCOUNTS` block from step 1 must be present.
   Any `database_id` works locally.
2. Create the local tables and a local secrets file:
   ```bash
   npx wrangler d1 execute aedin-accounts --local --file=d1/accounts.sql
   printf 'BETTER_AUTH_SECRET=dev-secret-dev-secret-dev-secret-1\nBETTER_AUTH_URL=http://localhost:8788\n' > .dev.vars
   ```
   `.dev.vars` is git-ignored.
3. Build and run:
   ```bash
   npm run build
   npx wrangler pages dev dist --port 8788
   ```
4. Open http://localhost:8788/login and request a link. With no
   `RESEND_API_KEY` in `.dev.vars`, the link is printed in the terminal instead
   of being emailed: look for `[email:dev]` and open the URL below it.
