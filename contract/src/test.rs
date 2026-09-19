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
    /// Stored in the contract by the constructor, so it is the one address
    /// those two functions accept.
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
        // The operator is fixed at deploy time, so it has to exist before the
        // contract does - exactly as in the real deployment, where its address
        // is a mandatory constructor argument.
        let operator = Address::generate(&env);
        let contract_id = env.register(RampLedger, (operator.clone(),));
        Self {
            seller: Address::generate(&env),
            agent: Address::generate(&env),
            treasury: Address::generate(&env),
            operator,
            contract_id,
            env,
        }
    }

    pub fn client(&self) -> RampLedgerClient<'_> {
        RampLedgerClient::new(&self.env, &self.contract_id)
    }

    /// The cumulative `TreasuryTotal`, or 0 before the first settlement.
    ///
    /// Like `budget_entry`, this reads persistent storage directly: CONVENTIONS
    /// .md 1.2 gives the treasury no view function, only `get_balance` for the
    /// seller side.
    pub fn treasury_total(&self) -> i128 {
        self.env.as_contract(&self.contract_id, || {
            self.env
                .storage()
                .persistent()
                .get::<DataKey, i128>(&DataKey::TreasuryTotal)
                .unwrap_or(0)
        })
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
///
/// THE NON-DIVISIBLE CASE IS NOW RULED ON: the formula in 1.2 wins, i.e.
/// truncating `amount / 100` for the treasury and `amount - treasury_share` for
/// the seller. That leaves the sub-stroop remainder with the SELLER, so 1.2's
/// prose ("rounding must never favour the payer or the seller over the
/// treasury") is the half that needs amending - see the comment on `settle`.
/// The gateway's own arithmetic must mirror the formula exactly.
#[test]
fn test_settle_splits_one_percent_correctly() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    let id = client.register_endpoint(&t.seller, &1_000);

    // Nothing settled yet.
    assert_eq!(client.get_balance(&t.seller), 0);
    assert_eq!(t.treasury_total(), 0);

    // The exactly-divisible case 1.2 states outright.
    client.settle(&t.operator, &id, &5_000_000);
    assert_eq!(client.get_balance(&t.seller), 4_950_000);
    assert_eq!(t.treasury_total(), 50_000);
    // No stroop created, none lost.
    assert_eq!(4_950_000 + 50_000, 5_000_000);

    // settle is additive across calls.
    client.settle(&t.operator, &id, &5_000_000);
    assert_eq!(client.get_balance(&t.seller), 9_900_000);
    assert_eq!(t.treasury_total(), 100_000);

    // THE NON-DIVISIBLE CASE. 1% of 333 is 3.33 stroops: the treasury takes the
    // truncated 3 and the seller keeps the remaining 330, because the seller's
    // share is computed by subtraction. The invariant that always holds is
    // `seller_share + treasury_share == amount`.
    let before_seller = client.get_balance(&t.seller);
    let before_treasury = t.treasury_total();
    client.settle(&t.operator, &id, &333);
    assert_eq!(client.get_balance(&t.seller) - before_seller, 330);
    assert_eq!(t.treasury_total() - before_treasury, 3);
    assert_eq!(330 + 3, 333);

    // The same identity on the awkward edges, where a second division rather
    // than a subtraction would visibly leak stroops.
    for (amount, treasury, seller) in [
        (1_i128, 0_i128, 1_i128),      // below a stroop of fee: treasury gets nothing
        (99, 0, 99),                   // still under 1% of a stroop
        (100, 1, 99),                  // the first whole stroop of fee
        (199, 1, 198),
        (5_000_099, 50_000, 4_950_099),
    ] {
        let s0 = client.get_balance(&t.seller);
        let tr0 = t.treasury_total();
        client.settle(&t.operator, &id, &amount);
        assert_eq!(
            t.treasury_total() - tr0,
            treasury,
            "treasury share of {}",
            amount
        );
        assert_eq!(
            client.get_balance(&t.seller) - s0,
            seller,
            "seller share of {}",
            amount
        );
        assert_eq!(treasury + seller, amount, "shares of {} must sum", amount);
    }

    // A settlement credits the endpoint OWNER, and touches no other seller.
    let other_seller = Address::generate(&t.env);
    let other_id = client.register_endpoint(&other_seller, &1_000);
    let seller_before = client.get_balance(&t.seller);
    client.settle(&t.operator, &other_id, &5_000_000);
    assert_eq!(client.get_balance(&other_seller), 4_950_000);
    assert_eq!(client.get_balance(&t.seller), seller_before);
}

