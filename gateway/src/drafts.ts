// In-memory store for the two-step XDR flow (CONVENTIONS.md §1.3): /prepare saves what it built
// under a draft_id, /submit looks it up. Drafts are short-lived and lost on restart by design —
// the unsigned transaction they describe expires on-chain after TX_TIMEOUT_SECONDS anyway.
import { nanoid } from "nanoid";
import { TX_TIMEOUT_SECONDS } from "./stellar.js";

interface DraftBase {
  /** The seller who prepared it; /submit must reject a draft presented by anyone else. */
  sellerId: string;
  /** Hex hash of the prepared transaction. Signatures do not change it, so /submit can check the signed XDR is this exact transaction. */
  txHash: string;
}

export interface RegisterEndpointDraft extends DraftBase {
  kind: "register_endpoint";
  upstream_url: string;
  price_stroops: number;
}

export interface WithdrawDraft extends DraftBase {
  kind: "withdraw";
}

export type Draft = RegisterEndpointDraft | WithdrawDraft;

export interface DraftStoreOptions {
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const DEFAULT_DRAFT_TTL_MS = TX_TIMEOUT_SECONDS * 1000;

export function createDraftStore(options: DraftStoreOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_DRAFT_TTL_MS;
  const now = options.now ?? Date.now;
  const drafts = new Map<string, { draft: Draft; expiresAt: number }>();

  function sweep(): void {
    const t = now();
    for (const [id, entry] of drafts) if (entry.expiresAt <= t) drafts.delete(id);
  }

  function live(id: string): Draft | undefined {
    const entry = drafts.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      drafts.delete(id);
      return undefined;
    }
    return entry.draft;
  }

  return {
    /** Stores a draft and returns its new draft_id. */
    put(draft: Draft): string {
      sweep(); // bounded memory without a background timer
      const id = nanoid();
      drafts.set(id, { draft, expiresAt: now() + ttlMs });
      return id;
    },

    /** Returns the draft if it exists and has not expired; does not consume it. */
    get(id: string): Draft | undefined {
      return live(id);
    },

    /** Returns and removes the draft: a draft_id can be submitted at most once. */
    take(id: string): Draft | undefined {
      const draft = live(id);
      drafts.delete(id);
      return draft;
    },

    get size(): number {
      sweep();
      return drafts.size;
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
