-- Ramp402 gateway — SQLite cache schema.
-- Copied verbatim from docs/CONVENTIONS.md §1.4. Do not change either side alone.
-- Idempotent; executed on gateway startup. The chain is the source of truth for balances.

CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  privy_user_id TEXT NOT NULL,
  stellar_address TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  upstream_url TEXT NOT NULL,
  upstream_credentials_enc TEXT,   -- "v1:<iv>:<tag>:<ciphertext>" (AES-256-GCM); NULL if none
  proxy_slug TEXT NOT NULL UNIQUE,
  price_stroops INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  agent_address TEXT NOT NULL,
  amount_stroops INTEGER NOT NULL,
  status TEXT NOT NULL, -- paid | upstream_failed | refunded
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  amount_stroops INTEGER NOT NULL,
  anchor_tx_id TEXT,
  anchor_status TEXT,              -- the anchor's SEP-6 status, verbatim; NULL before it answers
  external_transaction_id TEXT,    -- the id on the external rail, e.g. the bank reference
  claimable_balance_id TEXT,       -- set when a missing trustline produced a claimable balance
  error_message TEXT,              -- why it failed, when status is 'failed'
  anchor_domain TEXT,              -- which anchor served it; a restarted poll has to know
  quote_buy_amount TEXT,           -- the SEP-38 buy amount, e.g. "485.41" TRY, as the anchor wrote it
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