/// CONVENTIONS.md 1.2 test 5 - "An unauthorised `withdraw` (wrong signer) panics".
#[test]
fn test_unauthorized_withdraw_panics() {
    let t = TestSetup::new();
    let client = t.client();
    let attacker = Address::generate(&t.env);

    // Credit the seller first, so the failure below is genuinely about
    // AUTHORISATION and not about an empty balance.
    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);
    client.record_call(&t.operator, &t.agent, &id, &5_000_000);
    client.settle(&t.operator, &id, &5_000_000);
    assert_eq!(client.get_balance(&t.seller), 4_950_000);

    // ONLY the attacker has a signature from here. mock_all_auths() must not be
    // left on: it would authorise everything and this test would pass for ever.
    t.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "withdraw",
            args: (t.seller.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    // The attacker signs as ITSELF while passing the victim's address. The
    // signature it can produce is not the one `seller.require_auth()` wants.
    let result = client.try_withdraw(&t.seller);
    assert!(result.is_err());
    // It failed on authorisation, not on one of our contract errors.
    assert_ne!(result, Err(Ok(Error::EndpointNotFound.into())));
    assert_ne!(result, Err(Ok(Error::SpendingLimitExceeded.into())));

    // A failed withdraw must not zero the balance.
    assert_eq!(client.get_balance(&t.seller), 4_950_000);

    // The legitimate seller CAN withdraw - proving the fixture was not simply
    // broken and the balance was reachable all along.
    t.env.mock_auths(&[MockAuth {
        address: &t.seller,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "withdraw",
            args: (t.seller.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(client.withdraw(&t.seller), 4_950_000);
    assert_eq!(client.get_balance(&t.seller), 0);
}

/// CONVENTIONS.md 1.2 test 6 - "`SellerBalances` is zero after `withdraw`".
#[test]
fn test_withdraw_zeroes_balance() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    let id = client.register_endpoint(&t.seller, &1_000);
    client.settle(&t.operator, &id, &5_000_000);

    // A second seller and the treasury, to prove the withdraw is surgical.
    let other_seller = Address::generate(&t.env);
    let other_id = client.register_endpoint(&other_seller, &1_000);
    client.settle(&t.operator, &other_id, &1_000_000);
    let treasury_before = t.treasury_total();
    assert_eq!(treasury_before, 60_000); // 50_000 + 10_000

    assert_eq!(client.get_balance(&t.seller), 4_950_000);
    // 1.2: "Zeroes SellerBalances[seller], returns the amount".
    assert_eq!(client.withdraw(&t.seller), 4_950_000);
    assert_eq!(client.get_balance(&t.seller), 0);

    // A SECOND withdraw returns 0, does not panic, and does not go negative.
    // The gateway refuses amounts below the anchor's minimum before it ever
    // gets here (CONVENTIONS.md 1.5); on chain this is simply a no-op.
    assert_eq!(client.withdraw(&t.seller), 0);
    assert_eq!(client.get_balance(&t.seller), 0);

    // The withdraw touched neither the treasury nor the other seller.
    assert_eq!(t.treasury_total(), treasury_before);
    assert_eq!(client.get_balance(&other_seller), 990_000);

    // Settling again after a withdraw starts from zero, not from the old
    // balance - the seller is paid for new calls, not re-paid for old ones.
    client.settle(&t.operator, &id, &2_000_000);
    assert_eq!(client.get_balance(&t.seller), 1_980_000);
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

/// Naming the real operator is not enough: `record_call` also needs that
/// address to have SIGNED. This covers the half of the check that
/// `require_auth()` does; `test_record_call_rejects_a_self_named_operator`
/// covers the identity half.
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

/// The attack that `NotOperator` closes, kept as the regression test for it.
///
/// Before the operator was stored, `operator` was a plain parameter and
/// `require_auth()` authenticated whoever the caller NAMED. Anyone could call
/// `record_call` naming themselves and freeze a budget for an arbitrary
/// (agent, endpoint) pair - a tiny `allocated` locks that agent out of that
/// endpoint for good, because the first call is the only one that sets the
/// ceiling. Now the caller must BE the stored operator.
#[test]
fn test_record_call_rejects_a_self_named_operator() {
    let t = TestSetup::new();
    let client = t.client();
    let attacker = Address::generate(&t.env);
    let victim_agent = Address::generate(&t.env);

    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);

    // The attacker has a perfectly valid signature - for ITSELF.
    t.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "record_call",
            args: (attacker.clone(), victim_agent.clone(), id, 1_000_i128).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    assert_eq!(
        client.try_record_call(&attacker, &victim_agent, &id, &1_000),
        Err(Ok(Error::NotOperator.into()))
    );

    // Nothing was frozen, so the victim's real budget is still the one that
    // will be read on its first genuine call.
    assert_eq!(t.budget_entry(&victim_agent, id), None);
    t.env.mock_all_auths();
    client.record_call(&t.operator, &victim_agent, &id, &500_000);
    assert_eq!(
        t.budget_entry(&victim_agent, id),
        Some(BudgetEntry {
            allocated: 500_000,
            spent: 1_000,
        })
    );
}

/// The same attack against `settle`, where it was worth real money: a
/// self-named operator could credit any seller any balance, and the gateway
/// pays out against the chain because the chain is the source of truth.
#[test]
fn test_settle_rejects_a_self_named_operator() {
    let t = TestSetup::new();
    let client = t.client();
    let attacker = Address::generate(&t.env);

    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);

    t.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "settle",
            args: (attacker.clone(), id, 900_000_000_i128).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    assert_eq!(
        client.try_settle(&attacker, &id, &900_000_000),
        Err(Ok(Error::NotOperator.into()))
    );
    assert_eq!(client.get_balance(&t.seller), 0);
    assert_eq!(t.treasury_total(), 0);
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

/// `get_balance` is a view with no auth, and answers 0 for a seller that has
/// never been settled to - it must not panic the way `get_endpoint` does.
#[test]
fn test_get_balance_is_zero_for_unknown_seller() {
    let t = TestSetup::new();
    let client = t.client();
    let stranger = Address::generate(&t.env);

    // Empty contract, and no mock_all_auths(): a view takes no signature.
    assert_eq!(client.get_balance(&stranger), 0);

    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);
    client.settle(&t.operator, &id, &5_000_000);

    // Someone else having a balance does not give the stranger one.
    assert_eq!(client.get_balance(&stranger), 0);
    assert_eq!(client.get_balance(&t.seller), 4_950_000);
}

/// `settle` on an id that was never registered panics with `EndpointNotFound`:
/// there is no seller to credit, so it must not silently do nothing either.
#[test]
fn test_settle_panics_on_unknown_endpoint() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    assert_eq!(
        client.try_settle(&t.operator, &404, &5_000_000),
        Err(Ok(Error::EndpointNotFound.into()))
    );
    assert_eq!(t.treasury_total(), 0);
}

/// Naming the real operator is not enough for `settle` either: that address
/// must have signed. The identity half is covered by
/// `test_settle_rejects_a_self_named_operator`.
#[test]
fn test_settle_requires_the_named_operators_signature() {
    let t = TestSetup::new();
    let client = t.client();
    let attacker = Address::generate(&t.env);

    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);

    t.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "settle",
            args: (attacker.clone(), id, 5_000_000_i128).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_settle(&t.operator, &id, &5_000_000);
    assert!(result.is_err());
    assert_ne!(result, Err(Ok(Error::EndpointNotFound.into())));

    // Nothing was credited.
    assert_eq!(client.get_balance(&t.seller), 0);
    assert_eq!(t.treasury_total(), 0);
}

