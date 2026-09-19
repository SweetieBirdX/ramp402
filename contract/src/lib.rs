#![no_std]
//! `ramp_ledger` — the Ramp402 on-chain ledger.
//!
//! This contract records who spent what and who is owed what. It NEVER holds or
//! transfers tokens; the actual USDC movement happens off-chain from the platform
//! pool account. See docs/CONVENTIONS.md §1.2 — that document is the contract
//! between the three components and the signatures below match it exactly.
//!
//! # Units
//!
//! Every amount in this contract is an integer count of **stroops**
//! (1 USDC = 10_000_000 stroops). There are no decimals anywhere on chain;
//! conversion for display happens in the frontend alone.
//!
//! # Authorisation
//!
//! | Function | Signer |
//! | --- | --- |
//! | [`RampLedger::register_endpoint`] | the seller |
//! | [`RampLedger::record_call`] | the gateway's operator keypair |
//! | [`RampLedger::settle`] | the gateway's operator keypair |
//! | [`RampLedger::withdraw`] | the seller, for their own balance only |
//! | [`RampLedger::set_operator`] | the current operator |
//! | [`RampLedger::get_balance`], [`RampLedger::get_endpoint`], [`RampLedger::get_operator`] | none, views |
//!
//! "The operator" is one specific address, stored at deploy time by
//! [`RampLedger::__constructor`] and checked on every privileged call. A
//! signature alone is not enough: `record_call` and `settle` verify that the
//! caller IS the stored operator, so naming yourself as operator and signing
//! for yourself does not work.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Map,
};

/// Ledgers in roughly 24h at the 5s close time — the unit every TTL below is
/// expressed in.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Every write bumps the entry's TTL back up to ~30 days...
const STORAGE_BUMP_LEDGERS: u32 = 30 * DAY_IN_LEDGERS;
/// ...and it is bumped whenever it has less than ~23 days left, so a demo that
/// runs for a weekend can never watch its storage expire mid-call. Generous on
/// purpose: expired storage is unrecoverable in the moment.
const STORAGE_THRESHOLD_LEDGERS: u32 = STORAGE_BUMP_LEDGERS - 7 * DAY_IN_LEDGERS;

/// The first id handed out by `register_endpoint`. CONVENTIONS.md §1.1 shows the
/// SQLite string forms as ("1", "2", …), so the counter is 1-based.
const FIRST_ENDPOINT_ID: u64 = 1;

/// Storage keys. TTL must be extended on every write.
///
/// Everything here is PERSISTENT storage, with one exception: [`DataKey::Operator`]
/// lives in INSTANCE storage. It is a single address read on every privileged
/// call, so it belongs with the contract instance — it is loaded with the
/// contract, and its TTL rides along with the instance rather than being a
/// separate entry that could expire on its own.
///
/// Value types are fixed by docs/CONVENTIONS.md §1.2.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `Address` — INSTANCE storage. The one keypair allowed to call
    /// `record_call` and `settle`. Set by the constructor, rotated by
    /// `set_operator`.
    Operator,
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

/// `FeeSettled { endpoint_id, seller_share, treasury_share }` — CONVENTIONS.md
/// §1.2. `endpoint_id` is a topic so the gateway can filter by endpoint.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeSettled {
    #[topic]
    pub endpoint_id: u64,
    pub seller_share: i128,
    pub treasury_share: i128,
}

/// `Withdrawn { seller, amount }` — CONVENTIONS.md §1.2. `seller` is a topic so
/// the gateway can follow one seller's withdrawals without scanning the stream.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub seller: Address,
    pub amount: i128,
}

/// `OperatorChanged { previous, current }` — published by
/// [`RampLedger::set_operator`]. Both addresses are topics so a rotation can be
/// found from either side.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorChanged {
    #[topic]
    pub previous: Address,
    #[topic]
    pub current: Address,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    SpendingLimitExceeded = 1,
    EndpointNotFound = 2,
    /// `register_endpoint` was called with `upstream_price <= 0`. A free or
    /// negative-priced endpoint has no meaning in a pay-per-call gateway.
    InvalidPrice = 3,
    /// An accounting amount was zero or negative: `settle`'s `amount`, or the
    /// `budget` frozen by an agent's first `record_call`. Money only ever moves
    /// forward through this ledger.
    InvalidAmount = 4,
    /// The caller is not the stored operator. The signature may well be valid —
    /// it just belongs to the wrong address. Also raised if no operator is
    /// stored at all, which can only mean the contract predates the constructor
    /// and the wrong `CONTRACT_ID` is in use.
    NotOperator = 5,
}

