/**
 * The demo endpoint — shared by `setup.ts` and `reset-demo.ts`.
 *
 * Both scripts need to put the same endpoint on chain and in SQLite, and they
 * must agree about what "the demo endpoint" is, or a reset between rehearsals
 * quietly produces a different one.
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { Keypair } from "@stellar/stellar-sdk";
import { invoke, read, scv, STROOPS_PER_UNIT } from "./chain.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * A live, keyless USD→TRY rate — the same shape of data Ramp402 exists to sell,
 * and thematically the right thing for a Turkish Lira off-ramp to be proxying.
 * Override with DEMO_UPSTREAM_URL.
 */
export const DEMO_UPSTREAM_URL =
  process.env.DEMO_UPSTREAM_URL?.trim() || "https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY";

/**
 * 0.50 USDC a call — the documented demo economics.
 *
 * The figure is chosen so the demo can reach its final step. Three calls gross 1.50, of which the
 * seller nets 1.485 after the 1% fee, clearing the anchor's 1 USDC withdrawal floor (§1.5). At the
 * old 0.10 a call three calls netted 0.297 and the withdrawal was refused as too small, so the
 * off-ramp could never be shown.
 */
export const DEMO_PRICE_STROOPS = BigInt(process.env.DEMO_PRICE_STROOPS?.trim() || "5000000");

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

/**
 * Delete the cache and its write-ahead files. The chain is the source of truth.
 *
 * `unlinkSync`, not `rmSync`: on Windows, Node 24's `rmSync` returns without error and deletes
 * nothing when the path contains a non-ASCII character — `C:\Users\Ömer\…` is enough. The
 * existence check afterwards catches any other way a delete can be silently skipped.
 */
export function deleteDatabase(): string[] {
  const base = databasePath();
  const removed: string[] = [];
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM") {
        throw new Error(`${path} is in use — stop the gateway first, then re-run (${code})`);
      }
      throw err;
    }
    if (existsSync(path)) throw new Error(`${path} still exists after deleting it`);
    removed.push(path.slice(REPO_ROOT.length + 1));
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

/**
 * The demo endpoint this seller already has, if it is both cached AND still on chain with the
 * seller and price we expect — so re-running setup.ts does not register a new one every time.
 *
 * The on-chain check matters: after a contract redeploy the cached id may not exist, or may belong
 * to someone else's endpoint on the new contract. Anything that does not match exactly is ignored
 * and a fresh endpoint is registered.
 */
export async function findLiveDemoEndpoint(
  db: Database.Database,
  seller: Keypair,
): Promise<{ endpointId: bigint; proxySlug: string } | undefined> {
  const row = db
    .prepare(
      `SELECT e.id, e.proxy_slug FROM endpoints e JOIN sellers s ON s.id = e.seller_id
       WHERE e.seller_id = ? AND s.stellar_address = ? AND e.proxy_slug NOT LIKE '%-retired-%'
       ORDER BY CAST(e.id AS INTEGER) DESC LIMIT 1`,
    )
    .get(DEMO_SELLER_ID, seller.publicKey()) as { id: string; proxy_slug: string } | undefined;
  if (!row) return undefined;

  const endpointId = BigInt(row.id);
  try {
    const info = await read<{ seller: string; price: bigint }>("get_endpoint", [scv.u64(endpointId)], seller);
    if (info.seller !== seller.publicKey() || BigInt(info.price) !== DEMO_PRICE_STROOPS) return undefined;
  } catch {
    return undefined; // EndpointNotFound — the cache outlived the contract.
  }
  return { endpointId, proxySlug: row.proxy_slug };
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
  existingSlug?: string,
): DemoEndpoint {
  const proxySlug = process.env.DEMO_PROXY_SLUG?.trim() || existingSlug || nanoid(8);

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
