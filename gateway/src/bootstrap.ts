// POST /api/sellers/bootstrap (CONVENTIONS.md §1.3). Called by the frontend on every login, so it
// must be idempotent and cheap on repeat: known seller + address already verified = no network I/O.
import { StrKey } from "@stellar/stellar-sdk";
import type { RequestHandler } from "express";
import type { StellarWalletLookup } from "./auth.js";
import { HttpError, validate } from "./errors.js";
import { FundingError, type Funder } from "./funding.js";
import type { Repo } from "./repo.js";
import * as schemas from "./schemas.js";
import type { BootstrapSellerResponse } from "./types.js";

export interface BootstrapDeps {
  repo: Repo;
  findStellarWallet: StellarWalletLookup;
  funder: Funder;
}

/** Runs after the auth middleware, which sets req.privyUserId and req.seller. */
export function createBootstrapHandler(deps: BootstrapDeps): RequestHandler {
  return async (req, res) => {
    validate(schemas.bootstrapSellerRequest, req.body ?? {}, "body");
    const privyUserId = req.privyUserId!;

    let sellerId: string;
    let stellarAddress: string;
    if (req.seller) {
      ({ sellerId, stellarAddress } = req.seller);
    } else {
      const address = await deps.findStellarWallet(privyUserId);
      if (!address) {
        throw new HttpError(
          409,
          "invalid_request",
          "This Privy user has no embedded Stellar wallet yet. Create it, then call bootstrap again.",
        );
      }
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new Error(`Privy returned a Stellar wallet address that is not a G… key: ${address}`);
      }
      // Re-checked inside a transaction: a concurrent bootstrap may have inserted the row meanwhile.
      const { seller } = deps.repo.findOrCreateSeller({ privy_user_id: privyUserId, stellar_address: address });
      sellerId = seller.id;
      stellarAddress = seller.stellar_address;
    }

    try {
      await deps.funder.ensureFunded(stellarAddress);
    } catch (err) {
      if (err instanceof FundingError) throw new HttpError(502, "upstream_failed", err.message);
      throw err;
    }

    const body: BootstrapSellerResponse = { seller_id: sellerId, stellar_address: stellarAddress, funded: true };
    res.json(body);
  };
}
