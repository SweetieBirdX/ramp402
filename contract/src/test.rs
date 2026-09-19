#![cfg(test)]

use crate::{BudgetEntry, DataKey, EndpointInfo, Error, RampLedger, RampLedgerClient};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, Map,
};

/// Reusable fixture for the `ramp_ledger` tests.
///
/// Owns the `Env` so the generated client can borrow from it; call
/// [`TestSetup::client`] inside each test to get a client bound to this env.
#[allow(dead_code)]
pub struct TestSetup {
    pub env: Env,
    pub contract_id: Address,
    /// Registers endpoints and withdraws - signs for itself.
    pub seller: Address,
    /// Pays per call. Never signs; the operator acts on its behalf.
    pub agent: Address,
    /// The gateway's single operator keypair: signs `record_call` and `settle`.
    pub operator: Address,
    /// NOTE: `TreasuryTotal` is a plain `i128` counter in storage, not an
    /// address - no function in CONVENTIONS.md 1.2 takes a treasury address.
    /// Kept here because the gateway carries a `TREASURY_ADDRESS`, so tests
    /// that assert on the off-chain split have somewhere to point.
    pub treasury: Address,
}

#[allow(dead_code)]
impl TestSetup {
    pub fn new() -> Self {
        let env = Env::default();
        let contract_id = env.register(RampLedger, ());
        Self {
            seller: Address::generate(&env),
            agent: Address::generate(&env),
            operator: Address::generate(&env),
            treasury: Address::generate(&env),
            contract_id,
            env,
        }
    }

    pub fn client(&self) -> RampLedgerClient<'_> {
        RampLedgerClient::new(&self.env, &self.contract_id)
    }

    /// The stored `BudgetEntry` for an (agent, endpoint_id) pair, or `None` if
    /// no entry has been frozen yet.
    ///
    /// CONVENTIONS.md 1.2 gives the contract no budget view function, so the
    /// tests read the persistent map directly from inside the contract's own
    /// storage context. Asserting on `allocated` is the only way to prove the
    /// frozen value is untouched, rather than inferring it from a later
    /// rejection.
    pub fn budget_entry(&self, agent: &Address, endpoint_id: u64) -> Option<BudgetEntry> {
        self.env.as_contract(&self.contract_id, || {
            self.env
                .storage()
                .persistent()
                .get::<DataKey, Map<(Address, u64), BudgetEntry>>(&DataKey::Budgets)
                .and_then(|budgets| budgets.get((agent.clone(), endpoint_id)))
        })
    }
}

// ---------------------------------------------------------------------------
// The six tests required by CONVENTIONS.md 1.2. All `#[ignore]` until the
// contract bodies replace their `todo!()`s.
// ---------------------------------------------------------------------------

/// CONVENTIONS.md 1.2 test 1 - "Calling `register_endpoint` twice returns two
/// different ids (counter increments correctly)".
#[test]
fn test_register_endpoint_increments_id() {
    let t = TestSetup::new();
    let client = t.client();

    // register_endpoint calls seller.require_auth(); this test is about the
    // counter, not about authorisation (test 5 covers that).
    t.env.mock_all_auths();

    let first = client.register_endpoint(&t.seller, &1_000);
    let second = client.register_endpoint(&t.seller, &2_500);

    // The counter is 1-based: CONVENTIONS.md 1.1 spells the SQLite string forms
    // as ("1", "2", ...).
    assert_eq!(first, 1);
    assert_ne!(first, second);
    assert_eq!(second, first + 1);

    // A DIFFERENT seller advances the SAME global counter - ids are unique
    // per contract, not per seller.
    let other_seller = Address::generate(&t.env);
    let third = client.register_endpoint(&other_seller, &7);
    assert_eq!(third, second + 1);

    // Each id maps to its own stored EndpointInfo - the ids are not merely
    // distinct numbers, they address distinct rows.
    assert_eq!(
        client.get_endpoint(&first),
        EndpointInfo {
            seller: t.seller.clone(),
            price: 1_000,
        }
    );
    assert_eq!(
        client.get_endpoint(&second),
        EndpointInfo {
            seller: t.seller.clone(),
            price: 2_500,
        }
    );
    assert_eq!(
        client.get_endpoint(&third),
        EndpointInfo {
            seller: other_seller,
            price: 7,
        }
    );
}

