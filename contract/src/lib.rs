#![no_std]
//! `ramp_ledger` — the Ramp402 on-chain ledger.
//!
//! This contract records who spent what and who is owed what. It NEVER holds or
//! transfers tokens; the actual USDC movement happens off-chain from the platform
//! pool account. See docs/CONVENTIONS.md §1.2 — that document is the contract
//! between the three components and the signatures below match it exactly.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

/// Persistent storage keys. TTL must be extended on every write.
/// Value types are fixed by docs/CONVENTIONS.md §1.2.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `u64` — counter, +1 on every `register_endpoint`.
    NextEndpointId,
    /// `Map<u64, EndpointInfo>`.
    Endpoints,
    /// `Map<(Address, u64), BudgetEntry>` — key = (agent, endpoint_id).
    Budgets,
    /// `Map<Address, i128>` — `settle` credits 99% here, `withdraw` zeroes it.
    SellerBalances,
    /// `i128` — cumulative 1% platform fee.
    TreasuryTotal,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointInfo {
    pub seller: Address,
    pub price: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetEntry {
    pub allocated: i128,
    pub spent: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    SpendingLimitExceeded = 1,
    EndpointNotFound = 2,
}

#[contract]
pub struct RampLedger;

// Stubs only — the real logic lands in a later prompt. The `allow` goes away
// with the `todo!()`s.
#[allow(unused_variables)]
#[contractimpl]
impl RampLedger {
    /// Called by the seller with their own `require_auth()`.
    /// The contract generates and returns the new endpoint_id.
    /// event: EndpointRegistered { id, seller, price }
    pub fn register_endpoint(env: Env, seller: Address, upstream_price: i128) -> u64 {
        todo!()
    }

    /// Called by the gateway's single "operator" keypair (`operator.require_auth()`).
    /// The agent does NOT sign. On the FIRST call for an (agent, endpoint_id) pair
    /// the budget parameter is read and frozen.
    ///
    /// panic: SpendingLimitExceeded  if spent + price > allocated
    /// panic: EndpointNotFound       if endpoint_id does not exist
    pub fn record_call(env: Env, operator: Address, agent: Address, endpoint_id: u64, budget: i128) {
        todo!()
    }

    /// Called by the gateway's operator keypair. 1% to treasury, 99% credited to
    /// `SellerBalances[seller]`.
    /// event: FeeSettled { endpoint_id, seller_share, treasury_share }
    pub fn settle(env: Env, operator: Address, endpoint_id: u64, amount: i128) {
        todo!()
    }

    /// Called by the seller with their own `require_auth()`.
    /// Zeroes `SellerBalances[seller]`, returns the amount.
    /// event: Withdrawn { seller, amount }
    pub fn withdraw(env: Env, seller: Address) -> i128 {
        todo!()
    }

    /// View function (no auth) — backs the gateway's `GET /api/balance`.
    pub fn get_balance(env: Env, seller: Address) -> i128 {
        todo!()
    }

    /// View function — backs the gateway's price/limit checks.
    pub fn get_endpoint(env: Env, endpoint_id: u64) -> EndpointInfo {
        todo!()
    }
}

#[cfg(test)]
mod test;