/// `withdraw` on a seller who has never been settled to returns 0 rather than
/// panicking, and does not create a balance entry on the way out.
///
/// The zero case is deliberate, and was ruled on rather than assumed: it keeps
/// a retried `/api/withdraw/submit` a safe no-op instead of a transaction
/// failure, and the too-small-withdrawal check belongs to the gateway, which
/// must refuse anything under the anchor's 1 USDC minimum with a readable
/// message (CONVENTIONS.md 1.5) - a check that covers zero already.
#[test]
fn test_withdraw_of_nothing_is_a_no_op() {
    let t = TestSetup::new();
    let client = t.client();
    let stranger = Address::generate(&t.env);
    t.env.mock_all_auths();

    assert_eq!(client.withdraw(&stranger), 0);
    assert_eq!(client.get_balance(&stranger), 0);
    // Repeating it stays a no-op and never goes negative.
    assert_eq!(client.withdraw(&stranger), 0);
    assert_eq!(client.get_balance(&stranger), 0);
}

/// The whole demo path in one test: register, three paid calls against a frozen
/// budget, settle each one, withdraw the lot. Guards the arithmetic END TO END,
/// where a per-function test cannot see a mismatch between the pieces.
#[test]
fn test_full_lifecycle_register_call_settle_withdraw() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    let price = 1_000_000_i128; // 0.1 USDC per call
    let id = client.register_endpoint(&t.seller, &price);

    // Three calls against a budget that allows exactly three.
    for _ in 0..3 {
        client.record_call(&t.operator, &t.agent, &id, &(price * 3));
        client.settle(&t.operator, &id, &price);
    }

    // The fourth is refused: the budget is spent.
    assert_eq!(
        client.try_record_call(&t.operator, &t.agent, &id, &(price * 3)),
        Err(Ok(Error::SpendingLimitExceeded.into()))
    );

    // 3 x 1_000_000 = 3_000_000 settled: 1% treasury, 99% seller.
    assert_eq!(t.treasury_total(), 30_000);
    assert_eq!(client.get_balance(&t.seller), 2_970_000);
    assert_eq!(30_000 + 2_970_000, price * 3);

    assert_eq!(client.withdraw(&t.seller), 2_970_000);
    assert_eq!(client.get_balance(&t.seller), 0);
    // The treasury's cut is not withdrawable by the seller and stays put.
    assert_eq!(t.treasury_total(), 30_000);
}

