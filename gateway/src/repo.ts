// Typed access to the four cache tables. Shapes mirror docs/CONVENTIONS.md §1.4 exactly;
// amounts are integer stroops and endpoints.id is the decimal string of the contract's u64 (§1.1).
import { nanoid } from "nanoid";
import type { DbHandle } from "./db.js";
import type { CallStatus, WithdrawalStatus } from "./types.js";

export type { CallStatus, WithdrawalStatus };

export interface SellerRow {
  id: string;
  privy_user_id: string;
  stellar_address: string;
  created_at: string;
}

export interface EndpointRow {
  id: string;
  seller_id: string;
  upstream_url: string;
  proxy_slug: string;
  price_stroops: number;
  created_at: string;
}

export interface EndpointWithCallCountRow extends EndpointRow {
  call_count: number;
}

export interface CallRow {
  id: string;
  endpoint_id: string;
  agent_address: string;
  amount_stroops: number;
  status: CallStatus;
  tx_hash: string | null;
  created_at: string;
}

export interface WithdrawalRow {
  id: string;
  seller_id: string;
  amount_stroops: number;
  anchor_tx_id: string | null;
  status: WithdrawalStatus;
  created_at: string;
}

/** Contract-assigned endpoint ids arrive as bigint (u64) or as their decimal string; nothing else is accepted. */
export type EndpointId = bigint | string;

const U64_MAX = (1n << 64n) - 1n;

export function endpointIdToString(id: EndpointId): string {
  const s = typeof id === "bigint" ? id.toString() : id;
  if (!/^(0|[1-9]\d*)$/.test(s) || BigInt(s) > U64_MAX) {
    throw new RangeError(`endpoint_id must be the decimal form of a u64, got ${JSON.stringify(s)}`);
  }
  return s;
}

function assertStroops(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of stroops, got ${value}`);
  }
}

export function createRepo({ db, stmts }: DbHandle) {
  function createSeller(input: { privy_user_id: string; stellar_address: string }): SellerRow {
    const id = nanoid();
    stmts.insertSeller.run(id, input.privy_user_id, input.stellar_address);
    return stmts.sellerById.get(id) as SellerRow;
  }

  // sellers.privy_user_id is not UNIQUE in the schema, so "at most one row per Privy user" is enforced
  // here: lookup and insert run in one synchronous transaction, which nothing can interleave with.
  const findOrCreateSellerTx = db.transaction(
    (input: { privy_user_id: string; stellar_address: string }): { seller: SellerRow; created: boolean } => {
      const existing = stmts.sellerByPrivyId.get(input.privy_user_id) as SellerRow | undefined;
      return existing ? { seller: existing, created: false } : { seller: createSeller(input), created: true };
    },
  );

  return {
    createSeller,

    /** Returns the Privy user's seller row, inserting it first if there is none. */
    findOrCreateSeller(input: { privy_user_id: string; stellar_address: string }): { seller: SellerRow; created: boolean } {
      return findOrCreateSellerTx(input);
    },

    findSellerByPrivyId(privyUserId: string): SellerRow | undefined {
      return stmts.sellerByPrivyId.get(privyUserId) as SellerRow | undefined;
    },

    /** `endpoint_id` must be the value returned by the contract's register_endpoint — never generated here. */
    createEndpoint(input: {
      endpoint_id: EndpointId;
      seller_id: string;
      upstream_url: string;
      proxy_slug: string;
      price_stroops: number;
    }): EndpointRow {
      assertStroops("price_stroops", input.price_stroops);
      const id = endpointIdToString(input.endpoint_id);
      stmts.insertEndpoint.run(id, input.seller_id, input.upstream_url, input.proxy_slug, input.price_stroops);
      return stmts.endpointById.get(id) as EndpointRow;
    },

    listEndpointsBySeller(sellerId: string): EndpointRow[] {
      return stmts.endpointsBySeller.all(sellerId) as EndpointRow[];
    },

    /** The seller's endpoints, newest first, each with its total number of logged calls. */
    listEndpointsWithCallCountBySeller(sellerId: string): EndpointWithCallCountRow[] {
      return stmts.endpointsWithCallCountBySeller.all(sellerId) as EndpointWithCallCountRow[];
    },

    findEndpointBySlug(proxySlug: string): EndpointRow | undefined {
      return stmts.endpointBySlug.get(proxySlug) as EndpointRow | undefined;
    },

    findEndpointById(endpointId: EndpointId): EndpointRow | undefined {
      return stmts.endpointById.get(endpointIdToString(endpointId)) as EndpointRow | undefined;
    },

    insertCall(input: {
      endpoint_id: EndpointId;
      agent_address: string;
      amount_stroops: number;
      status: CallStatus;
      tx_hash?: string | null;
    }): CallRow {
      assertStroops("amount_stroops", input.amount_stroops);
      const id = nanoid();
      stmts.insertCall.run(
        id,
        endpointIdToString(input.endpoint_id),
        input.agent_address,
        input.amount_stroops,
        input.status,
        input.tx_hash ?? null,
      );
      return stmts.callById.get(id) as CallRow;
    },

    /** Newest first, as GET /api/calls requires; at most `limit` rows. */
    listCallsByEndpoint(endpointId: EndpointId, limit = 100): CallRow[] {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
      return stmts.callsByEndpoint.all(endpointIdToString(endpointId), limit) as CallRow[];
    },

    createWithdrawal(input: {
      seller_id: string;
      amount_stroops: number;
      status?: WithdrawalStatus;
      anchor_tx_id?: string | null;
    }): WithdrawalRow {
      assertStroops("amount_stroops", input.amount_stroops);
      const id = nanoid();
      stmts.insertWithdrawal.run(
        id,
        input.seller_id,
        input.amount_stroops,
        input.anchor_tx_id ?? null,
        input.status ?? "pending",
      );
      return stmts.withdrawalById.get(id) as WithdrawalRow;
    },

    /** Passing anchor_tx_id sets it; omitting it keeps the stored value. Returns undefined for an unknown id. */
    updateWithdrawalStatus(
      id: string,
      status: WithdrawalStatus,
      anchorTxId?: string | null,
    ): WithdrawalRow | undefined {
      const { changes } = stmts.updateWithdrawalStatus.run(status, anchorTxId ?? null, id);
      return changes === 0 ? undefined : (stmts.withdrawalById.get(id) as WithdrawalRow);
    },

    findWithdrawal(id: string): WithdrawalRow | undefined {
      return stmts.withdrawalById.get(id) as WithdrawalRow | undefined;
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
