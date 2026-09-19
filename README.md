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

_TBD._

## Gateway

_TBD._

## Frontend

_TBD._

## Demo

_TBD._
