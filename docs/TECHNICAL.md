# Ramp402 — technical notes

How the system is built, and why it is built that way. The interfaces the three components agree on
live in [CONVENTIONS.md](CONVENTIONS.md); this document is the reasoning behind them and an honest
account of what is real and what is simulated.

Stellar Pro Hackathon, Genesis Track, 19–20 September 2026.

---

## The problem

An autonomous agent that wants data has no way to pay for it. Cards need a human, invoices need a
company, and API keys need a signup flow the agent cannot complete. Meanwhile a developer with a
useful API has no way to sell single calls: the payment rails cost more than the call is worth.

Ramp402 puts an API behind a proxy that speaks **x402**, so an agent pays per request in USDC with
no account and no key. The developer withdraws the proceeds to a Turkish bank account in lira,
through a Stellar anchor. Neither side ever sees the other's payment details.

---

## The three components

| | |
| --- | --- |
| `contract/` | `ramp_ledger`, a Soroban contract in Rust. Records who spent what and who is owed what. |
| `gateway/` | Node/TypeScript. The x402 proxy, the REST API, a SQLite cache, and the SEP anchor client. |
| `frontend/` | Next.js. The seller dashboard and a real x402 agent client. |

A paid call:

```
agent ─GET /proxy/:slug──► gateway ─402 PAYMENT-REQUIRED─► agent
agent ─PAYMENT-SIGNATURE─► gateway
                             ├─ facilitator verifies the payment
                             ├─ record_call()  ── contract charges the agent's budget
                             ├─ forwards the request to the seller's upstream API
                             ├─ settle()       ── 1% treasury, 99% seller
                             └─200 + PAYMENT-RESPONSE─► agent
```

---

## Decisions, and why

### The contract holds no tokens

`ramp_ledger` never receives, holds or transfers a token. It records balances; the USDC itself sits
in a platform pool account and moves with ordinary Stellar payments.

This is deliberate. A contract that custodies funds is the part an attacker attacks, and a token
transfer inside a settlement is a step that can fail halfway and leave the ledger disagreeing with
reality. Keeping the contract to arithmetic means there is nothing in it to steal, every state
change is a single atomic write, and the chain stays the source of truth for what is owed —
`GET /api/balance` reads the contract, never a sum of our own database rows.

The cost is honest: the pool is a custodial account, and a seller's claim on it is only as good as
the operator. For a hackathon on testnet that is the right trade; a production version would move
the pool to a multisig or replace it with a SAC transfer inside `settle`.

### The operator is an identity, not just a signature

`record_call` and `settle` are called by the gateway, not by the agent — asking an autonomous agent
for a second signature on every request defeats the point of x402.

The first implementation took an `operator` argument and called `operator.require_auth()`. That is
not enough, and the gap is worth describing because it is easy to miss: `require_auth()` proves that
*whoever was named* signed, and any address can sign for itself. Anyone could call
`settle(themselves, endpoint_id, any_amount)` and credit any seller any balance — and because the
chain is the source of truth, the gateway would believe it and pay out real USDC.

So the contract now stores its operator, fixed at deploy time by `__constructor`, and both functions
check that the caller **is** that address before doing anything. `set_operator` allows a rotation
signed by the current operator, so a regenerated key does not force a redeployment — a redeployment
mints a new `CONTRACT_ID`, which has to be re-wired into the gateway and the frontend, and that is
the kind of change nobody wants to make during a demo.

Four tests guard it; deleting the identity check fails exactly those four and nothing else.

### The budget is frozen on the first call

An agent's spending limit is set by the **first** call it makes to an endpoint, and the parameter is
never read again. There are no sessions, no `session_id`, and nothing for the agent to carry: the
pair `(agent address, endpoint_id)` is the identity of a budget.

That matters because the alternative is a limit an attacker can raise by asking. A later call
passing a larger budget must not move the ceiling — and `record_call` reads the parameter only when
no entry exists yet, so the property is structural rather than a condition someone can invert later.
The test drives an agent to its ceiling *while asking for a thousand times more*, and watches the
fourth call refused.

One consequence worth knowing: a first call with a budget below the price is refused and freezes
nothing, so the agent can come back with a workable budget instead of being locked out by a number
it never meant.

### Integer arithmetic, and who keeps the remainder

