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

> **STUB DEPLOYMENT — will be replaced once the real logic lands.**
> Every function is currently `todo!()`, so invoking one traps with
> `UnreachableCodeReached`. This ID exists so the gateway and frontend can be wired
> up now; it **will change** when the real contract is deployed. If Soroban calls
> start failing for no clear reason, check this value first.

| | |
| --- | --- |
| Network | testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CBD5OXK7ZSX2HMMIL53CCFXP7KLJFGM2G3IDBQXA5VN6OJ23DBQ4RUNC` |
| Deployer (public) | `GCYLZISOHDHY3E2NCZU2F72Y6SJAT5CN3ZUVSMHPYA76H7SUDP264335` |
| soroban-sdk | 23.5.3 |
| Stellar CLI | 25.2.0 |

Build and deploy:

```bash
cd contract
cargo build --locked --target wasm32-unknown-unknown --release
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/ramp_ledger.wasm \
  --source-account ramp402-deployer \
  --network testnet \
  --alias ramp_ledger_stub
```

Confirm a deployment is live — this reads the spec back off the network, so it
proves the contract is addressable without needing any function to work:

```bash
stellar contract info interface --id <CONTRACT_ID> --network testnet
```

`contract/Cargo.lock` is committed on purpose: it pins `ed25519-dalek` to 2.2.0
around a `soroban-env-host` 23.0.1 resolution break that otherwise stops
`cargo test` compiling on a fresh clone. Build with `--locked`.

## Gateway

_TBD._

## Frontend

_TBD._

## Demo

_TBD._