/// CONVENTIONS.md 1.2 test 2 - "`record_call` freezes `budget` on the first call;
/// on the second call the parameter is ignored - passing a *larger* budget later
/// must NOT raise the limit". This is the security property named in CLAUDE.md's
/// known traps.
#[test]
fn test_record_call_freezes_budget_on_first_call() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    let id = client.register_endpoint(&t.seller, &1_000);

    // FIRST call freezes the budget at 3_000 and spends one call's price.
    client.record_call(&t.operator, &t.agent, &id, &3_000);
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 3_000,
            spent: 1_000,
        })
    );

    // SECOND call passes a MUCH larger budget. The parameter must be ignored
    // outright: allocated stays 3_000. This is the security property.
    client.record_call(&t.operator, &t.agent, &id, &999_999);
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 3_000,
            spent: 2_000,
        })
    );

    // Third call: still allowed, 3_000 spent of the frozen 3_000.
    client.record_call(&t.operator, &t.agent, &id, &999_999);
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 3_000,
            spent: 3_000,
        })
    );

    // Fourth call would put spent at 4_000 > 3_000. It must fail EVEN THOUGH
    // every call since the first has asked for 999_999 - proving the raised
    // budget never took effect.
    assert_eq!(
        client.try_record_call(&t.operator, &t.agent, &id, &999_999),
        Err(Ok(Error::SpendingLimitExceeded.into()))
    );

    // A DIFFERENT agent on the SAME endpoint gets its own independent entry:
    // the key is (agent, endpoint_id), not endpoint_id alone.
    let other_agent = Address::generate(&t.env);
    assert_eq!(t.budget_entry(&other_agent, id), None);
    client.record_call(&t.operator, &other_agent, &id, &5_000);
    assert_eq!(
        t.budget_entry(&other_agent, id),
        Some(BudgetEntry {
            allocated: 5_000,
            spent: 1_000,
        })
    );
    // ...and the exhausted agent is untouched by the newcomer spending.
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 3_000,
            spent: 3_000,
        })
    );

    // The SAME agent on a DIFFERENT endpoint is also independent.
    let other_id = client.register_endpoint(&t.seller, &1_000);
    client.record_call(&t.operator, &t.agent, &other_id, &2_000);
    assert_eq!(
        t.budget_entry(&t.agent, other_id),
        Some(BudgetEntry {
            allocated: 2_000,
            spent: 1_000,
        })
    );
}

/// CONVENTIONS.md 1.2 test 3 - "Exceeding the budget panics with
/// `SpendingLimitExceeded`".
#[test]
fn test_record_call_panics_when_budget_exceeded() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    // price 1_000, budget 2_000 => exactly two calls.
    let id = client.register_endpoint(&t.seller, &1_000);

    client.record_call(&t.operator, &t.agent, &id, &2_000);
    // The boundary is `spent + price > allocated`, so landing EXACTLY on
    // allocated must succeed - not merely the strictly-under case.
    client.record_call(&t.operator, &t.agent, &id, &2_000);
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 2_000,
            spent: 2_000,
        })
    );

    // Call three: assert on the ERROR CODE. #[should_panic] would pass on any
    // panic and would not tell SpendingLimitExceeded from EndpointNotFound.
    assert_eq!(
        client.try_record_call(&t.operator, &t.agent, &id, &2_000),
        Err(Ok(Error::SpendingLimitExceeded.into()))
    );

    // A refused call must not consume budget.
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 2_000,
            spent: 2_000,
        })
    );

    // A budget below a single call's price is refused on the FIRST call and
    // freezes nothing - no entry is created, so the agent can come back with a
    // workable budget instead of being locked out for ever.
    let poor_agent = Address::generate(&t.env);
    assert_eq!(
        client.try_record_call(&t.operator, &poor_agent, &id, &999),
        Err(Ok(Error::SpendingLimitExceeded.into()))
    );
    assert_eq!(t.budget_entry(&poor_agent, id), None);
}

