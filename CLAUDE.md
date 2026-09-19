# CLAUDE.md — Ramp402

This file is read automatically at the start of every Claude Code session in this repository.
Everything here is binding. When this file and a prompt disagree, stop and ask the human.

## What this project is

Ramp402 is a pay-per-call payment gateway for APIs, built for the Stellar Pro Hackathon
(Genesis Track, 19–20 September 2026). A developer puts their API behind our proxy; autonomous
agents pay per request in USDC over the x402 protocol; the developer withdraws their earnings to
Turkish Lira through a Stellar anchor.

Three components, one monorepo:

- `contract/`  — Soroban smart contract `ramp_ledger` (Rust). A **ledger only**: it records who
                 spent what and who is owed what. It never holds or transfers tokens.
- `gateway/`   — Node/TypeScript. The x402 proxy, the REST API, SQLite cache, and the SEP-10/38/12/6
                 anchor off-ramp. Signs contract calls with a single "operator" keypair.
- `frontend/`  — Next.js. Seller dashboard and the agent console used to drive the live demo.
- `scripts/`   — setup, demo reset, and the verification scripts.

The chain is the source of truth for balances. SQLite is a cache for the UI and can be rebuilt.

## Rule 0 — docs/CONVENTIONS.md is the contract between us

Read `docs/CONVENTIONS.md` before writing any code. It fixes the contract storage layout and
function signatures, the full REST API, the unit rules and the error shape. Three people are
writing against it in parallel right now.

**If a task seems to require a name, signature, field, route or type that contradicts
CONVENTIONS.md: STOP and ask the human.** Do not rename on one side "to make it work". A silent
rename on one side is the single most expensive failure mode in this project — it compiles, it
runs, and it breaks at integration time when nobody has hours to spare.

Only Efe edits `docs/CONVENTIONS.md`, and only after the three of them have agreed on the change.

## Rule 1 — stay in your own folder

| Folder | Owner | Who may edit |
| --- | --- | --- |
| `contract/` | Efe | Efe only |
| `gateway/` | Ömer | Ömer only |
| `frontend/` | Mert | Mert only |
| `docs/CONVENTIONS.md` | Efe | Efe only, after team agreement |
| `docs/TECHNICAL.md` | shared | Stage 4 only, one person at a time |
| `gateway/schema.sql` | Ömer | Ömer only — others propose a change, never edit |
| `.gitignore` | Efe | append-only, and tell the team |
| `README.md` | sectioned — see below | each person edits ONLY their own section |
| `scripts/setup.ts`, `scripts/reset-demo.ts` | Ömer | Ömer only |
| `scripts/smoke-contract.ts` | Efe | Efe only |
| `scripts/verify-e2e.ts`, `scripts/preflight.ts` | shared | Stage 4 only, one person at a time |

Strict folder ownership is what keeps merge conflicts near zero with three people pushing to one
branch. If a fix appears to need a change in someone else's folder, do not make it: describe the
change and tell the human to pass it to that person. Reading another person's files is always
fine — editing them is not.

**README.md is sectioned by owner.** Efe owns `## Contract`. Ömer owns `## Setup` and `## Gateway`.
Mert owns `## Frontend` and `## Demo`. Everything else (title, description, architecture, team) is
edited in Stage 4 only. Never reformat, reorder or rewrite the whole README — edit your section in
place and leave the rest byte-for-byte untouched. Whole-file reformatting is how a one-line change
turns into a fifty-line conflict.

## Rule 2 — git workflow

We work directly on `main`. No feature branches: with strict folder ownership there is almost
nothing to conflict, and branches would mean merge overhead plus the risk that someone's work is
invisible when the demo runs.

**Start of every session, before anything else:**

    git pull --rebase origin main

**End of every task:**

    git add <your files>
    git commit -m "[Name] what was done"
    git push origin main

Push immediately after committing. Do not sit on local commits — unpushed work is invisible to the
other two and turns into a conflict later.

Commit message format is `[Name] what was done`, e.g. `[Ömer] gateway: x402 proxy flow + budget tests`.

**If `git push` is rejected** (someone pushed first): run `git pull --rebase origin main`, then push
again. That is the whole procedure.

**Never, under any circumstance:**

- `git push --force` or `--force-with-lease` to `main`
- `git reset --hard` on anything already pushed
- `git rebase` of commits that are already on the remote
- `git checkout .` / `git restore .` across the whole tree
- committing on behalf of someone else, or committing changes in someone else's folder

