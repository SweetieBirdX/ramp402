// Endpoint registration, two-step (CONVENTIONS.md §1.3): /prepare builds an unsigned
// register_endpoint transaction with the seller as source; the frontend has Privy sign it;
// /submit sends it and takes the endpoint_id from the contract's return value (§1.1) — never
// from a counter or a row count here.
import type { RequestHandler } from "express";
import { nanoid } from "nanoid";
import type { DraftStore } from "./drafts.js";
import { HttpError, validate } from "./errors.js";
import type { Repo } from "./repo.js";
import * as schemas from "./schemas.js";
import { scv, SorobanError, type StellarClient } from "./stellar.js";
import type { PrepareEndpointResponse, SubmitEndpointResponse } from "./types.js";
import { splitUpstreamCredentials } from "./upstream.js";

const U64_MAX = (1n << 64n) - 1n;
const INVALID_PRICE = 3; // contract error code, CONVENTIONS.md §1.2

export interface EndpointRouteDeps {
  repo: Repo;
  drafts: DraftStore;
  ledger: Pick<StellarClient, "contractId" | "buildUnsignedInvoke" | "transactionHash" | "submitSignedXdr">;
  /** proxy_slug generator; nanoid(8) unless a test overrides it. */
  newSlug?: () => string;
}

const draftGone = () =>
  new HttpError(404, "not_found", "This registration draft has expired or does not exist. Start the registration again.");

export function createEndpointRoutes(deps: EndpointRouteDeps) {
  const newSlug = deps.newSlug ?? (() => nanoid(8));

  const prepare: RequestHandler = async (req, res) => {
    const { upstream_url, price_stroops } = validate(schemas.prepareEndpointRequest, req.body, "body");
    const seller = req.seller!;

    // Credentials must be stored encrypted (checklist §C), and schema.sql has no column for them yet.
    // Until it does, refuse them rather than store them in clear text or silently drop them.
    if (splitUpstreamCredentials(upstream_url).credentials) {
      throw new HttpError(
        400,
        "invalid_request",
        "upstream_url contains credentials (user:password@ or a key/token query parameter), which cannot be stored yet",
      );
    }

    let unsignedXdr: string;
    try {
      unsignedXdr = await deps.ledger.buildUnsignedInvoke(
        deps.ledger.contractId,
        "register_endpoint",
        [scv.address(seller.stellarAddress), scv.i128(price_stroops)],
        seller.stellarAddress,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Account not found")) {
        throw new HttpError(409, "invalid_request", "The seller account is not funded yet: call POST /api/sellers/bootstrap first");
      }
      if (err instanceof SorobanError && err.contractErrorCode === INVALID_PRICE) {
        throw new HttpError(400, "invalid_request", "The contract rejected the price (InvalidPrice)");
      }
      throw err;
    }

    const draft_id = deps.drafts.put({
      kind: "register_endpoint",
      sellerId: seller.sellerId,
      txHash: deps.ledger.transactionHash(unsignedXdr),
      upstream_url,
      price_stroops,
    });
    const body: PrepareEndpointResponse = { unsigned_xdr: unsignedXdr, draft_id };
    res.json(body);
  };

  const submit: RequestHandler = async (req, res) => {
    const { draft_id, signed_xdr } = validate(schemas.submitEndpointRequest, req.body, "body");
    const seller = req.seller!;

    const draft = deps.drafts.get(draft_id);
    // Another seller's draft is reported exactly like a missing one: draft ids leak nothing.
    if (!draft || draft.kind !== "register_endpoint" || draft.sellerId !== seller.sellerId) throw draftGone();

    let signedHash: string;
    try {
      signedHash = deps.ledger.transactionHash(signed_xdr);
    } catch {
      throw new HttpError(400, "invalid_request", "signed_xdr is not a transaction envelope for this network");
    }
    if (signedHash !== draft.txHash) {
      throw new HttpError(400, "invalid_request", "signed_xdr is not the transaction that was prepared for this draft");
    }

    // Single use from here on: a draft can reach the network at most once.
    if (!deps.drafts.take(draft_id)) throw draftGone();

    let result: Awaited<ReturnType<EndpointRouteDeps["ledger"]["submitSignedXdr"]>>;
    try {
      result = await deps.ledger.submitSignedXdr(signed_xdr);
    } catch (err) {
      if (err instanceof SorobanError && (err.stage === "send" || err.stage === "execution")) {
        throw new HttpError(400, "invalid_request", `The network rejected the registration transaction: ${err.message}`);
      }
      throw err;
    }

    // The endpoint_id is the contract's u64 return value. If it is not there, stop: never invent one.
    const endpointId = result.returnValue;
    if (typeof endpointId !== "bigint" || endpointId < 1n || endpointId > U64_MAX) {
      throw new Error(
        `register_endpoint tx ${result.txHash} succeeded but its return value is not a u64 endpoint_id: ${String(endpointId)}`,
      );
    }

    const row = insertWithFreshSlug(endpointId, seller.sellerId, draft.upstream_url, draft.price_stroops, result.txHash);
    const body: SubmitEndpointResponse = {
      endpoint_id: row.id,
      proxy_slug: row.proxy_slug,
      upstream_url: row.upstream_url,
      price_stroops: row.price_stroops,
    };
    res.json(body);
  };

  function insertWithFreshSlug(endpointId: bigint, sellerId: string, upstreamUrl: string, price: number, txHash: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        return deps.repo.createEndpoint({
          endpoint_id: endpointId,
          seller_id: sellerId,
          upstream_url: upstreamUrl,
          proxy_slug: newSlug(),
          price_stroops: price,
        });
      } catch (err) {
        const slugTaken = err instanceof Error && /UNIQUE constraint failed: endpoints\.proxy_slug/.test(err.message);
        if (slugTaken && attempt < 5) continue;
        // On-chain registration succeeded; say exactly what to recover if the cache write did not.
        console.error(`endpoint ${endpointId} registered on-chain (tx ${txHash}) but not cached:`, err);
        throw err;
      }
    }
  }

  return { prepare, submit };
}
