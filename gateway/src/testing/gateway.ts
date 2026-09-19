// Test-only: the whole gateway app on a temporary database, with every external system faked —
// the contract (fakeContract / fakeLedger), the x402 facilitator (fakeGate), Privy (real token
// verification against a local key), Friendbot and the upstream APIs. For cross-cutting tests that
// sweep every route; per-feature tests build narrower apps of their own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { createAuthMiddleware, createPrivyVerifier } from "../auth.js";
import { createCredentialCipher } from "../credentials.js";
import { openDatabase, type DbHandle } from "../db.js";
import { createDraftStore } from "../drafts.js";
import { createFunder } from "../funding.js";
import { createProxyLedger } from "../proxyLedger.js";
import { createRepo, type Repo, type SellerRow, type WithdrawalRow } from "../repo.js";
import { fakeLedger } from "./ledger.js";
import { privyTestKeys, privyToken, TEST_PRIVY_APP_ID } from "./privy.js";
import { fakeContract, fakeGate } from "./proxy.js";

// Public-key-shaped fixtures only; no secret keys.
export const SELLER_A = "GCN7VANEAHQJ2BA4FEGYLD7P444UW4SE4U3AR2NQCIO4M73L66XWILI6";
export const SELLER_B = "GBPA6I6PQAYXADRROHMGYGPRY7NVHXL5Q7QT3L6SOAUSIBWV27AJKWZG";
export const AGENT = "GA6UDAI55VG36CM7SQSKOVWL4AAHYYOBJSS4JPYUJME5ILMJP235JYQB";
export const PRICE = 1_000_000; // 0.1 USDC

/** Seller A owns endpoint 7 (/proxy/aaaa0007); seller B owns endpoint 9 (/proxy/bbbb0009). */
export const ENDPOINT_A = { id: "7", slug: "aaaa0007" };
export const ENDPOINT_B = { id: "9", slug: "bbbb0009" };

export function createTestGateway() {
  const dir = mkdtempSync(join(tmpdir(), "ramp402-gw-"));
  const handle: DbHandle = openDatabase(join(dir, "gateway.db"));
  const repo: Repo = createRepo(handle);

  const sellerA: SellerRow = repo.createSeller({ privy_user_id: "did:privy:A", stellar_address: SELLER_A });
  const sellerB: SellerRow = repo.createSeller({ privy_user_id: "did:privy:B", stellar_address: SELLER_B });
  repo.createEndpoint({ endpoint_id: 7n, seller_id: sellerA.id, upstream_url: "https://a.test/api", proxy_slug: ENDPOINT_A.slug, price_stroops: PRICE });
  repo.createEndpoint({ endpoint_id: 9n, seller_id: sellerB.id, upstream_url: "https://b.test/api", proxy_slug: ENDPOINT_B.slug, price_stroops: PRICE });

  const keys = privyTestKeys();
  const strangerKeys = privyTestKeys();
  const contract = fakeContract({ [ENDPOINT_A.id]: BigInt(PRICE), [ENDPOINT_B.id]: BigInt(PRICE) });
  const x402 = fakeGate();
  const ledger = fakeLedger();
  const logs: string[] = [];

  /** Swap these per test to steer the fakes. */
  const behaviour = {
    upstream: async (): Promise<Response> => Response.json({ ok: true }),
    readBalance: async (address: string): Promise<bigint> => (address === SELLER_A ? 4_000_000n : 9_000_000n),
  };

  /**
   * Withdrawals whose anchor flow was started. The real job talks SEP-10/38/12/6 to a live anchor,
   * so tests assert that it was handed the row and stop there — the flow itself is exercised by the
   * integration tests and by scripts against tr-mock-anchor.
   */
  const startedAnchorFlows: WithdrawalRow[] = [];

  const app = createApp(
    {
      repo,
      authenticate: createAuthMiddleware({
        verifyToken: createPrivyVerifier({ appId: TEST_PRIVY_APP_ID, appSecret: "unused-offline", jwtVerificationKey: keys.publicKeyPem }),
        repo,
      }),
      findStellarWallet: async () => null,
      funder: createFunder({ accountExists: async () => true, friendbotUrl: undefined }),
      readBalance: (address) => behaviour.readBalance(address),
      drafts: createDraftStore(),
      ledger: ledger.ledger,
      credentialCipher: createCredentialCipher("00".repeat(32)),
      gate: x402.gate,
      proxyLedger: createProxyLedger(contract.stellar, (l) => logs.push(l)),
      fetchUpstream: (() => behaviour.upstream()) as unknown as typeof fetch,
      upstreamTimeoutMs: 50,
      startAnchorFlow: (row) => startedAnchorFlows.push(row),
      anchorHomeDomain: "anchor.test",
      log: (l) => logs.push(l),
    },
    { log: false },
  );

  return {
    app,
    repo,
    handle,
    sellerA,
    sellerB,
    contract,
    x402,
    ledger,
    logs,
    behaviour,
    startedAnchorFlows,
    /** `Authorization` header value for a Privy user (a bootstrapped seller unless `sub` says otherwise). */
    bearer: (sub = "did:privy:A", claims: Record<string, unknown> = {}) => `Bearer ${privyToken(keys.privateKey, { sub, ...claims })}`,
    /** Tokens that must all be refused with 401. */
    badAuthorizations: {
      "no Authorization header": undefined,
      "a non-JWT bearer token": "Bearer not-a-jwt",
      "the Basic scheme": `Basic ${privyToken(keys.privateKey, { sub: "did:privy:A" })}`,
      "a token signed by another key": `Bearer ${privyToken(strangerKeys.privateKey, { sub: "did:privy:A" })}`,
      "an expired token": `Bearer ${privyToken(keys.privateKey, { sub: "did:privy:A", iat: 1_000, exp: 2_000 })}`,
    } as Record<string, string | undefined>,
    close() {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestGateway = ReturnType<typeof createTestGateway>;
