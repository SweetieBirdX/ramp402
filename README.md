# Ramp402

A pay-per-call x402 payment gateway for APIs, with a Turkish Lira off-ramp through a Stellar anchor.

**Read [docs/CONVENTIONS.md](docs/CONVENTIONS.md) before writing any code.**

## Repository layout

| Folder | What it is |
| --- | --- |
| `contract/` | Soroban smart contract `ramp_ledger` (Rust). A ledger only — it records who spent what and who is owed what, and never holds or transfers tokens. |
| `gateway/` | Node/TypeScript. The x402 proxy, the REST API, the SQLite cache, and the SEP-10/38/12/6 anchor off-ramp. |
| `frontend/` | Next.js. Seller dashboard and the agent console used to drive the live demo. |
| `scripts/` | Setup, demo reset, and verification scripts. |
| `docs/` | `CONVENTIONS.md` (the shared contract) and `TECHNICAL.md`. |

## Setup

From a fresh clone to a running system. Everything below is scripted — the hackathon sandbox can be
reset at any time, and rebuilding by hand under time pressure is how a demo gets lost.

### 1. Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node | 20 or newer | gateway, frontend and the scripts |
| Rust | installed via rustup | `contract/rust-toolchain.toml` pins 1.90.0 and rustup fetches it |
| Stellar CLI | 25.2.0 | building and deploying the contract |

Rust and the Stellar CLI are only needed to work on the contract. Running the system against the
already-deployed contract needs Node alone.

### 2. Install

```bash
npm install                 # repo root — the scripts in scripts/
cd gateway   && npm install && cd ..
cd frontend  && npm install && cd ..
```

### 3. Environment

```bash
cp gateway/.env.example gateway/.env                  # the gateway — and the scripts read it too
cp frontend/.env.local.example frontend/.env.local    # the frontend
```

`gateway/.env` is the one file that holds keys. The scripts in `scripts/` read it as well, so a
key you paste there is reused on every re-run instead of being minted again. A root `.env`
(`cp .env.example .env`) is optional: set a value there only to override `gateway/.env` for the
scripts.

Before the setup script can run, `gateway/.env` needs two values:

| Variable | Where it comes from |
| --- | --- |
| `OPERATOR_SECRET_KEY` | Ask the team. It is the key baked into the deployed contract and no script generates it, deliberately: a fresh operator would produce a system that looks configured and fails on every paid call with `NotOperator`. |
| `ANCHOR_HOME_DOMAIN` | `testanchor.stellar.org` for the testnet demo. There is no default: the USDC issuer is read from this anchor's `stellar.toml`, never hardcoded. |

Add `PRIVY_APP_ID` and `PRIVY_APP_SECRET` from the Privy dashboard as well — the gateway will not
start without them. Everything else is printed by the next step.

### 4. Create the accounts and a demo endpoint

```bash
npx tsx scripts/setup.ts
```

It funds the operator, creates and funds the platform pool, reads the USDC issuer from the anchor's
`stellar.toml`, adds the pool's USDC trustline, creates and funds the treasury and a demo seller,
registers a demo endpoint against the deployed contract, and caches it in SQLite so `/proxy/:slug`
works the moment the gateway starts. It prints a `[PASS]`/`[FAIL]` line per step and a final tally.

It ends with a complete block of `KEY=value` lines — network settings, the new pool key, the
treasury address, a freshly generated `UPSTREAM_CRED_ENCRYPTION_KEY`, and the demo fixtures.
**Paste all of it into `gateway/.env`.** Secrets are printed to the terminal once and never written
to a file; a line that says `unchanged` means the value is already in your environment.

It is **idempotent**: accounts whose keys are already in your environment are reused, funding and
the trustline are no-ops once done, and the demo endpoint is reused while it is still cached and on
chain. Re-running it after pasting prints `already funded` / `already present` /
`already registered` for every step.

### 5. Run

Two terminals:

```bash
cd gateway  && npm run dev      # http://localhost:3001
cd frontend && npm run dev      # http://localhost:3000
```

Set `NEXT_PUBLIC_GATEWAY_URL=http://localhost:3001` and `NEXT_PUBLIC_PRIVY_APP_ID` (the same value
as `PRIVY_APP_ID`) in `frontend/.env.local` first.

Check it:

```bash
curl http://localhost:3001/health                                      # {"ok":true}
curl -i -H "X-Agent-Budget: 5000000" http://localhost:3001/proxy/<DEMO_PROXY_SLUG>
# → 402 Payment Required with a PAYMENT-REQUIRED header. That is the product working:
#   the agent has not paid yet.
```

### 6. Between demo rehearsals

**Stop the gateway first**, then:

```bash
npx tsx scripts/reset-demo.ts
```

