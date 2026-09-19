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

_TBD._

## Contract

> **THE DEPLOYED ID BELOW IS STILL THE STUB — the real contract is built but not
> yet deployed.** Every function in that deployment is `todo!()`, so invoking one
> traps with `UnreachableCodeReached`. The ID exists so the gateway and frontend
> can be wired up now; it **will change** when the real contract is deployed. If
> Soroban calls start failing for no clear reason, check this value first.
>
> The real contract takes a **mandatory `--operator` constructor argument**, so
> the deploy command below is not the one the stub was deployed with.

| | |
| --- | --- |
| Network | testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CBD5OXK7ZSX2HMMIL53CCFXP7KLJFGM2G3IDBQXA5VN6OJ23DBQ4RUNC` |
| Deployer (public) | `GCYLZISOHDHY3E2NCZU2F72Y6SJAT5CN3ZUVSMHPYA76H7SUDP264335` |
| soroban-sdk | 23.5.3 |
| Stellar CLI | 25.2.0 |

Build and deploy. The `--operator` argument after `--` is the contract's
constructor: it is the public key of the gateway's `OPERATOR_SECRET_KEY`, and it
is the only address that will be allowed to call `record_call` and `settle`.
Deploying without it fails — there is no such thing as a ramp_ledger without an
operator.

```bash
cd contract
cargo build --locked --target wasm32-unknown-unknown --release
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/ramp_ledger.wasm \
  --source-account ramp402-deployer \
  --network testnet \
  --alias ramp_ledger \
  -- \
  --operator G...OPERATOR_PUBLIC_KEY
```

Confirm a deployment is live — this reads the spec back off the network, so it
proves the contract is addressable without needing any function to work:

```bash
stellar contract info interface --id <CONTRACT_ID> --network testnet
```

Confirm it has the operator the gateway actually runs with. If these two differ,
every paid call fails with `NotOperator` (error 5), so it is worth checking
before a demo rather than during one:

```bash
stellar contract invoke --id <CONTRACT_ID> --network testnet \
  --source-account ramp402-deployer -- get_operator
```

If the operator key is ever regenerated, **rotate rather than redeploy** —
redeploying mints a new `CONTRACT_ID` that then has to be re-wired into the
gateway and the frontend. The current operator signs the handover:

```bash
stellar contract invoke --id <CONTRACT_ID> --network testnet \
  --source-account ramp402-operator \
  -- set_operator --new_operator G...NEW_OPERATOR_PUBLIC_KEY
```

A wrong address here cannot be undone — only the stored operator may rotate, so
rotating to a key nobody holds means redeploying. Read it back with
`get_operator` immediately afterwards.

`contract/Cargo.lock` is committed on purpose: it pins `ed25519-dalek` to 2.2.0
around a `soroban-env-host` 23.0.1 resolution break that otherwise stops
`cargo test` compiling on a fresh clone. Build with `--locked`.

## Gateway

_TBD._

## Frontend

_TBD._

## Demo

_TBD._
