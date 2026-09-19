# Batched changes to CONVENTIONS.md — review before merging

**Status: A and B are APPLIED to `docs/CONVENTIONS.md`. C is still PROPOSED.**

Three unrelated corrections were batched deliberately: each one on its own would cost the team a
pull, a re-read and an interruption.

| | What | Section | Status | Who it affects |
| --- | --- | --- | --- | --- |
| **A** | Operator identity, constructor, rotation, amount validation | §1.2 | **applied** | Ömer (deploy + error codes) |
| **B** | x402 v2 header names — the document named v1 headers that do not exist for Stellar | §1.3 | **applied** | Ömer (P3-O3), Mert |
| **C** | Encrypted upstream credentials column | §1.4 + `schema.sql` | **pending Ömer** | Ömer (P3-O2) |

**Why A and B went in without waiting, and C did not.** A describes a contract that is already
deployed and running — §1.2 was factually wrong about live code, and Ömer writes P3-O2 against it
next. B is a fact about the protocol, not a preference: Stellar's facilitator does not speak x402
v1, so the header names §1.3 gave were unusable, and P3-O3 is the very next thing to be built
against them. Neither obliges anyone to change a file they own.

C does. It asks Ömer to add a column to `gateway/schema.sql`, which is his file, so it stays a
proposal until he agrees. Nobody has touched `schema.sql`.

If the team disagrees with anything already applied, say so and it comes back out — the document
wins over the code, which is the whole point of Rule 0.

Author: Efe · 19 September 2026

---

# A — Operator identity and amount validation (§1.2)

**Implemented and live** in `CC73BWETYN2PWAO6YPDLX4H75XUUMH4HDQQJMJYQPY2SW3PE2TEP4CVJ`, with 23
unit tests and an on-chain smoke test. The document is what is now behind.

## Why

`operator` was a parameter, and the contract never knew which address the gateway's operator
actually is. `operator.require_auth()` proves only that *whoever was named* signed, and any address
can sign for itself. Before this change, anyone could:

1. call `settle(themselves, endpoint_id, any_amount)` and credit any seller any balance. §1.3 says
   `GET /api/balance` reads the chain and that the chain is the source of truth, so the gateway
   believes it and pays out real USDC from the platform pool through the anchor;
2. call `record_call(themselves, victim_agent, endpoint_id, 1)` and freeze that agent's budget at
   one stroop — permanently, because the budget is frozen on the first call and never re-read;
3. inflate `TreasuryTotal` at will.

`settle` also accepted a negative `amount`, which *debits* a seller's balance.

## A1 — storage gains an operator address

§1.2's storage block, replacing the current one:

```
Operator:       Address                        → INSTANCE storage. The one keypair allowed to
                                                 call record_call and settle. Set by the
                                                 constructor, rotated by set_operator.
NextEndpointId: u64                            → counter, +1 on every register_endpoint
Endpoints:      Map<u64, EndpointInfo>         → EndpointInfo { seller: Address, price: i128 }
Budgets:        Map<(Address, u64), BudgetEntry>
                                               → key = (agent, endpoint_id)
                                               → BudgetEntry { allocated: i128, spent: i128 }
SellerBalances: Map<Address, i128>             → settle() credits 99% here, withdraw() zeroes it
TreasuryTotal:  i128                           → cumulative 1% platform fee
```

`Operator` is the only entry in **instance** storage; the rest stay persistent. It is a single
address read on every privileged call, so it belongs with the contract instance: it loads with the
contract and its TTL rides along with the instance instead of being a separate entry that can
expire on its own. The TTL rule is unchanged — every write extends it.

## A2 — three functions, and two of the six gain a panic

Added to §1.2's signature list:

```rust
// 0) Runs once, inside the deployment transaction. The argument is mandatory, so no deployment
//    can exist without an operator. No auth: the deployer chooses who keeps the books.
fn __constructor(env: Env, operator: Address);

// 7) Hand the operator role to a different keypair. The CURRENT operator must sign.
fn set_operator(env: Env, new_operator: Address);
// event: OperatorChanged { previous, current }
// panic: NotOperator  if the current operator has not signed

// 8) View function (no auth). Reads the stored operator back.
fn get_operator(env: Env) -> Address;
// panic: NotOperator  if none is stored (the CONTRACT_ID predates the constructor)
```

`record_call` and `settle` keep their signatures exactly, and gain:

