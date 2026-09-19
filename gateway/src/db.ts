// SQLite cache for the UI. The chain is the source of truth for balances (CONVENTIONS.md §1.4):
// if this file is lost, nothing on-chain is affected and the cache can be rebuilt.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

// schema.sql sits in gateway/, one level above both src/ (tsx) and dist/ (compiled build).
const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

export const DEFAULT_DB_PATH = "ramp402.db";

export type Db = Database.Database;

/** Every statement the repo layer needs, prepared once per connection (§1.4: never prepare per request). */
function prepareStatements(db: Db) {
  return {
    insertSeller: db.prepare(
      "INSERT INTO sellers (id, privy_user_id, stellar_address) VALUES (?, ?, ?)",
    ),
    sellerById: db.prepare("SELECT * FROM sellers WHERE id = ?"),
    sellerByPrivyId: db.prepare(
      "SELECT * FROM sellers WHERE privy_user_id = ? ORDER BY created_at, rowid LIMIT 1",
    ),

    insertEndpoint: db.prepare(
      "INSERT INTO endpoints (id, seller_id, upstream_url, upstream_credentials_enc, proxy_slug, price_stroops) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    endpointById: db.prepare("SELECT * FROM endpoints WHERE id = ?"),
    endpointBySlug: db.prepare("SELECT * FROM endpoints WHERE proxy_slug = ?"),
    endpointsBySeller: db.prepare(
      "SELECT * FROM endpoints WHERE seller_id = ? ORDER BY created_at DESC, rowid DESC",
    ),

    insertCall: db.prepare(
      "INSERT INTO calls (id, endpoint_id, agent_address, amount_stroops, status, tx_hash) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    callById: db.prepare("SELECT * FROM calls WHERE id = ?"),
    endpointsWithCallCountBySeller: db.prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM calls c WHERE c.endpoint_id = e.id) AS call_count
       FROM endpoints e WHERE e.seller_id = ? ORDER BY e.created_at DESC, e.rowid DESC`,
    ),
    callsByEndpoint: db.prepare(
      "SELECT * FROM calls WHERE endpoint_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ),

    insertWithdrawal: db.prepare(
      "INSERT INTO withdrawals (id, seller_id, amount_stroops, anchor_tx_id, status) VALUES (?, ?, ?, ?, ?)",
    ),
    withdrawalById: db.prepare("SELECT * FROM withdrawals WHERE id = ?"),
    updateWithdrawalStatus: db.prepare(
      "UPDATE withdrawals SET status = ?, anchor_tx_id = COALESCE(?, anchor_tx_id) WHERE id = ?",
    ),
  };
}

export type Statements = ReturnType<typeof prepareStatements>;

export interface DbHandle {
  db: Db;
  stmts: Statements;
  close(): void;
}

/**
 * Opens (or creates) the database, applies the idempotent schema and prepares all statements.
 * Path precedence: explicit argument, then DB_PATH, then ramp402.db. Tests pass a temp file.
 */
export function openDatabase(path: string = process.env.DB_PATH || DEFAULT_DB_PATH): DbHandle {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return { db, stmts: prepareStatements(db), close: () => db.close() };
}

let shared: DbHandle | undefined;

/** Process-wide handle for the running gateway, opened on first use. */
export function getDb(): DbHandle {
  shared ??= openDatabase();
  return shared;
}