// ---------------------------------------------------------------------------
// Operator identity, rotation and amount validation.
// ---------------------------------------------------------------------------

/// The constructor stores the operator, and `get_operator` reads it back
/// without auth - the check `scripts/preflight.ts` can make before a demo.
#[test]
fn test_constructor_stores_the_operator() {
    let t = TestSetup::new();
    let client = t.client();

    // No mock_all_auths(): a view needs no signature.
    assert_eq!(client.get_operator(), t.operator);
}

/// `set_operator` hands the role over: the new operator works, the old one
/// stops working, and the ledger written under the old one is untouched.
#[test]
fn test_set_operator_rotates_the_role() {
    let t = TestSetup::new();
    let client = t.client();
    let new_operator = Address::generate(&t.env);

    t.env.mock_all_auths();
    let id = client.register_endpoint(&t.seller, &1_000);
    client.record_call(&t.operator, &t.agent, &id, &10_000);
    client.settle(&t.operator, &id, &5_000_000);

    client.set_operator(&new_operator);
    assert_eq!(client.get_operator(), new_operator);

    // The new operator can do the job...
    client.record_call(&new_operator, &t.agent, &id, &10_000);
    client.settle(&new_operator, &id, &5_000_000);
    assert_eq!(client.get_balance(&t.seller), 9_900_000);
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 10_000,
            spent: 2_000,
        })
    );

    // ...and the OLD operator cannot, even though it is still a real keypair
    // with a valid signature. mock_all_auths() is still on, so this proves the
    // identity check and not a missing signature.
    assert_eq!(
        client.try_record_call(&t.operator, &t.agent, &id, &10_000),
        Err(Ok(Error::NotOperator.into()))
    );
    assert_eq!(
        client.try_settle(&t.operator, &id, &5_000_000),
        Err(Ok(Error::NotOperator.into()))
    );
}