Every amount is an integer count of stroops; no decimal reaches the chain. `settle` takes 1% for the
treasury and credits 99% to the seller:

```rust
let treasury_share = amount / 100;          // truncating
let seller_share   = amount - treasury_share;
```

Deriving the second share by **subtraction** rather than a second division is the part that matters:
it makes `seller_share + treasury_share == amount` an identity for every input, so settlement can
neither create nor lose a stroop whatever the remainder is. The sub-stroop remainder therefore stays
with the seller, at most 0.99 of a stroop per settlement — CONVENTIONS.md §1.2 says so explicitly,
because an earlier draft of that rule contradicted its own formula.

### The 1 USDC minimum is a floor, never a cap

The anchor will not process less than 1 USDC. The failure to avoid is treating that as a cap and
paying out 1 USDC of a 25 USDC balance. `POST /api/withdraw/prepare` refuses a balance below
10,000,000 stroops with a message naming the real numbers, and withdraws anything above it **in
full**. Three tests cover it: below refused, exactly 10,000,000 accepted, 25 USDC withdrawn whole.

### `withdraw` returns 0 rather than failing

Withdrawing an empty balance is a no-op that returns 0, not a panic. A retried submission is then a
safe no-op instead of a transaction failure, and the too-small check belongs in the gateway anyway,
where it can be a readable message instead of contract error #4.

---

## The off-ramp

The part with the most moving pieces, and the one that is genuinely end-to-end.

`POST /api/withdraw/submit` answers as soon as the on-chain entry is made and runs the anchor flow in
the background — it takes minutes and involves a third party, so making a browser wait for it would
time out long before the money moved. `GET /api/withdrawals/:id` is how the UI follows along.

```
SEP-1   read stellar.toml          every URL and the USDC issuer, never hardcoded
SEP-10  authenticate               JWT; on a later 401, re-authenticate and retry once
SEP-38  quote                      lock a rate before the money moves
SEP-12  KYC                        the form is built from the fields the anchor RETURNS
SEP-6   withdraw                   returns an account, a memo, and a memo type
        classic payment            from the pool, memo_type id, the anchor's exact memo
        poll                       until completed or error, writing each status to the row
```

**A verified run** against `tr-mock-anchor.fly.dev`:

```
[pending_anchor]              authenticating with tr-mock-anchor.fly.dev
[pending_anchor]              rate locked: 1.0000000 USDC → 48.54 TRY
[pending_user_transfer_start] anchor is waiting for 1.0000000 USDC
[pending_anchor]              payment sent, waiting for the anchor
[completed]                   TRY paid to TR800009901526653519583372 via FAST (simulated)

anchorTxId "sep_zrug9v586sq7858vaxhv" · externalTransactionId "FAST-QKBAOSW13H"
platform pool 211.4878165 → 209.4878165 USDC
```

Three details that each cost someone a debugging session:

- **The payment is a classic payment operation with `memo_type: id`.** Not a contract call, not a
  text memo. Both are accepted by the network and ignored by the anchor, which is the worst possible
  outcome: the money leaves and nothing is credited. `payout.ts` refuses any memo type but `id`
  rather than send something that cannot be matched.
- **The gateway authenticates as the platform pool, not the seller.** The flow runs in the
  background where no user is present, and the seller's key lives in Privy on their device. The pool
  is also the account sending the USDC, so it is the anchor's customer. This looks wrong until you
  see why, so it is commented in `sep10.ts`.
- **A gateway restart must not strand a withdrawal.** On startup the gateway resumes polling any row
  still `pending` that reached the anchor. Rows that did *not* reach it cannot be resumed safely —
  re-running the flow would pay the anchor twice — so they are reported for a human instead.

### Our statuses are not the anchor's

`withdrawals.status` is `pending | completed | failed` and nothing else. The anchor's SEP-6 status is
a longer, anchor-defined list and is carried verbatim in `anchor_status`. A withdrawal waiting on a
trustline is `pending` with `anchor_status: "pending_trust"` and, when the anchor issues one, a
`claimable_balance_id` for the UI to build a claim from.

Merging the two vocabularies was the obvious move and the wrong one: a status alone cannot render a
claim path — the UI needs the balance id regardless — and every future status an anchor invents
would become a change to our own enum. A client that ignores the extra fields still shows "pending",
which is true.

