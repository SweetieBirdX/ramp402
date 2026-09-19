# Proposed changes to CONVENTIONS.md §1.2 — operator identity and amount validation

**Status: PROPOSED — not yet applied.** `docs/CONVENTIONS.md` is unchanged. Efe applies this to
§1.2 once Ömer and Mert have agreed, per Rule 0, and everyone pulls immediately afterwards.

The contract code in `contract/` already implements everything below, with tests. That is
deliberate: the code is easier to judge than a description, and reverting it is one `git revert`.
If the team rejects a point here, say so and the code changes to match — the document wins.

Author: Efe · 19 September 2026

---

## Why

`operator` is a parameter, and the contract never knew which address the gateway's operator
actually is. `operator.require_auth()` proves only that *whoever was named* signed, and any address
can sign for itself. So today, on the deployed contract, anyone can:

1. call `settle(themselves, endpoint_id, any_amount)` and credit any seller any balance. §1.3 says
   `GET /api/balance` reads the chain and that the chain is the source of truth, so the gateway
   believes it and pays out real USDC from the platform pool through the anchor;
2. call `record_call(themselves, victim_agent, endpoint_id, 1)` and freeze that agent's budget at
   one stroop — permanently, because the budget is frozen on the first call and never re-read;
3. inflate `TreasuryTotal` at will.

Separately, `settle` accepts a negative `amount`, which *debits* a seller's balance.

---

## Change 1 — storage gains an operator address

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

## Change 2 — three functions, and two of the six gain a panic

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

`get_operator` is the one item here nobody asked for. It is a three-line view, and it is what lets
`scripts/preflight.ts` confirm in one RPC call that the deployed operator matches the gateway's
`OPERATOR_SECRET_KEY` before a demo instead of after it. Drop it if you would rather keep the ABI
at the agreed six-plus-two.

## Change 3 — the error codes get written down

§1.2 has never listed them, and `gateway/src/stellar.ts` currently carries them as a comment
("1 = SpendingLimitExceeded, 2 = EndpointNotFound"). Proposed table:

| Code | Name | Raised by | Means |
| --- | --- | --- | --- |
| 1 | `SpendingLimitExceeded` | `record_call` | `spent + price > allocated` |
| 2 | `EndpointNotFound` | `record_call`, `settle`, `get_endpoint` | no such `endpoint_id` |
| 3 | `InvalidPrice` | `register_endpoint` | `upstream_price <= 0` |
| 4 | `InvalidAmount` | `settle`, `record_call` | `amount <= 0`, or a first-call `budget <= 0` |
| 5 | `NotOperator` | `record_call`, `settle`, `set_operator`, `get_operator` | wrong caller, or no operator stored |

Codes are append-only: a number that has been deployed is never reused for a different meaning.

## Change 4 — the rounding rule stops contradicting itself

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
changes.** Say if you want it the other way round.

---

## Not part of this proposal, raised separately

§1.1 lists seven machine codes. `gateway/src/types.ts` already ships three more — `invalid_request`,
`not_found`, `internal_error` — which Mert types against. §1.1 should probably be brought in line
with what the gateway actually built, but that is Ömer's call to describe and a separate edit.

---

## What each person has to do if this is approved

**Ömer** — three things, none of them urgent enough to interrupt him mid-task:

1. The real contract deploy now takes `-- --operator G...`. The README's `## Contract` section has
   the command. Whatever `OPERATOR_SECRET_KEY` the gateway runs with, its public key must be that
   argument, or every `record_call` and `settle` fails with `NotOperator`.
2. Contract error codes 3, 4 and 5 exist now (table above). `SorobanError.contractErrorCode`
   already surfaces the number, so nothing breaks — it is a mapping opportunity, not a fix.
3. Unrelated to the operator work: `/api/withdraw/prepare` needs the §1.5 minimum-amount guard.
   The contract's `withdraw` returns 0 for an empty balance and deliberately does not panic, so
   the gateway is the only thing stopping a seller signing a transaction that moves nothing.

**Mert** — nothing changes on the frontend. No route, payload or type is touched.

## Open question for the three of us

Should `set_operator` also require the **new** operator to sign? Today only the current operator
signs, which is what was asked for. It means a mistyped address silently locks the role away and
only a redeployment recovers it — and a redeployment changes `CONTRACT_ID`, which is the thing this
function exists to avoid. Requiring both signatures makes that mistake impossible, at the cost of a
rotation transaction signed by two keys. One line either way; I did not want to choose it for you.
