// Seller authentication (CONVENTIONS.md §1.3): `Authorization: Bearer <privy_access_token>`,
// verified with the Privy server SDK, then privy_user_id → seller row from SQLite.
import { InvalidAuthTokenError, PrivyClient } from "@privy-io/node";
import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";
import type { Repo } from "./repo.js";

export interface AuthenticatedSeller {
  sellerId: string;
  privyUserId: string;
  stellarAddress: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth whenever the token is valid: the verified Privy user id. */
      privyUserId?: string;
      /**
       * Set by requireAuth. null means a valid token whose seller row does not exist yet: only
       * POST /api/sellers/bootstrap may proceed in that state (it creates the row).
       */
      seller?: AuthenticatedSeller | null;
    }
  }
}

/** Verifies an access token and returns the Privy user id (the token's `sub`). Throws if invalid. */
export type TokenVerifier = (accessToken: string) => Promise<string>;

export interface PrivyVerifierOptions {
  appId: string;
  appSecret: string;
  /** PEM (SPKI) verification key. Without it, the key is fetched from Privy's JWKS endpoint and cached. */
  jwtVerificationKey?: string;
}

export function createPrivyVerifier(options: PrivyVerifierOptions): TokenVerifier {
  const privy = new PrivyClient({
    appId: options.appId,
    appSecret: options.appSecret,
    jwtVerificationKey: options.jwtVerificationKey,
  });
  const auth = privy.utils().auth();
  return async (accessToken) => (await auth.verifyAccessToken(accessToken)).user_id;
}

/** Builds the verifier from PRIVY_APP_ID / PRIVY_APP_SECRET; fails fast if either is empty. */
export function privyVerifierFromEnv(env: NodeJS.ProcessEnv = process.env): TokenVerifier {
  const appId = env.PRIVY_APP_ID?.trim();
  const appSecret = env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("Missing required environment variable(s): PRIVY_APP_ID, PRIVY_APP_SECRET");
  }
  return createPrivyVerifier({ appId, appSecret });
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * 401 unless the request carries a valid Privy access token. On success sets req.privyUserId and
 * req.seller (null if the seller has not bootstrapped yet — this middleware never creates the row).
 */
export function createAuthMiddleware(deps: { verifyToken: TokenVerifier; repo: Repo }): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.get("authorization") ?? "");
    if (!match) {
      throw new HttpError(401, "unauthorized", "Missing or malformed Authorization: Bearer <privy_access_token>");
    }

    let privyUserId: string;
    try {
      privyUserId = await deps.verifyToken(match[1]!);
    } catch (err) {
      // Privy maps every failure (bad signature, expired, wrong app, JWKS unreachable) to this class.
      if (err instanceof InvalidAuthTokenError) {
        throw new HttpError(401, "unauthorized", err.message);
      }
      throw err;
    }

    const row = deps.repo.findSellerByPrivyId(privyUserId);
    req.privyUserId = privyUserId;
    req.seller = row
      ? { sellerId: row.id, privyUserId, stellarAddress: row.stellar_address }
      : null;
    next();
  };
}
