import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "./db.js";
import { createRepo, type Repo } from "./repo.js";

// Public testnet addresses only; no secret keys in fixtures.
const SELLER_ADDRESS = "GCN7VANEAHQJ2BA4FEGYLD7P444UW4SE4U3AR2NQCIO4M73L66XWILI6";

let dir: string;
let dbPath: string;
let handle: DbHandle;
let repo: Repo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ramp402-test-"));
  dbPath = join(dir, "test.db");
  handle = openDatabase(dbPath);
  repo = createRepo(handle);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("repo: seller + endpoint round-trip", () => {
  it("inserts a seller and an endpoint and reads both back unchanged", () => {
    const seller = repo.createSeller({ privy_user_id: "did:privy:test-seller", stellar_address: SELLER_ADDRESS });
    expect(seller.id).toEqual(expect.any(String));
    expect(seller.created_at).toEqual(expect.any(String));

    const found = repo.findSellerByPrivyId("did:privy:test-seller");
    expect(found).toEqual(seller);
    expect(found?.stellar_address).toBe(SELLER_ADDRESS);

    // The contract returns a u64; SQLite stores its decimal string form (CONVENTIONS.md §1.1).
    const endpoint = repo.createEndpoint({
      endpoint_id: 1n,
      seller_id: seller.id,
      upstream_url: "https://api.example.com/weather",
      proxy_slug: "wthr1234",
      price_stroops: 5_000_000,
    });
    expect(endpoint).toMatchObject({
      id: "1",
      seller_id: seller.id,
      upstream_url: "https://api.example.com/weather",
      proxy_slug: "wthr1234",
      price_stroops: 5_000_000,
    });

    expect(repo.findEndpointById(1n)).toEqual(endpoint);
    expect(repo.findEndpointById("1")).toEqual(endpoint);
    expect(repo.findEndpointBySlug("wthr1234")).toEqual(endpoint);
    expect(repo.listEndpointsBySeller(seller.id)).toEqual([endpoint]);
    expect(typeof repo.findEndpointById("1")?.price_stroops).toBe("number");
  });

  it("survives reopening the same file: schema is idempotent and data persists", () => {
    const seller = repo.createSeller({ privy_user_id: "did:privy:reopen", stellar_address: SELLER_ADDRESS });
    handle.close();

    handle = openDatabase(dbPath);
    repo = createRepo(handle);
    expect(repo.findSellerByPrivyId("did:privy:reopen")).toEqual(seller);
    expect(handle.db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("returns undefined for unknown seller, slug and endpoint id", () => {
    expect(repo.findSellerByPrivyId("did:privy:nobody")).toBeUndefined();
    expect(repo.findEndpointBySlug("missing")).toBeUndefined();
    expect(repo.findEndpointById(42n)).toBeUndefined();
  });

  it("rejects non-integer stroops and non-u64 endpoint ids", () => {
    const seller = repo.createSeller({ privy_user_id: "did:privy:units", stellar_address: SELLER_ADDRESS });
    const base = { seller_id: seller.id, upstream_url: "https://x.test", proxy_slug: "slug0001" };

    expect(() => repo.createEndpoint({ ...base, endpoint_id: 2n, price_stroops: 0.5 })).toThrow(RangeError);
    expect(() => repo.createEndpoint({ ...base, endpoint_id: "abc", price_stroops: 100 })).toThrow(RangeError);
    expect(() => repo.createEndpoint({ ...base, endpoint_id: "-1", price_stroops: 100 })).toThrow(RangeError);
    expect(() => repo.createEndpoint({ ...base, endpoint_id: 1n << 64n, price_stroops: 100 })).toThrow(RangeError);
    expect(repo.listEndpointsBySeller(seller.id)).toEqual([]);
  });

  it("enforces foreign keys: an endpoint needs an existing seller", () => {
    expect(() =>
      repo.createEndpoint({
        endpoint_id: 7n,
        seller_id: "no-such-seller",
        upstream_url: "https://x.test",
        proxy_slug: "orphan01",
        price_stroops: 100,
      }),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("repo: calls + withdrawals", () => {
  it("logs calls newest first and tracks withdrawal status changes", () => {
    const seller = repo.createSeller({ privy_user_id: "did:privy:flow", stellar_address: SELLER_ADDRESS });
    repo.createEndpoint({
      endpoint_id: 3n,
      seller_id: seller.id,
      upstream_url: "https://x.test",
      proxy_slug: "flow0001",
      price_stroops: 1_000,
    });

    const first = repo.insertCall({ endpoint_id: 3n, agent_address: SELLER_ADDRESS, amount_stroops: 1_000, status: "paid", tx_hash: "aa" });
    const second = repo.insertCall({ endpoint_id: "3", agent_address: SELLER_ADDRESS, amount_stroops: 1_000, status: "upstream_failed" });
    expect(second.tx_hash).toBeNull();
    expect(repo.listCallsByEndpoint(3n).map((c) => c.id)).toEqual([second.id, first.id]);

    const w = repo.createWithdrawal({ seller_id: seller.id, amount_stroops: 10_000_000 });
    expect(w).toMatchObject({ status: "pending", anchor_tx_id: null, amount_stroops: 10_000_000 });

    expect(repo.updateWithdrawalStatus(w.id, "pending", "anchor-tx-1")?.anchor_tx_id).toBe("anchor-tx-1");
    const done = repo.updateWithdrawalStatus(w.id, "completed");
    expect(done).toMatchObject({ status: "completed", anchor_tx_id: "anchor-tx-1" });
    expect(repo.findWithdrawal(w.id)).toEqual(done);
    expect(repo.updateWithdrawalStatus("missing", "failed")).toBeUndefined();
  });
});
