#![cfg(test)]

use crate::{RampLedger, RampLedgerClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

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
}

// ---------------------------------------------------------------------------
// The six tests required by CONVENTIONS.md 1.2. All `#[ignore]` until the
// contract bodies replace their `todo!()`s.
// ---------------------------------------------------------------------------

/// CONVENTIONS.md 1.2 test 1 - "Calling `register_endpoint` twice returns two
/// different ids (counter increments correctly)".
#[test]
#[ignore = "ramp_ledger bodies are still todo!() - logic lands in a later prompt"]
fn test_register_endpoint_increments_id() {
    let t = TestSetup::new();
    let _client = t.client();

    // MUST ASSERT:
    // - env.mock_all_auths(), since register_endpoint calls seller.require_auth().
    // - Two successive register_endpoint(seller, price) calls return DIFFERENT ids.
    // - The second id == the first id + 1 (the NextEndpointId counter increments
    //   by exactly one; it does not skip or reuse).
    // - The first id is 1. CONVENTIONS.md 1.2 does not state the starting value
    //   outright, but 1.1 says SQLite stores the decimal string form as
    //   ("1", "2", ...), so the counter is 1-based. CONFIRM before relying on it.
    // - Registering from a DIFFERENT seller still advances the same global
    //   counter - the counter is per-contract, not per-seller.
}

/// CONVENTIONS.md 1.2 test 2 - "`record_call` freezes `budget` on the first call;
/// on the second call the parameter is ignored - passing a *larger* budget later
/// must NOT raise the limit". This is the security property named in CLAUDE.md's
/// known traps.
#[test]
#[ignore = "ramp_ledger bodies are still todo!() - logic lands in a later prompt"]
fn test_record_call_freezes_budget_on_first_call() {
    let t = TestSetup::new();
    let _client = t.client();

    // MUST ASSERT:
    // - Register an endpoint with a known price, e.g. price = 1_000 stroops.
    // - FIRST record_call(operator, agent, endpoint_id, budget = 3_000) creates the
    //   BudgetEntry with allocated = 3_000, spent = 1_000 (one call at price).
    // - SECOND record_call for the SAME (agent, endpoint_id) passing a LARGER
    //   budget = 999_999 must leave allocated STILL 3_000 - the parameter is read
    //   once and frozen, never re-read.
    // - Drive the agent to the frozen ceiling: the 4th call (spent would become
    //   4_000 > 3_000) must fail, PROVING the larger budget never took effect.
    // - A DIFFERENT agent on the same endpoint gets its own independent
    //   BudgetEntry - the key is (agent, endpoint_id), not endpoint_id alone.
}

/// CONVENTIONS.md 1.2 test 3 - "Exceeding the budget panics with
/// `SpendingLimitExceeded`".
#[test]
#[ignore = "ramp_ledger bodies are still todo!() - logic lands in a later prompt"]
fn test_record_call_panics_when_budget_exceeded() {
    let t = TestSetup::new();
    let _client = t.client();

    // MUST ASSERT:
    // - Register an endpoint at a known price and record_call with a budget that
    //   allows exactly N calls (e.g. price 1_000, budget 2_000 => 2 calls).
    // - Calls 1..=N succeed.
    // - Call N+1 fails with Error::SpendingLimitExceeded - assert the ERROR CODE,
    //   not merely that it panicked. Use the generated fallible client:
    //       assert_eq!(
    //           client.try_record_call(&operator, &agent, &id, &budget),
    //           Err(Ok(Error::SpendingLimitExceeded))
    //       );
    //   #[should_panic] would pass on ANY panic and would not distinguish
    //   SpendingLimitExceeded from EndpointNotFound. Do not use it here.
    // - The boundary is `spent + price > allocated` (1.2), so spending EXACTLY
    //   up to allocated must SUCCEED. Test the == case, not just the > case.
    // - After the rejection, `spent` is unchanged - a refused call must not
    //   consume budget.
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
