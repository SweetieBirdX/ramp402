import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuthMiddleware, createPrivyVerifier } from "./auth.js";
import { openDatabase, type DbHandle } from "./db.js";
import { createCredentialCipher } from "./credentials.js";
import { createDraftStore } from "./drafts.js";
import { createFunder } from "./funding.js";
import { createRepo, type Repo } from "./repo.js";
import { unusedLedger } from "./testing/ledger.js";
import { unusedGate, unusedProxyLedger } from "./testing/proxy.js";
import { privyTestKeys, privyToken, TEST_PRIVY_APP_ID } from "./testing/privy.js";

const WALLET = "GCN7VANEAHQJ2BA4FEGYLD7P444UW4SE4U3AR2NQCIO4M73L66XWILI6";
const FRIENDBOT = "https://friendbot.test";
const keys = privyTestKeys();
const verifyToken = createPrivyVerifier({
  appId: TEST_PRIVY_APP_ID,
  appSecret: "unused-offline",
  jwtVerificationKey: keys.publicKeyPem,
});

/**
 * A fake ledger plus a fake Friendbot that behaves like the real one: 200 and the account appears,
 * or 400 "account already funded to starting balance" if it already exists.
 */
function fakeNetwork() {
  const ledger = new Set<string>();
  const calls = { friendbot: 0, accountExists: 0, privyLookup: 0 };
  let friendbotDown = false;

  const fetch = (async (url: string) => {
    calls.friendbot++;
    if (friendbotDown) return new Response("upstream error", { status: 503 });
    const addr = new URL(url).searchParams.get("addr")!;
    if (ledger.has(addr)) {
      return Response.json({ status: 400, detail: "account already funded to starting balance" }, { status: 400 });
    }
    ledger.add(addr);
    return Response.json({ successful: true });
  }) as typeof globalThis.fetch;

  return {
    ledger,
    calls,
    setFriendbotDown: (down: boolean) => void (friendbotDown = down),
    fetch,
    accountExists: async (addr: string) => {
      calls.accountExists++;
      return ledger.has(addr);
    },
  };
}

let dir: string;
let handle: DbHandle;
let repo: Repo;
let net: ReturnType<typeof fakeNetwork>;
let wallets: Map<string, string>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ramp402-bootstrap-"));
  handle = openDatabase(join(dir, "bootstrap.db"));
  repo = createRepo(handle);
  net = fakeNetwork();
  wallets = new Map([["did:privy:seller-1", WALLET]]);

  app = createApp(
    {
      repo,
      // This suite never withdraws, so the anchor side is inert — but AppDeps requires it, and
      // leaving it out is what silently drifted the fixtures out of typecheck.
      startAnchorFlow: () => {},
      anchorHomeDomain: "anchor.test",
      authenticate: createAuthMiddleware({ verifyToken, repo }),
      findStellarWallet: async (privyUserId) => {
        net.calls.privyLookup++;
        return wallets.get(privyUserId) ?? null;
      },
      readBalance: async () => 0n,
      drafts: createDraftStore(),
      ledger: unusedLedger,
      gate: unusedGate,
      proxyLedger: unusedProxyLedger,
      credentialCipher: createCredentialCipher("00".repeat(32)),
      funder: createFunder({
        accountExists: net.accountExists,
        friendbotUrl: FRIENDBOT,
        fetch: net.fetch,
        confirmAttempts: 3,
        confirmIntervalMs: 1,
      }),
    },
    { log: false },
  );
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const bootstrap = (claims: Record<string, unknown> = {}) =>
  request(app).post("/api/sellers/bootstrap").set("Authorization", `Bearer ${privyToken(keys.privateKey, claims)}`);

const sellerRows = () => handle.db.prepare("SELECT COUNT(*) AS n FROM sellers").get() as { n: number };

describe("POST /api/sellers/bootstrap", () => {
  it("creates the seller, funds the wallet via Friendbot, and returns the §1.3 shape", async () => {
    const res = await bootstrap();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seller_id: expect.any(String), stellar_address: WALLET, funded: true });

    expect(repo.findSellerByPrivyId("did:privy:seller-1")).toMatchObject({ id: res.body.seller_id, stellar_address: WALLET });
    expect(net.calls.friendbot).toBe(1);
    expect(net.ledger.has(WALLET)).toBe(true);
  });

  it("is idempotent: five calls in a row return the same seller, one row, one Friendbot call", async () => {
    const bodies = [];
    for (let i = 0; i < 5; i++) {
      const res = await bootstrap();
      expect(res.status).toBe(200);
      bodies.push(res.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(sellerRows().n).toBe(1);
    expect(net.calls.friendbot).toBe(1);

    // Calls 2–5 touch no network at all: seller comes from SQLite, funding from the verified cache.
    expect(net.calls.privyLookup).toBe(1);
    const afterFirst = net.calls.accountExists;
    await bootstrap();
    expect(net.calls.accountExists).toBe(afterFirst);
  });

  it("is idempotent under concurrency: five simultaneous first logins create one row and one Friendbot call", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => bootstrap()));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.seller_id)).size).toBe(1);
    expect(sellerRows().n).toBe(1);
    expect(net.calls.friendbot).toBe(1);
  });

  it("does not call Friendbot for an account that already exists on-chain", async () => {
    net.ledger.add(WALLET);
    const res = await bootstrap();
    expect(res.status).toBe(200);
    expect(net.calls.friendbot).toBe(0);
  });

  it("treats Friendbot's 'account already funded' 400 as success", async () => {
    // The account gets funded by someone else between our on-chain check and our Friendbot call.
    let first = true;
    const racingExists = net.accountExists;
    const funder = createFunder({
      accountExists: async (a) => {
        if (first) {
          first = false;
          net.ledger.add(a);
          return false;
        }
        return racingExists(a);
      },
      friendbotUrl: FRIENDBOT,
      fetch: net.fetch,
      confirmAttempts: 3,
      confirmIntervalMs: 1,
    });
    await expect(funder.ensureFunded(WALLET)).resolves.toBe("funded");
    expect(net.calls.friendbot).toBe(1);
  });

  it("502 upstream_failed when Friendbot cannot fund the account, and a later retry succeeds without a duplicate row", async () => {
    net.setFriendbotDown(true);
    const failed = await bootstrap();
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ error: "upstream_failed", message: expect.stringMatching(/Friendbot/) });
    expect(sellerRows().n).toBe(1); // the row is kept; funding is retried on the next login

    net.setFriendbotDown(false);
    const retried = await bootstrap();
    expect(retried.status).toBe(200);
    expect(retried.body.funded).toBe(true);
    expect(sellerRows().n).toBe(1);
  });

  it("409 and no row when the Privy user has no embedded Stellar wallet yet", async () => {
    const res = await bootstrap({ sub: "did:privy:no-wallet-yet" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/Stellar wallet/) });
    expect(sellerRows().n).toBe(0);
    expect(net.calls.friendbot).toBe(0);
  });

  it("401 without a valid Privy token, before touching the database or Friendbot", async () => {
    const res = await request(app).post("/api/sellers/bootstrap");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized", message: expect.any(String) });
    expect(sellerRows().n).toBe(0);
    expect(net.calls.friendbot).toBe(0);
  });

  it("400 invalid_request for a non-empty body (§1.3: no body)", async () => {
    const res = await bootstrap().send({ stellar_address: "GATTACKER" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/stellar_address/) });
    expect(sellerRows().n).toBe(0);
  });
});