Deletes the SQLite cache, recreates it from `gateway/schema.sql`, checks that it really is empty,
and registers a fresh demo endpoint under the same `DEMO_PROXY_SLUG`, so the dashboard starts
empty and the demo URL does not change. It does **not** redeploy the contract, change any key, or
undo anything on chain — the ledger is permanent and the cache is rebuildable. With the gateway
still running the database file is locked, and the script fails with "stop the gateway first"
rather than resetting half of it.

### 7. Check it works

```bash
cd contract && cargo test                        # contract unit tests, offline
npx tsx scripts/smoke-contract.ts                # the deployed contract, on testnet
cd gateway && npm test                           # gateway suite
```

> **What has actually been walked through:** steps 2–6 were followed literally in a fresh clone on
> 2026-09-19 (Windows, Node 24): install, the two values in `gateway/.env`, setup (8/8 PASS),
> pasting its output, a second setup run (every step reused, no new endpoint), gateway (`/health`
> 200, demo slug 402 with `PAYMENT-REQUIRED`), frontend (`/` and `/dashboard` 200), and
> `reset-demo` with the gateway stopped (4/4 PASS, cache empty) and running (refused). A paid call
> and the Privy login were not part of this walk-through.

## Contract

`ramp_ledger` is deployed on testnet and verified on chain. It is a **ledger only** — it records
who spent what and who is owed what, and never holds or transfers a token. The USDC itself moves
off chain from the platform pool account. That is a deliberate architectural decision: the contract
custodies nothing, so there is nothing in it to steal.

| | |
| --- | --- |
| Network | testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CC73BWETYN2PWAO6YPDLX4H75XUUMH4HDQQJMJYQPY2SW3PE2TEP4CVJ` |
| Operator (public) | `GBTTFVGWRRZUGDOVCZZYHDJTN5733JT5NCDIQK42Y2PPFUTYYPURQPW6` |
| Deployer (public) | `GCYLZISOHDHY3E2NCZU2F72Y6SJAT5CN3ZUVSMHPYA76H7SUDP264335` |
| Wasm hash | `6fd92d7348e545ea4c3ba68c10410368f5fd97faa06810d6057bed8ada7caf00` |
| Build target | `wasm32v1-none`, 15,691 bytes optimised |
| soroban-sdk | 23.5.3 |
| Rust | 1.90.0, pinned by `contract/rust-toolchain.toml` |
| Stellar CLI | 25.2.0 |

### The six functions

All amounts are integer **stroops** (1 USDC = 10,000,000 stroops). No decimals ever reach the
chain.

| Function | Who signs | What it does |
| --- | --- | --- |
| `register_endpoint(seller, upstream_price) -> u64` | the seller | Records a paid API endpoint and returns the `endpoint_id` the contract assigns. Nobody else invents that id. |
| `record_call(operator, agent, endpoint_id, budget)` | the operator | Charges one call against an agent's budget. The budget is frozen by the pair's **first** call and ignored afterwards, so a later, larger budget cannot raise the ceiling. The agent never signs. |
| `settle(operator, endpoint_id, amount)` | the operator | Splits a settled amount 1% to the treasury, 99% to the endpoint's seller. Integer arithmetic; the two shares always sum back to `amount`. |
| `withdraw(seller) -> i128` | the seller | Zeroes that seller's balance and returns it, so the gateway can pay it out off chain. Returns 0 if there is nothing owed — it does not fail. |
| `get_balance(seller) -> i128` | nobody (view) | The seller's withdrawable balance, or 0. The chain is the source of truth for balances, not SQLite. |
| `get_endpoint(endpoint_id) -> EndpointInfo` | nobody (view) | The endpoint's seller and per-call price. Panics `EndpointNotFound` for an unknown id. |

Three more functions manage the operator identity itself:

| Function | Who signs | What it does |
| --- | --- | --- |
| `__constructor(operator)` | the deployer | Runs once, inside the deployment. Fixes which address may call `record_call` and `settle`. Mandatory — no deployment exists without one. |
| `set_operator(new_operator)` | the current operator | Hands the role to a different keypair without redeploying. |
| `get_operator() -> Address` | nobody (view) | Reads the stored operator back. Check this before a demo. |

Contract errors: `1 SpendingLimitExceeded`, `2 EndpointNotFound`, `3 InvalidPrice`,
`4 InvalidAmount`, `5 NotOperator`.

### Is the deployed contract working?

This is the question to answer first when anything looks wrong. The smoke script runs the whole
demo path against the **deployed** contract — register, three paid calls, a fourth that is
correctly refused, settle, withdraw — and prints a PASS/FAIL line per step:

```bash
npm install                                    # once, at the repo root
OPERATOR_SECRET_KEY=S... npx tsx scripts/smoke-contract.ts
```

It funds a throwaway seller from Friendbot itself, so it needs no setup beyond the operator key —
which cannot be a throwaway, because the contract checks the caller IS its stored operator. It
exits non-zero on any failure and takes about 35 seconds.

### Build and deploy

The `--operator` argument after `--` is the constructor. It must be the public key of the gateway's
`OPERATOR_SECRET_KEY`, or every paid call fails with `NotOperator`.

```bash
cd contract
stellar contract build --locked --optimize
stellar contract deploy \
  --wasm target/wasm32v1-none/release/ramp_ledger.wasm \
  --source-account ramp402-deployer \
  --network testnet \
  --alias ramp_ledger \
  -- \
  --operator G...OPERATOR_PUBLIC_KEY