---

## Security notes

- **Sellers' upstream credentials are encrypted at rest.** A URL like
  `https://user:pass@api.example.com/v1?api_key=…` is split at registration: the credential-free URL
  is stored and shown, the credentials are AES-256-GCM encrypted into `upstream_credentials_enc` and
  never returned by any route. The stored value carries its IV and auth tag, so tampering fails
  decryption instead of yielding altered credentials.
- **Cross-seller isolation** is tested on every route that takes an id. Another seller's withdrawal,
  endpoint, call log or draft is reported exactly like one that does not exist — a 403 would itself
  confirm the resource is real.
- **Drafts are single use.** A prepared transaction can reach the network at most once, and the
  submitted XDR must hash to the one that was prepared, so a cheaper price cannot be swapped in.
- **`endpoint_id` never passes through a JavaScript number.** It is a contract-assigned `u64` stored
  as its decimal string; a test round-trips `18446744073709551615` to prove precision is not lost.

## What is real, and what is not

Worth stating plainly rather than letting a demo imply more than it should.

**Real:** the Soroban contract and every call to it, on Stellar testnet. The x402 payments, verified
and settled by the public facilitator. The USDC, and the classic payment that moves it out of the
pool. The SEP-10, SEP-38, SEP-12 and SEP-6 exchanges, spoken to a live anchor over HTTP exactly as
the standards describe.

**Simulated:** the bank leg. `tr-mock-anchor.fly.dev` is a sandbox anchor: it quotes a real USD/TRY
rate and returns a real IBAN-shaped reference, but no lira actually arrives in a Turkish bank. The
anchor is the only mocked component, and it is mocked at the boundary the standards define — the
gateway cannot tell the difference, which is the point.

Because everything is read from SEP-1, pointing `ANCHOR_HOME_DOMAIN` at a production anchor is a
configuration change, not a code change. `testanchor.stellar.org` works today and settles in USD,
since it does not sell TRY.

No code in the repository is mock-only, so checklist §5b's `// MOCK ANCHOR ONLY` marker has nothing
to mark: the anchor completes the flow on its own and needs no `simulate-bank-transfer` nudge.

**One honest wart:** `frontend/lib/agent.ts` hardcodes the testnet USDC issuer as a constant used
when funding the demo agent. The issuer an agent *pays* is taken from the 402's payment
requirements, so the payment path is correct; the constant only affects funding a throwaway account
in the console.

---

## Verifying it yourself

```bash
npx tsx scripts/preflight.ts        # 8 checks: config, chain, pool, anchor, facilitator, cache
npx tsx scripts/smoke-contract.ts   # the deployed contract, on chain, 8 steps
npx tsx scripts/verify-e2e.ts       # the whole product, against a running gateway
cd contract  && cargo test          # 23 tests
cd gateway   && npm test            # 277 tests, offline
cd gateway   && npm run test:integration   # the anchor, for real — moves 1 USDC
cd frontend  && npm run check       # typecheck, lint, production build
```

`preflight.ts` is the one to run before a demo. It found a real inconsistency the first time it was
run: the scripts and the gateway were pointed at two different anchors.

`verify-e2e.ts` is the whole claim in one run. A recorded result:

```
[PASS] the agent funds itself — no account, no API key — 210.5888948 USDC via Friendbot and the DEX
[PASS] a first call without X-Agent-Budget is refused, and charges nothing
[PASS] 3 paid calls: 402 → pay → 200 — upstream data returned
[PASS] the seller was credited 99% of what the agent paid — +0.2970000 USDC on chain
[PASS] the frozen budget refuses the next call — 403 budget_exceeded
```

The agent's own balance went 210.5888948 → 210.2888948, exactly three calls at 0.1 USDC, and the
seller gained 0.2970000 — three times the 99% share. Nothing there is asserted against our database;
the balance is read from the contract.

One ordering detail the script made concrete, worth knowing if you write an x402 client: a first
call with no `X-Agent-Budget` is answered **402, not 400**. The gateway learns which agent is calling
from the payment signature, so until one arrives it cannot know whether this is a first call for the
pair. The 400 lands on the paid attempt, and the verified payment is cancelled rather than settled —
so a refused call really does charge nothing.