```
// panic: NotOperator    if the caller is not the stored operator
// panic: InvalidAmount  settle: if amount <= 0
//                       record_call: if the pair's FIRST call passes budget <= 0
```

`record_call` validates `budget` **only on the first call for the pair**. On later calls the
parameter stays ignored entirely, including when the gateway has no `X-Agent-Budget` header to
forward and sends 0 — §1.3 allows exactly that, and validating on every call would break the proxy
on its second request.

`get_operator` is the one item nobody asked for. It is a three-line view, and it is what lets
`scripts/preflight.ts` confirm in one RPC call that the deployed operator matches the gateway's
`OPERATOR_SECRET_KEY` before a demo instead of after it.

## A3 — the error codes get written down

§1.2 has never listed them, and `gateway/src/stellar.ts` carries them as a comment
("1 = SpendingLimitExceeded, 2 = EndpointNotFound"). Proposed table:

| Code | Name | Raised by | Means |
| --- | --- | --- | --- |
| 1 | `SpendingLimitExceeded` | `record_call` | `spent + price > allocated` |
| 2 | `EndpointNotFound` | `record_call`, `settle`, `get_endpoint` | no such `endpoint_id` |
| 3 | `InvalidPrice` | `register_endpoint` | `upstream_price <= 0` |
| 4 | `InvalidAmount` | `settle`, `record_call` | `amount <= 0`, or a first-call `budget <= 0` |
| 5 | `NotOperator` | `record_call`, `settle`, `set_operator`, `get_operator` | wrong caller, or no operator stored |

Codes are append-only: a number that has been deployed is never reused for a different meaning.

## A4 — the rounding rule stops contradicting itself

§1.2 currently says:

> **Rounding rule for `settle`:** integer arithmetic only. `treasury_share = amount / 100` (integer
> division), then `seller_share = amount - treasury_share`. Rounding must never favour the payer or
> the seller over the treasury.

The formula and the sentence disagree for every amount not divisible by 100. With truncating
division the sub-stroop remainder stays with the **seller**: for `amount = 333`, exact 1% is 3.33,
the treasury takes 3 and the seller keeps 330 — which is what the sentence forbids. Proposed
replacement:

> **Rounding rule for `settle`:** integer arithmetic only. `treasury_share = amount / 100` (integer
> division, truncating), then `seller_share = amount - treasury_share`. Deriving the second share by
> subtraction rather than a second division makes `seller_share + treasury_share == amount` an
> identity for every input: settlement can neither create nor lose a stroop. The sub-stroop
> remainder therefore stays with the seller — at most 0.99 of a stroop per settlement. The gateway
> must mirror this formula exactly; any other arithmetic makes the dashboard disagree with the
> chain.

The alternative is to change the code instead: ceiling division, `(amount + 99) / 100`, gives the
remainder to the treasury and satisfies the sentence as written. One line in `settle`, one line
wherever the gateway mirrors it. **The formula is implemented; the sentence is what this proposal
changes.**

---

# B — x402 v2 header names (§1.3)

**Not yet implemented — this is ahead of the code, and P3-O3 depends on it.**

§1.3 currently says:

> - `GET /proxy/:proxy_slug` — 402 → retry with `X-PAYMENT` → 200.

`X-PAYMENT` and `X-PAYMENT-RESPONSE` are **x402 v1** names. Stellar's facilitator only speaks
**v2** — there is no v1 entry for Stellar at `https://x402.org/facilitator/supported` — and v2
renamed the headers. Following the document as written produces a proxy that no x402 client can
talk to, and the failure is a silent mismatch rather than an error.

Proposed replacement for that bullet:

> - `GET /proxy/:proxy_slug` — 402 → retry with a payment → 200, over **x402 v2**. Stellar's
>   facilitator does not support v1, so the v1 header names `X-PAYMENT` / `X-PAYMENT-RESPONSE` are
>   never used. The v2 headers are:
>
>   | Header | Direction | Carries |
>   | --- | --- | --- |
>   | `PAYMENT-REQUIRED` | gateway → agent, with the 402 | what must be paid, for this endpoint's price |
>   | `PAYMENT-SIGNATURE` | agent → gateway, on the retry | the agent's signed payment |
>   | `PAYMENT-RESPONSE` | gateway → agent, with the 200 | the facilitator's settlement receipt |
>
>   Build and parse these with `@x402/express`, pinned to `2.26.0` (spike S1). Never hand-construct
>   the header: its encoding is part of the protocol and changes between versions.