```

**Do not build contract wasm with Rust 1.81, 1.82, 1.83 or 1.91.0.** The Stellar CLI refuses
those versions outright — they emit wasm it considers unsafe to deploy.
`contract/rust-toolchain.toml` pins 1.90.0 so this cannot happen by accident; rustup installs
it on first use. Bypassing the CLI with plain `cargo` on an unpinned machine can produce, and
deploy, an artifact the CLI would have refused.

Confirm the deployment is addressable, and that its operator is the one the gateway runs with:

```bash
stellar contract info interface --id <CONTRACT_ID> --network testnet
stellar contract invoke --id <CONTRACT_ID> --network testnet \
  --source-account ramp402-deployer -- get_operator
```

If the operator key is ever regenerated, **rotate rather than redeploy** — redeploying mints a new
`CONTRACT_ID` that then has to be re-wired into the gateway and the frontend. The current operator
signs the handover:

```bash
stellar contract invoke --id <CONTRACT_ID> --network testnet \
  --source-account ramp402-operator \
  -- set_operator --new_operator G...NEW_OPERATOR_PUBLIC_KEY
```

A wrong address there cannot be undone — only the stored operator may rotate, so rotating to a key
nobody holds means redeploying. Read it back with `get_operator` immediately afterwards.

### Tests

```bash
cd contract && cargo test          # 23 tests, no network needed
```

`contract/Cargo.lock` is committed on purpose: it pins `ed25519-dalek` to 2.2.0 around a
`soroban-env-host` 23.0.1 resolution break that otherwise stops `cargo test` compiling on a fresh
clone. Build with `--locked`.

## Gateway

Node/TypeScript. Three jobs: the x402 proxy agents pay through, the REST API the dashboard reads,
and the SEP anchor off-ramp that turns USDC into Turkish Lira.

```bash
cd gateway
npm install
cp .env.example .env       # then fill it in — see the table below
npm run dev                # http://localhost:3001
```

### Routes

Exactly the ones in [CONVENTIONS.md §1.3](docs/CONVENTIONS.md). Seller routes take
`Authorization: Bearer <privy_access_token>`; the proxy takes none, because an autonomous agent has
no login.

| Route | What it does |
| --- | --- |
| `POST /api/sellers/bootstrap` | First login: creates the seller row and funds the address via Friendbot. Idempotent. |
| `POST /api/endpoints/prepare` → `/submit` | Two-step registration. The gateway builds an unsigned XDR, Privy signs it in the browser, the gateway submits it and reads the `endpoint_id` **from the contract's return value**. |
| `GET /proxy/:proxy_slug` | The product. 402 → the agent pays → 200. Budget frozen on the pair's first call. |
| `GET /api/endpoints`, `/api/calls`, `/api/balance` | Dashboard reads. `/api/balance` reads the chain, never the `calls` table. |
| `POST /api/withdraw/prepare` → `/submit`, `GET /api/withdrawals/:id` | Two-step withdrawal, then poll. `/submit` answers immediately and the anchor flow runs in the background. |
| `GET /health` | `{ ok: true }` |

### Environment

| Variable | Notes |
| --- | --- |
| `CONTRACT_ID` | The deployed `ramp_ledger` — see `## Contract`. |
| `OPERATOR_SECRET_KEY` | Must be the key baked into that contract, or every paid call fails with `NotOperator`. `scripts/preflight.ts` checks this. |
| `PLATFORM_POOL_SECRET_KEY` | Holds the USDC. Agents pay into it; the anchor is paid from it. |
| `ANCHOR_HOME_DOMAIN` | `tr-mock-anchor.fly.dev` for the TRY demo. Every anchor URL and the USDC issuer are read from its `stellar.toml` — nothing is hardcoded (§1.5). |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Seller authentication. |
| `X402_FACILITATOR_URL` | Verifies and settles agent payments. Stellar is x402 **v2** only. |
| `UPSTREAM_CRED_ENCRYPTION_KEY` | 64 hex characters. Encrypts sellers' upstream API keys at rest. |
| `TREASURY_ADDRESS`, `DB_PATH`, `PORT`, `STELLAR_RPC_URL`, `STELLAR_NETWORK` | |

