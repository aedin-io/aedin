-- API-interest waitlist capture (in-house, D1-backed).
-- Applied to local dev D1 for testing, then to live D1 at go-live:
--   wrangler d1 execute agroeco --remote --file=d1/waitlist.sql
-- Idempotent: safe to re-run. Email is UNIQUE so the endpoint's
-- INSERT OR IGNORE makes resubmission a no-op.
CREATE TABLE IF NOT EXISTS waitlist (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  interest   TEXT,                 -- what they're waiting for, e.g. 'api'
  source     TEXT,                 -- capture surface, e.g. 'about'
  use_cases  TEXT,                 -- comma-joined slugs from a fixed allow-list (lib/waitlist.ts USE_CASES)
  created_at TEXT NOT NULL,        -- ISO-8601
  ip         TEXT                  -- best-effort, for abuse triage only
);
CREATE INDEX IF NOT EXISTS idx_waitlist_interest ON waitlist(interest);