/// Only the CURRENT operator may rotate the role - not the deployer, not the
/// seller, not an attacker holding a valid signature of its own.
#[test]
fn test_set_operator_requires_the_current_operator() {
    let t = TestSetup::new();
    let client = t.client();
    let attacker = Address::generate(&t.env);

    // ONLY the attacker has a signature, and it is asking to become operator.
    t.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "set_operator",
            args: (attacker.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_set_operator(&attacker);
    assert!(result.is_err());
    assert_eq!(client.get_operator(), t.operator);

    // The seller cannot take the role either.
    t.env.mock_auths(&[MockAuth {
        address: &t.seller,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "set_operator",
            args: (t.seller.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_operator(&t.seller).is_err());
    assert_eq!(client.get_operator(), t.operator);
}

/// Rotation is chainable: B can hand on to C once A has handed on to B. A must
/// not be able to take the role back.
#[test]
fn test_set_operator_chains_and_does_not_look_back() {
    let t = TestSetup::new();
    let client = t.client();
    let second = Address::generate(&t.env);
    let third = Address::generate(&t.env);
    t.env.mock_all_auths();

    client.set_operator(&second);
    client.set_operator(&third);
    assert_eq!(client.get_operator(), third);

    // The first operator is just another address now. mock_all_auths() cannot
    // help it: the contract is comparing addresses, not checking signatures.
    let id = client.register_endpoint(&t.seller, &1_000);
    assert_eq!(
        client.try_record_call(&t.operator, &t.agent, &id, &10_000),
        Err(Ok(Error::NotOperator.into()))
    );
    client.record_call(&third, &t.agent, &id, &10_000);
}

/// `settle` refuses a zero or negative amount. A negative one would DEBIT the
/// seller - with a self-named operator that was a way to bury a balance below
/// zero, and it is nonsense from the gateway in any case.
#[test]
fn test_settle_rejects_zero_and_negative_amounts() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    let id = client.register_endpoint(&t.seller, &1_000);
    client.settle(&t.operator, &id, &5_000_000);
    let balance = client.get_balance(&t.seller);

    for bad in [0_i128, -1, -5_000_000] {
        assert_eq!(
            client.try_settle(&t.operator, &id, &bad),
            Err(Ok(Error::InvalidAmount.into())),
            "settle({}) must be refused",
            bad
        );
    }

    // Nothing moved in either direction.
    assert_eq!(client.get_balance(&t.seller), balance);
    assert_eq!(t.treasury_total(), 50_000);

    // The smallest meaningful settlement is still allowed: 1 stroop, of which
    // the treasury's truncated 1% is nothing at all.
    client.settle(&t.operator, &id, &1);
    assert_eq!(client.get_balance(&t.seller), balance + 1);
    assert_eq!(t.treasury_total(), 50_000);
}

/// A FIRST `record_call` refuses a zero or negative budget, because that is the
/// value being frozen. Later calls still ignore the parameter completely - the
/// validation must not become a back door that re-reads it.
#[test]
fn test_record_call_rejects_non_positive_budget_on_the_first_call_only() {
    let t = TestSetup::new();
    let client = t.client();
    t.env.mock_all_auths();

    let id = client.register_endpoint(&t.seller, &1_000);

    for bad in [0_i128, -1, -10_000] {
        assert_eq!(
            client.try_record_call(&t.operator, &t.agent, &id, &bad),
            Err(Ok(Error::InvalidAmount.into())),
            "first record_call with budget {} must be refused",
            bad
        );
        assert_eq!(t.budget_entry(&t.agent, id), None);
    }

    // A real first call freezes a real budget: 4_000 at 1_000 a call is room
    // for exactly the four calls this test makes.
    client.record_call(&t.operator, &t.agent, &id, &4_000);

    // From here the parameter is ignored, INCLUDING these values: §1.3 lets the
    // gateway drop the X-Agent-Budget header after the first call, so a later
    // call may legitimately carry 0. Refusing it here would break the proxy on
    // its second request.
    for ignored in [0_i128, -1, 999_999] {
        client.record_call(&t.operator, &t.agent, &id, &ignored);
    }
    assert_eq!(
        t.budget_entry(&t.agent, id),
        Some(BudgetEntry {
            allocated: 4_000,
            spent: 4_000,
        })
    );
    // 999_999 was ignored like the rest: the ceiling is still 4_000.
    assert_eq!(
        client.try_record_call(&t.operator, &t.agent, &id, &999_999),
        Err(Ok(Error::SpendingLimitExceeded.into()))
    );
}