### Tests

```bash
npm test                # 277 tests, offline, no network and never ramp402.db
npm run test:integration  # the deployed contract, the anchor and the facilitator, for real
```

The integration lane includes a **real withdrawal**: it moves 1 USDC out of the platform pool,
through SEP-10/38/12/6, and asserts the anchor reports `completed` with an
`external_transaction_id`. It skips itself when the environment is not configured.

## Frontend

Next.js. The seller dashboard and the agent console that drives the live demo.

```bash
cd frontend
npm install
cp .env.local.example .env.local    # NEXT_PUBLIC_GATEWAY_URL, NEXT_PUBLIC_PRIVY_APP_ID
npm run dev                         # http://localhost:3000
npm run check                       # typecheck, lint and a production build
```

| Page | What it is |
| --- | --- |
| `/` | Landing. |
| `/dashboard` | The seller: register an endpoint, watch calls arrive, see the balance the chain reports, withdraw to TRY. |
| `/agent-console` | A real x402 client. Funds a throwaway agent, pays per call, and shows the budget being spent and then refused. |

**Signing.** Privy holds the seller's Stellar key and signs raw 32-byte hashes
(`signRawHash` on `tx.hash()`), which spike S3 verified covers SEP-10 challenges, classic payments
and Soroban `invoke_host_function` alike. The client wraps the signature in an
`xdr.DecoratedSignature`. No external wallet is needed.

## Demo

Five minutes, in this order. Run the preflight first — it catches every failure we have actually
hit, in about three seconds.

```bash
npx tsx scripts/preflight.ts        # expect 8/8 PASS
npx tsx scripts/reset-demo.ts       # clean dashboard: no calls, no withdrawals
cd gateway && npm run dev           # :3001
cd frontend && npm run dev          # :3000
```

**1. The seller registers an API.** On `/dashboard`, log in with Privy — the account is created and
funded by Friendbot behind the scenes, so there is nothing to explain about faucets. Register an
endpoint with a price. The `endpoint_id` in the table came back from the contract, not from a
counter in our database.

**2. An agent pays per call.** On `/agent-console`, call the endpoint. The first request returns
**402** with the payment requirements; the client signs a payment and retries; the second returns
**200** with the upstream's data. The call appears on the dashboard with its transaction hash.

**3. The budget holds.** The agent's budget was frozen on its first call. Keep calling: the fourth
is refused with **403 budget_exceeded** — and it stays refused even if the client asks for a larger
budget, because the parameter is never read again. That is a security property with a contract test
guarding it.

**4. The seller withdraws to Turkish Lira.** Click **TL'ye Çek**. The gateway zeroes the on-chain
balance, then runs SEP-10 → SEP-38 → SEP-12 → SEP-6 in the background and pays the anchor with a
classic payment carrying its `id` memo. The dashboard polls and shows the anchor's own status until
it reads `completed`, with the bank reference the anchor returned.

If anything looks wrong mid-demo, the answer is almost always in `npx tsx scripts/preflight.ts`.

## Architecture

```
  agent ──402/pay──►  gateway /proxy/:slug  ──record_call──►  ramp_ledger (Soroban)
                           │                                        │
                           ├── forwards to the seller's upstream    ├── budget frozen per
                           │                                        │   (agent, endpoint)
                           └── settle 1% / 99% ────────────────────►┘
                                                                    │
  seller ──Privy sign──►  gateway /api/withdraw  ──withdraw()───────►┘
                           │
                           └── SEP-10/38/12/6 ──►  anchor  ──►  TRY to a bank account
                                   USDC paid from the platform pool, memo_type id
```

The contract is a **ledger**: it records who spent what and who is owed what, and never holds or
transfers a token. USDC moves off chain from the platform pool. That is a deliberate decision, not
an oversight — the contract custodies nothing, so there is nothing in it to steal, and no token
transfer can fail halfway through a settlement.

Full reasoning in [docs/TECHNICAL.md](docs/TECHNICAL.md); the interfaces all three components build
against are in [docs/CONVENTIONS.md](docs/CONVENTIONS.md).

## Team

Built for the Stellar Pro Hackathon, Genesis Track, 19–20 September 2026.

| | |
| --- | --- |
| Efe | `contract/` — the `ramp_ledger` Soroban contract, deployment and the verification scripts |
| Ömer | `gateway/` — the x402 proxy, the REST API and the anchor off-ramp |
| Mert | `frontend/` — the seller dashboard and the agent console |