/// CONVENTIONS.md 1.2 test 4 - "`settle` splits 1% / 99% correctly, and rounding
/// never favours the user (amount 5_000_000 -> treasury 50_000, seller 4_950_000;
/// also test a non-divisible amount)".
#[test]
#[ignore = "ramp_ledger bodies are still todo!() - logic lands in a later prompt"]
fn test_settle_splits_one_percent_correctly() {
    let t = TestSetup::new();
    let _client = t.client();

    // MUST ASSERT - the exactly-divisible case, which 1.2 states outright:
    // - settle(operator, endpoint_id, amount = 5_000_000) results in
    //       TreasuryTotal           += 50_000
    //       SellerBalances[seller]  += 4_950_000
    // - 50_000 + 4_950_000 == 5_000_000 exactly. No stroop is created or lost.
    // - settle is additive across calls: two settles of 5_000_000 leave the
    //   seller at 9_900_000 and the treasury at 100_000.
    //
    // THE NON-DIVISIBLE CASE IS BLOCKED - 1.2 contradicts itself. Do not guess
    // the assertion here. The two readings disagree for every amount not
    // divisible by 100, e.g. amount = 5_000_099:
    //
    //   formula as written (floor):  treasury = 5_000_099 / 100      = 50_000
    //                                seller   = 5_000_099 - 50_000   = 4_950_099
    //   stated rounding principle:   exact 1% is 50_000.99, so floor leaves the
    //                                remainder with the SELLER - which is what
    //                                "rounding must never favour the seller over
    //                                the treasury" forbids. Ceiling would give
    //                                treasury = 50_001, seller = 4_950_098.
    //
    // Fill this in once Efe rules on which of the two wins, and update 1.2 so
    // the gateway's own arithmetic matches.
}

/// CONVENTIONS.md 1.2 test 5 - "An unauthorised `withdraw` (wrong signer) panics".
#[test]
#[ignore = "ramp_ledger bodies are still todo!() - logic lands in a later prompt"]
fn test_unauthorized_withdraw_panics() {
    let t = TestSetup::new();
    let _client = t.client();

    // MUST ASSERT:
    // - Credit the seller a balance first (register + record_call + settle under
    //   mock_all_auths), so the failure is genuinely about AUTHORISATION and not
    //   about an empty balance.
    // - Do NOT use env.mock_all_auths() for the withdraw itself - it would
    //   authorise everything and the test would silently pass forever. Use
    //   env.mock_auths(&[...]) naming ONLY the attacker, or set_auths.
    // - An attacker address calling withdraw(seller) - i.e. signing as itself
    //   while passing the victim's address - must fail the seller.require_auth().
    // - After the failed attempt, SellerBalances[seller] is UNCHANGED (still the
    //   full credited amount). A failed withdraw must not zero the balance.
    // - The legitimate seller CAN then withdraw, proving the fixture wasn't
    //   simply broken.
}

/// CONVENTIONS.md 1.2 test 6 - "`SellerBalances` is zero after `withdraw`".
#[test]
#[ignore = "ramp_ledger bodies are still todo!() - logic lands in a later prompt"]
fn test_withdraw_zeroes_balance() {
    let t = TestSetup::new();
    let _client = t.client();

    // MUST ASSERT:
    // - Credit a known balance via settle (e.g. 4_950_000 from a 5_000_000 settle).
    // - get_balance(seller) == 4_950_000 BEFORE the withdraw.
    // - withdraw(seller) RETURNS that same 4_950_000 (1.2: "Zeroes
    //   SellerBalances[seller], returns the amount").
    // - get_balance(seller) == 0 AFTER the withdraw.
    // - A SECOND withdraw returns 0 and does not panic, and does not go negative.
    // - The withdraw does NOT touch TreasuryTotal, and does not touch any OTHER
    //   seller's balance.
}

// ---------------------------------------------------------------------------
// Additional tests beyond the six required by CONVENTIONS.md 1.2.
// ---------------------------------------------------------------------------

/// `get_endpoint` on an id that was never registered panics with
/// `EndpointNotFound`. Asserted on the ERROR CODE via the fallible client, not
/// with #[should_panic] - that would pass on any panic at all.
///
/// NOTE for the remaining tests: because CONVENTIONS.md 1.2 fixes the return
/// types as plain values (not `Result<_, Error>`), the generated `try_*` client
/// hands back a `soroban_sdk::Error`, so the enum variant needs `.into()` -
/// `Err(Ok(Error::EndpointNotFound))` alone does not typecheck.
#[test]
fn test_get_endpoint_panics_on_unknown_id() {
    let t = TestSetup::new();
    let client = t.client();

    // Empty contract: nothing has ever been registered.
    assert_eq!(
        client.try_get_endpoint(&1),
        Err(Ok(Error::EndpointNotFound.into()))
    );

    // ...and still after a registration, for an id next to the live one, so the
    // failure is about the LOOKUP and not about empty storage.
    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);
    assert_eq!(client.get_endpoint(&id).price, 1_000);
    assert_eq!(
        client.try_get_endpoint(&(id + 1)),
        Err(Ok(Error::EndpointNotFound.into()))
    );
}

