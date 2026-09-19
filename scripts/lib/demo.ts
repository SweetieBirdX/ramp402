/**
 * The demo endpoint — shared by `setup.ts` and `reset-demo.ts`.
 *
 * Both scripts need to put the same endpoint on chain and in SQLite, and they
 * must agree about what "the demo endpoint" is, or a reset between rehearsals
 * quietly produces a different one.
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { Keypair } from "@stellar/stellar-sdk";
import { invoke, scv, STROOPS_PER_UNIT } from "./chain.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * A live, keyless USD→TRY rate — the same shape of data Ramp402 exists to sell,
 * and thematically the right thing for a Turkish Lira off-ramp to be proxying.
 * Override with DEMO_UPSTREAM_URL.
 */
export const DEMO_UPSTREAM_URL =
  process.env.DEMO_UPSTREAM_URL?.trim() || "https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY";

/** 0.1 USDC a call. Small enough that a demo budget buys several. */
export const DEMO_PRICE_STROOPS = BigInt(process.env.DEMO_PRICE_STROOPS ?? "1000000");

/** Demo rows carry fixed ids so a re-run replaces them instead of piling up. */
export const DEMO_SELLER_ID = "demo-seller";
const DEMO_PRIVY_USER_ID = "demo:setup-script";

/**
 * Where the gateway keeps its cache. DB_PATH is relative to the gateway's own
 * working directory, because that is where the gateway runs — these scripts run
 * from the repo root, so a bare filename has to be resolved against gateway/.
 */
export function databasePath(): string {
  const configured = process.env.DB_PATH?.trim() || "ramp402.db";
  return resolve(REPO_ROOT, "gateway", configured);
}

export function schemaPath(): string {
  return resolve(REPO_ROOT, "gateway", "schema.sql");
}

/** Open the cache, creating it and applying schema.sql if needed. */
export function openDatabase(): Database.Database {
  const db = new Database(databasePath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(schemaPath(), "utf8"));
  return db;
}

/** Delete the cache and its write-ahead files. The chain is the source of truth. */
export function deleteDatabase(): string[] {
  const base = databasePath();
  const removed: string[] = [];
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    if (existsSync(path)) {
      rmSync(path);
      removed.push(path.slice(REPO_ROOT.length + 1));
    }
  }
  return removed;
}

export interface DemoEndpoint {
  endpointId: bigint;
  proxySlug: string;
  upstreamUrl: string;
  priceStroops: bigint;
  sellerAddress: string;
}

/** Register the demo endpoint on chain. The seller signs for itself. */
export async function registerDemoEndpoint(seller: Keypair): Promise<bigint> {
  return await invoke<bigint>(
    "register_endpoint",
    [scv.address(seller.publicKey()), scv.i128(DEMO_PRICE_STROOPS)],
    seller,
  );
}

/**
 * Cache the demo endpoint in SQLite so `GET /proxy/:slug` works the moment the
 * gateway starts. The seller row is synthetic: a real seller arrives through
 * Privy and `POST /api/sellers/bootstrap`, but a demo cannot wait for a login.
 *
 * `endpoints.id` is the decimal string of the contract's u64 (§1.1).
 */
export function cacheDemoEndpoint(
  db: Database.Database,
  endpointId: bigint,
  sellerAddress: string,
): DemoEndpoint {
  const proxySlug = process.env.DEMO_PROXY_SLUG?.trim() || nanoid(8);

  db.prepare(
    `INSERT INTO sellers (id, privy_user_id, stellar_address)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET stellar_address = excluded.stellar_address`,
  ).run(DEMO_SELLER_ID, DEMO_PRIVY_USER_ID, sellerAddress);

  // `proxy_slug` is UNIQUE, and every run registers a NEW endpoint_id because the
  // contract's counter never reuses one. So when DEMO_PROXY_SLUG is pinned — which
  // .env.example invites, to keep the demo URL stable across rehearsals — the
  // second run would collide on the slug rather than on the id, and ON CONFLICT(id)
  // does not catch that.
  //
  // Retire the older row instead of deleting it: `calls` rows reference
  // `endpoints(id)`, so a delete would fail the foreign key as soon as the demo has
  // been used once. Suffixing frees the slug, keeps the call history, and leaves
  // the pinned slug pointing at the newest demo endpoint.
  db.prepare(
    `UPDATE endpoints SET proxy_slug = proxy_slug || '-retired-' || id
     WHERE proxy_slug = ? AND id <> ?`,
  ).run(proxySlug, String(endpointId));

  db.prepare(
    `INSERT INTO endpoints (id, seller_id, upstream_url, proxy_slug, price_stroops)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       upstream_url = excluded.upstream_url,
       proxy_slug   = excluded.proxy_slug,
       price_stroops = excluded.price_stroops`,
  ).run(
    String(endpointId),
    DEMO_SELLER_ID,
    DEMO_UPSTREAM_URL,
    proxySlug,
    Number(DEMO_PRICE_STROOPS),
  );

  return {
    endpointId,
    proxySlug,
    upstreamUrl: DEMO_UPSTREAM_URL,
    priceStroops: DEMO_PRICE_STROOPS,
    sellerAddress,
  };
}

/** Human-readable price, for the summary lines. */
export const priceLabel = () =>
  `${(Number(DEMO_PRICE_STROOPS) / Number(STROOPS_PER_UNIT)).toFixed(7)} USDC a call`;
