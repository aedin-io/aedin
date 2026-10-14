-- AEDIN accounts database (separate D1: aedin-accounts, bound as ACCOUNTS).
-- Kept apart from the corpus D1 so corpus rebuilds/republishes can never touch
-- users, billing or credits. Apply with:
--   wrangler d1 execute aedin-accounts --remote --file=d1/accounts.sql
-- Idempotent (CREATE ... IF NOT EXISTS). See docs/accounts-setup.md.

-- ---- Better Auth core tables (column names are Better Auth's defaults) ----
CREATE TABLE IF NOT EXISTS "user" (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  emailVerified    INTEGER NOT NULL DEFAULT 0,
  image            TEXT,
  createdAt        DATE NOT NULL,
  updatedAt        DATE NOT NULL,
  -- AEDIN additional fields (declared in lib/accounts/auth.ts user.additionalFields)
  role             TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
  academicVerified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  expiresAt  DATE NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  createdAt  DATE NOT NULL,
  updatedAt  DATE NOT NULL,
  ipAddress  TEXT,
  userAgent  TEXT,
  userId     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(userId);

CREATE TABLE IF NOT EXISTS account (
  id                    TEXT PRIMARY KEY,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  userId                TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  DATE,
  refreshTokenExpiresAt DATE,
  scope                 TEXT,
  password              TEXT,
  createdAt             DATE NOT NULL,
  updatedAt             DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_user ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  DATE NOT NULL,
  createdAt  DATE NOT NULL,
  updatedAt  DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier);

-- ---- Billing ----
CREATE TABLE IF NOT EXISTS subscription (
  user_id                TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan                   TEXT NOT NULL DEFAULT 'free',   -- lib/accounts/plans.ts PlanId
  status                 TEXT NOT NULL DEFAULT 'none',   -- Stripe status, or 'none'
  current_period_end     TEXT,                           -- ISO-8601
  seats                  INTEGER NOT NULL DEFAULT 1,
  updated_at             TEXT NOT NULL
);

-- Webhook idempotency: each Stripe event id is processed once.
CREATE TABLE IF NOT EXISTS stripe_event (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

-- ---- Credits: append-only ledger; balance = SUM(delta) ----
-- Monthly plan credits reset each billing period (lib/accounts/credits.ts
-- renewPeriod writes a 'period_reset' row for the unused part); top-ups never expire.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL,          -- + grant, - spend
  reason     TEXT NOT NULL,             -- monthly_grant|period_reset|topup|extraction|chat|api|review|adjustment
  ref        TEXT,                      -- idempotency / audit reference
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ref ON credit_ledger(user_id, reason, ref) WHERE ref IS NOT NULL;

-- ---- API keys (only the SHA-256 hash is stored) ----
CREATE TABLE IF NOT EXISTS api_key (
  id           INTEGER PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,           -- first chars, shown in the UI
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_key(user_id);