/// `register_endpoint` rejects a non-positive price: a free or negative-priced
/// endpoint has no meaning in a pay-per-call gateway, and a zero price would
/// let an agent burn an unlimited number of calls against a frozen budget.
#[test]
fn test_register_endpoint_rejects_non_positive_price() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    assert_eq!(
        client.try_register_endpoint(&t.seller, &0),
        Err(Ok(Error::InvalidPrice.into()))
    );
    assert_eq!(
        client.try_register_endpoint(&t.seller, &-1),
        Err(Ok(Error::InvalidPrice.into()))
    );

    // A rejected registration does not consume an id.
    assert_eq!(client.register_endpoint(&t.seller, &1), 1);
}

/// `record_call` requires the signature of the address it is handed as
/// `operator` (CONVENTIONS.md 1.2: "operator.require_auth()"). An attacker who
/// signs only for itself cannot push a call through in the operator's name.
///
/// NOTE the limit of what this can prove, and see the SECURITY GAP test below:
/// CONVENTIONS.md 1.2 stores no operator address, so `require_auth()` proves
/// only that whoever was NAMED signed - not that the named address is the
/// gateway's operator keypair.
#[test]
fn test_record_call_requires_the_named_operators_signature() {
    let t = TestSetup::new();
    let client = t.client();
    let attacker = Address::generate(&t.env);

    // Fixture setup under mock_all_auths: a live endpoint and a frozen budget.
    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);
    client.record_call(&t.operator, &t.agent, &id, &3_000);

    // From here ONLY the attacker has a signature. mock_all_auths() must not be
    // left on - it would authorise everything and this test would pass for ever.
    t.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "record_call",
            args: (attacker.clone(), t.agent.clone(), id, 3_000_i128).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    // The attacker names the REAL operator and cannot produce its signature.
    let result = client.try_record_call(&t.operator, &t.agent, &id, &3_000);
    assert!(result.is_err());
    // It fails on AUTHORISATION, not on any of our contract errors - otherwise
    // this test would still pass if the auth check were deleted and the call
    // merely ran out of budget.
    assert_ne!(result, Err(Ok(Error::SpendingLimitExceeded.into())));
    assert_ne!(result, Err(Ok(Error::EndpointNotFound.into())));

    // A refused call changes nothing.
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 3_000,
            spent: 1_000,
        })
    );
}

/// SECURITY GAP, documented deliberately so it fails loudly when it is closed.
///
/// `operator` is a plain parameter and the contract stores no operator address,
/// so `operator.require_auth()` authenticates whoever the caller NAMES. Anyone
/// can therefore call `record_call` naming themselves, and freeze a budget for
/// an arbitrary (agent, endpoint) pair - e.g. a tiny `allocated`, which locks
/// that agent out of that endpoint for good, since the first call is the only
/// one that sets the ceiling.
///
/// Closing this needs an operator address in storage, which CONVENTIONS.md 1.2
/// does not have - a change for Efe to make with the team, not a silent one.
/// When it lands, this test SHOULD start failing: invert it then.
#[test]
fn test_record_call_accepts_any_self_named_operator_todo_gap() {
    let t = TestSetup::new();
    let client = t.client();
    let attacker = Address::generate(&t.env);
    let victim_agent = Address::generate(&t.env);

    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);

    t.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "record_call",
            args: (attacker.clone(), victim_agent.clone(), id, 1_000_i128).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    // Signing only for itself, the attacker freezes the victim's ceiling at a
    // single call. This SUCCEEDS today.
    client.record_call(&attacker, &victim_agent, &id, &1_000);
    assert_eq!(
        t.budget_entry(&victim_agent, id),
        Some(BudgetEntry {
            allocated: 1_000,
            spent: 1_000,
        })
    );

    // ...and the real gateway can no longer record a call for that agent: the
    // budget the agent actually paid for is never read, because an entry exists.
    t.env.mock_all_auths();
    assert_eq!(
        client.try_record_call(&t.operator, &victim_agent, &id, &500_000),
        Err(Ok(Error::SpendingLimitExceeded.into()))
    );
}

/// `record_call` on an id that was never registered panics with
/// `EndpointNotFound` - the second panic CONVENTIONS.md 1.2 names for it - and
/// freezes no budget on the way out.
#[test]
fn test_record_call_panics_on_unknown_endpoint() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    assert_eq!(
        client.try_record_call(&t.operator, &t.agent, &404, &10_000),
        Err(Ok(Error::EndpointNotFound.into()))
    );
    assert_eq!(t.budget_entry(&t.agent, 404), None);
}