/// Bump a persistent entry's TTL. Called after EVERY persistent write
/// (checklist §5b). The entry must already exist, so always `set` first.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, STORAGE_THRESHOLD_LEDGERS, STORAGE_BUMP_LEDGERS);
}

/// Bump the contract instance's TTL, which covers [`DataKey::Operator`] and the
/// deployed wasm itself. An archived instance takes the whole contract offline,
/// so this is bumped on every privileged call, not only when the operator
/// changes.
fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(STORAGE_THRESHOLD_LEDGERS, STORAGE_BUMP_LEDGERS);
}

/// The stored operator address.
///
/// # Panics
///
/// [`Error::NotOperator`] if none is stored. Unreachable on a contract deployed
/// with its constructor — which is every deployment, since the constructor
/// argument is mandatory — so in practice this means the `CONTRACT_ID` points at
/// an older build.
fn stored_operator(env: &Env) -> Address {
    match env.storage().instance().get(&DataKey::Operator) {
        Some(operator) => operator,
        None => panic_with_error!(env, Error::NotOperator),
    }
}

/// Assert that `caller` IS the stored operator AND has signed.
///
/// Both halves matter. `require_auth()` alone proves only that whoever was named
/// signed for themselves, which any address can do; the equality check is what
/// ties the privilege to the gateway's one keypair.
///
/// # Panics
///
/// - [`Error::NotOperator`] if `caller` is not the stored operator.
/// - An authorisation error if it is, but has not signed.
fn require_operator(env: &Env, caller: &Address) {
    if *caller != stored_operator(env) {
        panic_with_error!(env, Error::NotOperator);
    }
    caller.require_auth();
    extend_instance_ttl(env);
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

/// Read the `SellerBalances` map, or an empty one before the first settlement.
fn seller_balances_map(env: &Env) -> Map<Address, i128> {
    env.storage()
        .persistent()
        .get(&DataKey::SellerBalances)
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

#[contractimpl]
impl RampLedger {
    /// Fix the operator identity at deploy time.
    ///
    /// Runs once, inside the deployment transaction, and cannot be called
    /// again. The argument is mandatory, so no deployment can exist without an
    /// operator.
    ///
    /// # Parameters
    ///
    /// - `operator` — the public key of the gateway's `OPERATOR_SECRET_KEY`.
    ///   This is the ONLY address that will be able to call
    ///   [`RampLedger::record_call`] and [`RampLedger::settle`].
    ///
    /// # Authorisation
    ///
    /// None: the deployer chooses the operator, and the operator itself does
    /// not have to sign the deployment. Whoever deploys decides who keeps the
    /// books, and from that moment only that keypair can write them.
    ///
    /// ```sh
    /// stellar contract deploy --wasm ramp_ledger.wasm \
    ///   --source-account ramp402-deployer --network testnet \
    ///   -- --operator G...
    /// ```
    pub fn __constructor(env: Env, operator: Address) {
        env.storage().instance().set(&DataKey::Operator, &operator);
        extend_instance_ttl(&env);
    }

    /// Hand the operator role to a different keypair.
    ///
    /// This exists so that a rotated or regenerated `OPERATOR_SECRET_KEY` does
    /// not force a redeployment. A redeploy would mint a new `CONTRACT_ID`,
    /// which then has to be re-wired into the gateway and the frontend — the
    /// one failure mode this project can least afford mid-demo.
    ///
    /// # Parameters
    ///
    /// - `new_operator` — the address that takes over. **Not verified to be
    ///   controllable**: it is not asked to sign, so an address typed wrong here
    ///   locks the role away and only a redeployment recovers it. Read it back
    ///   with [`RampLedger::get_operator`] immediately afterwards.
    ///
    /// # Authorisation
    ///
    /// The CURRENT stored operator must sign. Nobody else can rotate the role,
    /// including the original deployer.
    ///
    /// # Panics
    ///
    /// - [`Error::NotOperator`] if the current operator has not signed.
    ///
    /// # Events
    ///
    /// [`OperatorChanged`] `{ previous, current }`.
    pub fn set_operator(env: Env, new_operator: Address) {
        let previous = stored_operator(&env);
        previous.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Operator, &new_operator);
        extend_instance_ttl(&env);

        OperatorChanged {
            previous,
            current: new_operator,
        }
        .publish(&env);
    }

    /// The address currently allowed to call [`RampLedger::record_call`] and
    /// [`RampLedger::settle`].
    ///
    /// Worth calling from `scripts/preflight.ts` before a demo: if this does not
    /// equal the public key of the gateway's `OPERATOR_SECRET_KEY`, every paid
    /// call will fail with [`Error::NotOperator`], and knowing that in advance
    /// costs one RPC call instead of a debugging session.
    ///
    /// # Authorisation
    ///
    /// None — a view.
    ///
    /// # Panics
    ///
    /// - [`Error::NotOperator`] if no operator is stored, which means the
    ///   `CONTRACT_ID` points at a build older than the constructor.
    pub fn get_operator(env: Env) -> Address {
        stored_operator(&env)
    }

    /// Register a paid API endpoint and return the `endpoint_id` the ledger
    /// assigns to it.
    ///
    /// The id comes from a contract-side counter, never from the caller: it is
    /// the on-chain identity of the endpoint, and the gateway stores its
    /// decimal string form in SQLite. The gateway's own `proxy_slug` is a
    /// separate, URL-facing identifier and is not known here.
    ///
    /// # Parameters
    ///
    /// - `seller` — the account that owns the endpoint and will be credited by
    ///   [`RampLedger::settle`]. Must sign this call.
    /// - `upstream_price` — the price of ONE call, in stroops. Charged in full
    ///   on every [`RampLedger::record_call`], so it must be positive.
    ///
    /// # Authorisation
    ///
    /// `seller.require_auth()` — endpoint ownership stays with the seller, and
    /// nobody can register an endpoint in someone else's name.
    ///
    /// # Panics
    ///
    /// - [`Error::InvalidPrice`] if `upstream_price <= 0`. A free or
    ///   negative-priced endpoint has no meaning in a pay-per-call gateway, and
    ///   a zero price would let an agent make unlimited calls against a budget.
    ///
    /// # Events
    ///
    /// [`EndpointRegistered`] `{ id, seller, price }`.
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

    /// Record one paid call by `agent` against `endpoint_id`, charging the
    /// endpoint's price against that agent's budget.
    ///
    /// **There are no sessions.** A budget belongs to an `(agent, endpoint_id)`
    /// pair and is defined by that pair's FIRST call. The `budget` parameter is
    /// read exactly once, when no entry exists yet; from then on it is ignored
    /// entirely, so a later call passing a larger budget cannot raise the
    /// ceiling. That is a security property, not an optimisation, and there is
    /// a test guarding it.
    ///
    /// # Parameters
    ///
    /// - `operator` — the gateway's single operator keypair. Must sign.
    /// - `agent` — the paying agent. Does NOT sign: an autonomous agent cannot
    ///   be asked for a second signature on every request.
    /// - `endpoint_id` — the endpoint being called, as returned by
    ///   [`RampLedger::register_endpoint`].
    /// - `budget` — the agent's total spending ceiling for this endpoint, in
    ///   stroops. Read on the first call for the pair and frozen; ignored on
    ///   every later call.
    ///
    /// # Authorisation
    ///
    /// `operator` must BE the stored operator and must sign. A signature from
    /// some other address, even a valid one, is refused.
    ///
    /// # Panics
    ///
    /// - [`Error::NotOperator`] if the caller is not the stored operator.
    /// - [`Error::EndpointNotFound`] if `endpoint_id` was never registered.
    /// - [`Error::InvalidAmount`] if the pair's FIRST call passes
    ///   `budget <= 0`. Validated only on the first call: on later calls the
    ///   parameter is ignored entirely, including when the gateway has no
    ///   `X-Agent-Budget` header to forward and sends 0.
    /// - [`Error::SpendingLimitExceeded`] if `spent + price > allocated`.
    ///   Spending exactly up to `allocated` is allowed. A refused call consumes
    ///   no budget, and if it was the pair's first call it freezes nothing, so
    ///   the agent may come back with a workable budget.
    pub fn record_call(env: Env, operator: Address, agent: Address, endpoint_id: u64, budget: i128) {
        require_operator(&env, &operator);

        let endpoint = endpoint_or_panic(&env, endpoint_id);

        let mut budgets = budgets_map(&env);
        let key = (agent, endpoint_id);

        // THE security property (CLAUDE.md known traps): `budget` is read ONLY
        // when there is no entry yet. Once an entry exists the parameter is not
        // looked at again, so a later, larger budget cannot raise the ceiling.
        //
        // The validation below sits inside the same branch for exactly that
        // reason. Checking `budget` on every call would break the rule the
        // branch exists to enforce: §1.3 lets the gateway ignore the header
        // after the first call, so a later call may legitimately carry 0.
        let mut entry = budgets.get(key.clone()).unwrap_or_else(|| {
            if budget <= 0 {
                panic_with_error!(&env, Error::InvalidAmount);
            }
            BudgetEntry {
                allocated: budget,
                spent: 0,
            }
        });

        if entry.spent + endpoint.price > entry.allocated {
            panic_with_error!(&env, Error::SpendingLimitExceeded);
        }

        entry.spent += endpoint.price;
        budgets.set(key, entry);

        env.storage().persistent().set(&DataKey::Budgets, &budgets);
        extend_persistent_ttl(&env, &DataKey::Budgets);
    }

    /// Split a settled amount between the platform treasury (1%) and the
    /// endpoint's seller (99%), crediting the seller's withdrawable balance.
    ///
    /// Called after the upstream API has answered successfully. A call whose
    /// upstream failed is recorded by the gateway as `upstream_failed` and is
    /// never settled — payment taken but upstream failed is a real state, and
    /// the seller is not paid for it.
    ///
    /// # Parameters
    ///
    /// - `operator` — the gateway's operator keypair. Must sign.
    /// - `endpoint_id` — identifies the endpoint, and through it the seller to
    ///   credit. The seller is read from the ledger, never passed in.
    /// - `amount` — the amount to split, in stroops.
    ///
    /// # Rounding
    ///
    /// Integer arithmetic only: `treasury_share = amount / 100` (truncating),
    /// then `seller_share = amount - treasury_share`. Because the second share
    /// is a subtraction rather than a second division, the two always sum back
    /// to `amount` exactly — settlement can neither create nor lose a stroop.
    /// See the comment on the arithmetic below for the sub-stroop remainder.
    ///
    /// # Authorisation
    ///
    /// `operator` must BE the stored operator and must sign. This is the
    /// function that decides what sellers are owed, so the identity check is
    /// what stands between the ledger and an invented balance.
    ///
    /// # Panics
    ///
    /// - [`Error::NotOperator`] if the caller is not the stored operator.
    /// - [`Error::EndpointNotFound`] if `endpoint_id` was never registered.
    /// - [`Error::InvalidAmount`] if `amount <= 0`. A negative amount would
    ///   DEBIT the seller, and nothing in this ledger is allowed to run
    ///   backwards; zero would emit an event for a settlement that never
    ///   happened.
    ///
    /// # Events
    ///
    /// [`FeeSettled`] `{ endpoint_id, seller_share, treasury_share }`.
    pub fn settle(env: Env, operator: Address, endpoint_id: u64, amount: i128) {
        require_operator(&env, &operator);

        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let endpoint = endpoint_or_panic(&env, endpoint_id);

        // ROUNDING (CONVENTIONS.md §1.2) — integer arithmetic only, no floats
        // anywhere near money. The treasury's 1% is an integer division that
        // truncates, and the seller's share is then derived by SUBTRACTION
        // rather than by a second division. Subtraction is the part that
        // matters: it makes `seller_share + treasury_share == amount` an
        // identity for every input, so settlement can neither create nor lose a
        // stroop no matter what the remainder is.
        //
        // Worked examples:
        //   amount 5_000_000 -> treasury     50_000, seller 4_950_000 (exact)
        //   amount       333 -> treasury          3, seller       330
        //
        // The sub-stroop remainder (0.33 of a stroop in the 333 case) stays
        // with the SELLER. §1.2's prose says rounding must never favour the
        // seller over the treasury, which is not literally true of the formula
        // §1.2 itself specifies; the formula is what the gateway mirrors, and
        // docs/CONVENTIONS-proposal.md carries the correction to the sentence.
        // Ceiling division, `(amount + 99) / 100`, is the one-line alternative
        // if the team decides the prose wins instead.
        let treasury_share = amount / 100;
        let seller_share = amount - treasury_share;

        let mut balances = seller_balances_map(&env);
        let credited = balances.get(endpoint.seller.clone()).unwrap_or(0) + seller_share;
        balances.set(endpoint.seller, credited);
        env.storage()
            .persistent()
            .set(&DataKey::SellerBalances, &balances);
        extend_persistent_ttl(&env, &DataKey::SellerBalances);

        let treasury_total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TreasuryTotal)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::TreasuryTotal, &(treasury_total + treasury_share));
        extend_persistent_ttl(&env, &DataKey::TreasuryTotal);

        FeeSettled {
            endpoint_id,
            seller_share,
            treasury_share,
        }
        .publish(&env);
    }

    /// Zero the seller's accrued balance and return what it held, so the
    /// gateway can pay that amount out off chain.
    ///
    /// # THIS CONTRACT MOVES NO TOKENS
    ///
    /// `withdraw` transfers nothing. It is a ledger entry: it says "this seller
    /// is no longer owed this amount" and returns the figure. The actual USDC
    /// leaves the platform pool account off chain, and the gateway then turns
    /// it into Turkish Lira through the Stellar anchor (SEP-10/38/12/6, paid
    /// with a classic payment operation). This is a documented architectural
    /// decision, not an oversight: the contract holds no funds, so there is
    /// nothing in it to steal, and no token transfer can fail halfway.
    ///
    /// # Parameters
    ///
    /// - `seller` — the account whose balance is being cleared. Must sign, and
    ///   can only ever clear its OWN balance: the address that signs and the
    ///   address that is credited are the same parameter, so there is no way to
    ///   name a victim.
    ///
    /// # Returns
    ///
    /// The balance that was cleared, in stroops. **Returns 0 when there is
    /// nothing to withdraw** — this is deliberate and does not panic, so a
    /// retried submission is a safe no-op rather than a transaction failure.
    /// Rejecting a too-small withdrawal is the gateway's job: the anchor's
    /// 1 USDC minimum is a lower bound to refuse with a clear message, never to
    /// clamp to (CONVENTIONS.md §1.5).
    ///
    /// # Authorisation
    ///
    /// `seller.require_auth()` — the only authority that moves money stays with
    /// the seller. A caller signing as itself while passing another seller's
    /// address fails here, and the victim's balance is untouched.
    ///
    /// # Panics
    ///
    /// None. The balance cannot go negative: it is set to exactly 0.
    ///
    /// # Events
    ///
    /// [`Withdrawn`] `{ seller, amount }`, only when an amount actually moved.
    pub fn withdraw(env: Env, seller: Address) -> i128 {
        seller.require_auth();

        let mut balances = seller_balances_map(&env);
        let amount = balances.get(seller.clone()).unwrap_or(0);

        // A withdrawal of nothing writes nothing: no storage write, no event,
        // just 0 back to the caller. Beyond saving the fee, this keeps the
        // `SellerBalances` map from growing an entry for every address that
        // ever called `withdraw` — the whole map lives in one ledger entry, so
        // unbounded keys would make every settlement more expensive.
        if amount != 0 {
            balances.set(seller.clone(), 0);
            env.storage()
                .persistent()
                .set(&DataKey::SellerBalances, &balances);
            extend_persistent_ttl(&env, &DataKey::SellerBalances);

            Withdrawn { seller, amount }.publish(&env);
        }

        amount
    }

    /// The seller's current withdrawable balance in stroops, or 0 if they have
    /// never been settled to.
    ///
    /// Backs the gateway's `GET /api/balance`. The chain is the source of truth
    /// for balances: the gateway reads this rather than summing its own `calls`
    /// table, and if its SQLite cache is lost, balances are unaffected.
    ///
    /// # Authorisation
    ///
    /// None — a view. Balances are public, as everything on a public ledger is.
    ///
    /// # Panics
    ///
    /// None. An unknown seller reads 0 rather than failing, because the gateway
    /// calls this for sellers who have just signed up.
    pub fn get_balance(env: Env, seller: Address) -> i128 {
        seller_balances_map(&env).get(seller).unwrap_or(0)
    }

    /// The stored [`EndpointInfo`] — seller and per-call price — for an
    /// endpoint.
    ///
    /// Backs the gateway's price and limit checks: the price an agent is
    /// charged is the one recorded here, never one supplied by the caller.
    ///
    /// # Authorisation
    ///
    /// None — a view.
    ///
    /// # Panics
    ///
    /// - [`Error::EndpointNotFound`] if `endpoint_id` was never registered.
    ///   Unlike [`RampLedger::get_balance`], this does not have a meaningful
    ///   zero value to return: a missing endpoint is an error, not an empty
    ///   one.
    pub fn get_endpoint(env: Env, endpoint_id: u64) -> EndpointInfo {
        endpoint_or_panic(&env, endpoint_id)
    }
}

#[cfg(test)]
mod test;
