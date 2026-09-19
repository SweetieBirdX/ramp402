#![no_std]
//! `ramp_ledger` — the Ramp402 on-chain ledger.
//!
//! This contract records who spent what and who is owed what. It NEVER holds or
//! transfers tokens; the actual USDC movement happens off-chain from the platform
//! pool account. See docs/CONVENTIONS.md §1.2 — that document is the contract
//! between the three components and the signatures below match it exactly.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Map,
};

/// Ledgers in roughly 24h at the 5s close time — the unit every TTL below is
/// expressed in.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Every persistent write bumps the entry's TTL back up to ~30 days...
const PERSISTENT_BUMP_LEDGERS: u32 = 30 * DAY_IN_LEDGERS;
/// ...and it is bumped whenever it has less than ~23 days left, so a demo that
/// runs for a weekend can never watch its storage expire mid-call. Generous on
/// purpose: expired persistent storage is unrecoverable in the moment.
const PERSISTENT_THRESHOLD_LEDGERS: u32 = PERSISTENT_BUMP_LEDGERS - 7 * DAY_IN_LEDGERS;

/// The first id handed out by `register_endpoint`. CONVENTIONS.md §1.1 shows the
/// SQLite string forms as ("1", "2", …), so the counter is 1-based.
const FIRST_ENDPOINT_ID: u64 = 1;

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

/// `EndpointRegistered { id, seller, price }` — CONVENTIONS.md §1.2.
/// `id` is a topic so the gateway can filter the event stream by endpoint.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointRegistered {
    #[topic]
    pub id: u64,
    pub seller: Address,
    pub price: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    SpendingLimitExceeded = 1,
    EndpointNotFound = 2,
    /// `register_endpoint` was called with `upstream_price <= 0`. A free or
    /// negative-priced endpoint has no meaning in a pay-per-call gateway.
    /// NOTE: not yet listed in CONVENTIONS.md §1.2 — flagged to the team.
    InvalidPrice = 3,
}

/// Bump a persistent entry's TTL. Called after EVERY persistent write
/// (checklist §5b). The entry must already exist, so always `set` first.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_THRESHOLD_LEDGERS,
        PERSISTENT_BUMP_LEDGERS,
    );
}

/// Read the `Endpoints` map, or an empty one before the first registration.
fn endpoints_map(env: &Env) -> Map<u64, EndpointInfo> {
    env.storage()
        .persistent()
        .get(&DataKey::Endpoints)
        .unwrap_or_else(|| Map::new(env))
}

/// Read the `Budgets` map, or an empty one before the first recorded call.
/// Key is the tuple `(agent, endpoint_id)` — CONVENTIONS.md §1.2. There are no
/// sessions: this pair IS the identity of a budget.
fn budgets_map(env: &Env) -> Map<(Address, u64), BudgetEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::Budgets)
        .unwrap_or_else(|| Map::new(env))
}

/// The stored endpoint, or `EndpointNotFound`.
fn endpoint_or_panic(env: &Env, endpoint_id: u64) -> EndpointInfo {
    match endpoints_map(env).get(endpoint_id) {
        Some(info) => info,
        None => panic_with_error!(env, Error::EndpointNotFound),
    }
}

#[contract]
pub struct RampLedger;

// `register_endpoint` and `get_endpoint` are live; the rest are still stubs and
// the real logic lands in a later prompt. The `allow` goes away with the last
// `todo!()`.
#[allow(unused_variables)]
#[contractimpl]
impl RampLedger {
    /// Called by the seller with their own `require_auth()`.
    /// The contract generates and returns the new endpoint_id.
    /// event: EndpointRegistered { id, seller, price }
    ///
    /// panic: InvalidPrice  if upstream_price <= 0
    pub fn register_endpoint(env: Env, seller: Address, upstream_price: i128) -> u64 {
        seller.require_auth();

        if upstream_price <= 0 {
            panic_with_error!(&env, Error::InvalidPrice);
        }

        // The counter is global to the contract, not per-seller: two sellers
        // registering in turn still get two different ids.
        let id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::NextEndpointId)
            .unwrap_or(FIRST_ENDPOINT_ID);
        env.storage()
            .persistent()
            .set(&DataKey::NextEndpointId, &(id + 1));
        extend_persistent_ttl(&env, &DataKey::NextEndpointId);

        let mut endpoints = endpoints_map(&env);
        endpoints.set(
            id,
            EndpointInfo {
                seller: seller.clone(),
                price: upstream_price,
            },
        );
        env.storage()
            .persistent()
            .set(&DataKey::Endpoints, &endpoints);
        extend_persistent_ttl(&env, &DataKey::Endpoints);

        EndpointRegistered {
            id,
            seller,
            price: upstream_price,
        }
        .publish(&env);

        id
    }

    /// Called by the gateway's single "operator" keypair (`operator.require_auth()`).
    /// The agent does NOT sign. On the FIRST call for an (agent, endpoint_id) pair
    /// the budget parameter is read and frozen.
    ///
    /// panic: SpendingLimitExceeded  if spent + price > allocated
    /// panic: EndpointNotFound       if endpoint_id does not exist
    pub fn record_call(env: Env, operator: Address, agent: Address, endpoint_id: u64, budget: i128) {
        operator.require_auth();

        let endpoint = endpoint_or_panic(&env, endpoint_id);

        let mut budgets = budgets_map(&env);
        let key = (agent, endpoint_id);

        // THE security property (CLAUDE.md known traps): `budget` is read ONLY
        // when there is no entry yet. Once an entry exists the parameter is not
        // looked at again, so a later, larger budget cannot raise the ceiling.
        let mut entry = budgets.get(key.clone()).unwrap_or(BudgetEntry {
            allocated: budget,
            spent: 0,
        });

        if entry.spent + endpoint.price > entry.allocated {
            panic_with_error!(&env, Error::SpendingLimitExceeded);
        }

        entry.spent += endpoint.price;
        budgets.set(key, entry);

        env.storage().persistent().set(&DataKey::Budgets, &budgets);
        extend_persistent_ttl(&env, &DataKey::Budgets);
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
    ///
    /// panic: EndpointNotFound  if endpoint_id does not exist
    pub fn get_endpoint(env: Env, endpoint_id: u64) -> EndpointInfo {
        endpoint_or_panic(&env, endpoint_id)
    }
}

#[cfg(test)]
mod test;
