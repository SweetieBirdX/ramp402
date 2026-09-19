import { describe, expect, it } from "vitest";
import { createDraftStore, type Draft } from "./drafts.js";

const DRAFT: Draft = {
  kind: "register_endpoint",
  sellerId: "seller-1",
  txHash: "ab".repeat(32),
  upstream_url: "https://api.example.com/weather",
  upstream_credentials_enc: null,
  price_stroops: 5_000_000,
};

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("draft store", () => {
  it("returns a stored draft by its draft_id", () => {
    const store = createDraftStore({ ttlMs: 60_000 });
    const id = store.put(DRAFT);
    expect(id).toEqual(expect.any(String));
    expect(store.get(id)).toEqual(DRAFT);
  });

  it("does not return a draft once its TTL has passed", () => {
    const c = clock();
    const store = createDraftStore({ ttlMs: 60_000, now: c.now });
    const id = store.put(DRAFT);

    c.advance(59_999);
    expect(store.get(id)).toEqual(DRAFT);

    c.advance(1); // exactly at the TTL: expired
    expect(store.get(id)).toBeUndefined();
    expect(store.take(id)).toBeUndefined();
  });

  it("take() consumes the draft so a draft_id can only be submitted once", () => {
    const store = createDraftStore();
    const id = store.put(DRAFT);
    expect(store.take(id)).toEqual(DRAFT);
    expect(store.take(id)).toBeUndefined();
    expect(store.get(id)).toBeUndefined();
  });

  it("returns undefined for an unknown draft_id and gives every draft a distinct id", () => {
    const store = createDraftStore();
    expect(store.get("nope")).toBeUndefined();
    const a = store.put(DRAFT);
    const b = store.put({ kind: "withdraw", sellerId: "seller-1", txHash: "cd".repeat(32) });
    expect(a).not.toBe(b);
    expect(store.get(b)?.kind).toBe("withdraw");
  });

  it("drops expired drafts from memory", () => {
    const c = clock();
    const store = createDraftStore({ ttlMs: 1_000, now: c.now });
    store.put(DRAFT);
    store.put(DRAFT);
    expect(store.size).toBe(2);
    c.advance(1_000);
    expect(store.size).toBe(0);
  });
});