`X-Agent-Budget` is **ours**, not x402's, and is unaffected — it keeps its name, stays mandatory on
a pair's first call, and is still ignored afterwards.

Everything else in §1.3's `/proxy` rules stands: `400 missing_budget_header`, `403 budget_exceeded`
with the rejected transaction hash, `502 upstream_failed` with no `settle`.

---

# C — encrypted upstream credentials (§1.4 and `schema.sql`)

**Not yet implemented — P3-O2 needs it.** Checklist §C requires the seller's upstream API key to be
encrypted at rest. A seller registering `https://user:key@api.example.com/v1` must not have those
credentials sitting in plaintext in a table, and `upstream_url` must be stored stripped of them, or
they leak through `GET /api/endpoints` into the dashboard.

`schema.sql` has nowhere to put them today. Proposed change to the `endpoints` table — one column:

```sql
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  upstream_url TEXT NOT NULL,
  upstream_credentials TEXT,          -- encrypted; NULL when the upstream needs no auth
  proxy_slug TEXT NOT NULL UNIQUE,
  price_stroops INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Rules to add under §1.4:

- `upstream_url` is stored **with any credentials removed**. It is returned by `GET /api/endpoints`
  and must be safe to show in the UI.
- `upstream_credentials` holds ciphertext, never plaintext, encrypted with
  `UPSTREAM_CRED_ENCRYPTION_KEY` (already in `gateway/.env.example`; 64 hex characters = a 32-byte
  AES-256 key). It is **never** returned by any route — not `GET /api/endpoints`, not in an error
  message, not in a log line. Only the proxy reads it, and only to attach it to the upstream
  request.
- The stored value must carry everything decryption needs: with AES-256-GCM that means the IV and
  the auth tag alongside the ciphertext, e.g. `base64(iv):base64(tag):base64(ciphertext)`.
  Ciphertext alone cannot be decrypted, and discovering that after the demo data exists is
  expensive.
- `NULL` means the upstream needs no authentication. That is the common case and must not be
  treated as an error.

**Migration: there isn't one.** `schema.sql` is idempotent `CREATE TABLE IF NOT EXISTS`, so adding a
column does nothing to a database that already exists. SQLite here is a rebuildable cache and the
chain is the source of truth, so the migration is to delete `ramp402.db` and let it be recreated —
which is exactly what `npx tsx scripts/reset-demo.ts` does. Anyone who pulls this change and sees
"no such column: upstream_credentials" should run that.

---

## Not part of this proposal, raised separately

§1.1 lists seven machine codes. `gateway/src/types.ts` already ships three more — `invalid_request`,
`not_found`, `internal_error` — which Mert types against. §1.1 should be brought in line with what
the gateway actually built, but that is Ömer's call to describe and a separate edit.

---

## What each person does if this is approved

**Ömer**

1. **A** — the contract is already deployed with the operator baked in. `CONTRACT_ID` is
   `CC73BWETYN2PWAO6YPDLX4H75XUUMH4HDQQJMJYQPY2SW3PE2TEP4CVJ`; the existing `OPERATOR_SECRET_KEY`
   is unchanged and still correct. Contract error codes 3, 4 and 5 now exist (table A3);
   `SorobanError.contractErrorCode` already surfaces the number, so nothing breaks.
2. **B** — build P3-O3 against the v2 header names. This is the one change that would have cost
   real debugging time if it had been found during integration instead of before.
3. **C** — `schema.sql` is yours; the column above is a proposal, not an edit. Nobody has touched
   your file.
4. Unrelated to all three: `/api/withdraw/prepare` needs the §1.5 minimum-amount guard. The
   contract's `withdraw` returns 0 for an empty balance and deliberately does not panic, so the
   gateway is the only thing stopping a seller signing a transaction that moves nothing.

**Mert** — **B** may affect the agent console if it speaks x402 directly. Nothing else changes: no
route, payload or type is touched.

## Open question for the three of us

Should `set_operator` also require the **new** operator to sign? Today only the current operator
signs, which is what was asked for. It means a mistyped address silently locks the role away and
only a redeployment recovers it — and a redeployment changes `CONTRACT_ID`, which is the thing the
function exists to avoid. Requiring both signatures makes that mistake impossible, at the cost of a
rotation transaction signed by two keys. One line either way.