**On a merge or rebase conflict: STOP and report it to the human.** Show which files conflict and
what each side contains. Do not resolve it yourself and do not guess which side is right — a
conflict here usually means two people interpreted CONVENTIONS.md differently, and that is a
conversation, not a merge.

## Rule 3 — never commit secrets

This repository will be made public — it is a submission requirement.

Never commit: `.env`, `.env.local`, `*.db`, `*.db-wal`, `*.db-shm`, `node_modules/`, `target/`,
`.next/`, or any secret key. A Stellar secret key is a 56-character string starting with `S` —
never write one into a source file, a test fixture, a log line, a comment, or a commit message,
not even a testnet one.

`.env.example` and `frontend/.env.local.example` ARE committed, with variable names and empty
values. When you add a new environment variable, add its name to the example file in the same
commit and tell the team, because the other two must add it to their own `.env`.

Deployed contract IDs and public `G…` addresses are public information and may go in the README.

## Rule 4 — conventions you must not violate

Full detail is in `docs/CONVENTIONS.md`. The rules broken most often:

- **All amounts are integer stroops** — in the database, in API payloads, in contract calls.
  Decimal conversion happens only in frontend display components, via `lib/format.ts`.
- **`endpoint_id` is a `u64` assigned by the contract.** Nobody else generates one. SQLite stores
  its decimal string form.
- **`proxy_slug` is not `endpoint_id`.** One is the URL identity, the other the on-chain identity.
- **Addresses travel as classic `G…` strings**; conversion to the Soroban `Address` type happens
  in the gateway only.
- **Errors are `{ "error": "<machine_code>", "message": "<human text>" }`** with a code from the
  list in CONVENTIONS.md §1.1.
- **Status enums are fixed**: `paid | upstream_failed | refunded` and `pending | completed | failed`.
- **Nothing is hardcoded that the anchor's `stellar.toml` can tell us** — issuer, endpoints, limits.
- **The anchor is paid with a classic payment operation and `memo_type: id`** — never a contract
  call, never a text memo.

## Rule 5 — verify before you commit

Run the check for the folder you touched, and paste its output into your summary. "It works on my
machine" is not a verification.

| You touched | Run |
| --- | --- |
| `contract/` | `cargo test` — and `npx tsx scripts/smoke-contract.ts` once it exists |
| `gateway/` | `npm test` (and `npm run test:integration` when the network is available) |
| `frontend/` | `npm run check` — typecheck, lint and production build |
| anything, during integration | `npx tsx scripts/verify-e2e.ts` |

Never weaken a test to make it pass. If a test is failing for a reason you believe is wrong, say
so and ask — do not relax the assertion.

## Rule 6 — stop and ask, don't improvise

Stop and ask the human when:

- a change would contradict `docs/CONVENTIONS.md`
- you hit a git conflict, or a push is rejected twice in a row
- a task seems to require editing another person's folder
- a required environment variable is missing or empty
- you need a schema change in `gateway/schema.sql`
- a library behaves differently from the prompt's assumption (API changed, package renamed)
- a spike's result would change the architecture
- an operation would delete, rewrite or force-push shared history

Being blocked for two minutes is cheap. Silently diverging is not.

## Known traps in this codebase

- **The contract ID changes once.** A stub is deployed early so the gateway and frontend can be
  wired up, and the real contract replaces it later. If Soroban calls fail for no clear reason,
  check that `CONTRACT_ID` is the current one before debugging anything else.
- **A Privy wallet is not a funded Stellar account.** `require_auth()` fails against an unfunded
  address, so the gateway funds new sellers via Friendbot during bootstrap. Never make the user
  do this manually.
- **The budget is frozen on the first call** for an (agent, endpoint) pair, and the `X-Agent-Budget`
  header is ignored on every later call. Passing a bigger budget later must NOT raise the limit —
  that is a security property with a test guarding it.
- **Payment taken but upstream failed** is a real state, not an edge case: record the call as
  `upstream_failed`, do not call `settle`, and return 502.
- **Persistent storage TTL must be extended on every contract write.** Storage that expires
  mid-demo is unrecoverable in the moment.
- **The 1 USDC anchor limit is a minimum, not a cap.** Reject below it; never clamp to it.
- **Privy uses hash-based signing for Stellar** and does not inspect what it signs. Whether it can
  sign Soroban `invoke_host_function` transactions was verified by spike S3 — check that result
  before assuming.

## Language

Code, comments, commit messages, README and `docs/TECHNICAL.md` are in English — the judges read
them. Team chat is Turkish. User-facing UI strings may be Turkish where that is the natural
choice (for example the "TL'ye Çek" button).