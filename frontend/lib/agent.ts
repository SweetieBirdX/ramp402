import {
  Keypair,
  Horizon,
  StellarToml,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  TimeoutInfinite,
} from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { callProxy } from "./api";
import type { BudgetExceededResponse, UpstreamFailedResponse } from "./types";

export const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";
export const SOROBAN_TESTNET_RPC = "https://soroban-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
/**
 * The USDC issuer, discovered from the anchor's stellar.toml rather than hardcoded (§1.5) — the
 * same way the gateway resolves it in `gateway/src/anchor/toml.ts`. The mainnet issuer differs, and
 * an anchor may change its own, so a constant here is a bug waiting for a network switch.
 *
 * Resolved once and cached for the tab. The agent console is the only caller.
 */
let usdcAssetPromise: Promise<Asset> | undefined;

export function anchorHomeDomain(): string {
  return process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN?.trim() || "tr-mock-anchor.fly.dev";
}

export async function usdcAsset(): Promise<Asset> {
  usdcAssetPromise ??= (async () => {
    const domain = anchorHomeDomain();
    const toml = await StellarToml.Resolver.resolve(domain);
    const issuer = toml.CURRENCIES?.find((c: { code?: string; issuer?: string }) => c.code === "USDC")?.issuer;
    if (!issuer) throw new Error(`${domain} lists no USDC issuer in its stellar.toml`);
    return new Asset("USDC", issuer);
  })().catch((err) => {
    usdcAssetPromise = undefined; // never cache a failure; the anchor may just be restarting
    throw err;
  });
  return usdcAssetPromise;
}

export interface AgentAccount {
  publicKey: string;
  secretKey: string;
  isSeeded: boolean;
}

export interface AgentBalances {
  xlm: string;
  usdc: string;
  exists: boolean;
  hasTrustline: boolean;
}

export interface HttpExchangeLog {
  id: string;
  timestamp: string;
  phase: "probe_402" | "retry_paid";
  method: string;
  url: string;
  status: number;
  statusText: string;
  headersSent: Record<string, string>;
  headersReceived: Record<string, string>;
  decodedPaymentRequired?: unknown;
  decodedPaymentSignature?: unknown;
  decodedPaymentResponse?: unknown;
  responseBody?: unknown;
  durationMs: number;
}

export interface CallResult {
  success: boolean;
  status: number;
  exchanges: HttpExchangeLog[];
  priceStroops?: number;
  settlementTxHash?: string;
  rejectedTxHash?: string | null;
  upstreamFailedMessage?: string;
  budgetExceededMessage?: string;
  missingBudgetHeaderMessage?: string;
  errorMessage?: string;
  upstreamBody?: unknown;
}

const LOCAL_STORAGE_KEY = "ramp402_demo_agent_secret";

/**
 * Loads the active demo agent keypair from env var, localStorage, or generates a new one.
 */
export function getOrCreateAgent(): AgentAccount {
  const envSecret = process.env.NEXT_PUBLIC_DEMO_AGENT_SECRET_KEY?.trim();
  if (envSecret) {
    try {
      const kp = Keypair.fromSecret(envSecret);
      return { publicKey: kp.publicKey(), secretKey: kp.secret(), isSeeded: true };
    } catch {
      // Invalid env secret, continue to fallback
    }
  }

  if (typeof window !== "undefined") {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored) {
      try {
        const kp = Keypair.fromSecret(stored);
        return { publicKey: kp.publicKey(), secretKey: kp.secret(), isSeeded: false };
      } catch {
        localStorage.removeItem(LOCAL_STORAGE_KEY);
      }
    }

    const fresh = Keypair.random();
    localStorage.setItem(LOCAL_STORAGE_KEY, fresh.secret());
    return { publicKey: fresh.publicKey(), secretKey: fresh.secret(), isSeeded: false };
  }

  const ephemeral = Keypair.random();
  return { publicKey: ephemeral.publicKey(), secretKey: ephemeral.secret(), isSeeded: false };
}

/**
 * Explicitly generates a new agent keypair and stores it in localStorage.
 */
export function generateNewAgent(): AgentAccount {
  const fresh = Keypair.random();
  if (typeof window !== "undefined") {
    localStorage.setItem(LOCAL_STORAGE_KEY, fresh.secret());
  }
  return { publicKey: fresh.publicKey(), secretKey: fresh.secret(), isSeeded: false };
}

/**
 * Fetches XLM and USDC balances from Stellar testnet Horizon.
 */
export async function getAgentBalances(publicKey: string): Promise<AgentBalances> {
  const server = new Horizon.Server(HORIZON_TESTNET_URL);
  try {
    const account = await server.loadAccount(publicKey);
    let xlm = "0";
    let usdc = "0";
    let hasTrustline = false;
    const issuer = (await usdcAsset()).getIssuer();

    for (const b of account.balances) {
      if (b.asset_type === "native") {
        xlm = b.balance;
      } else if (
        "asset_code" in b &&
        b.asset_code === "USDC" &&
        "asset_issuer" in b &&
        b.asset_issuer === issuer
      ) {
        usdc = b.balance;
        hasTrustline = true;
      }
    }

    return { xlm, usdc, exists: true, hasTrustline };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return { xlm: "0", usdc: "0", exists: false, hasTrustline: false };
    }
    return { xlm: "0", usdc: "0", exists: false, hasTrustline: false };
  }
}

/**
 * Funds an address from Friendbot with 10,000 testnet XLM.
 */
export async function fundWithFriendbot(publicKey: string): Promise<boolean> {
  const url = `${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  if (res.ok) return true;
  const text = await res.text();
  if (text.includes("op_already_exists") || text.includes("already funded")) {
    return true;
  }
  throw new Error(`Friendbot funding refused: ${text.slice(0, 150)}`);
}

/**
 * Establishes USDC trustline and swaps 200 XLM for USDC via testnet SDEX.
 */
export async function fundAgentWithUSDC(agent: AgentAccount): Promise<void> {
  const kp = Keypair.fromSecret(agent.secretKey);
  const server = new Horizon.Server(HORIZON_TESTNET_URL);

  // 1. Ensure Friendbot funded
  await fundWithFriendbot(agent.publicKey);

  // Poll for account existence
  let loaded = false;
  for (let i = 0; i < 5; i++) {
    try {
      await server.loadAccount(agent.publicKey);
      loaded = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!loaded) throw new Error("Agent account not visible on Horizon after Friendbot funding");

  let acc = await server.loadAccount(agent.publicKey);
  const usdc = await usdcAsset();
  const hasTrustline = acc.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === "USDC" &&
      "asset_issuer" in b &&
      b.asset_issuer === usdc.getIssuer(),
  );

  // 2. Add USDC trustline if absent
  if (!hasTrustline) {
    const tx1 = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(TimeoutInfinite)
      .build();
    tx1.sign(kp);
    await server.submitTransaction(tx1);
  }

  // Reload account sequence
  acc = await server.loadAccount(agent.publicKey);

  // 3. Swap 200 XLM for testnet USDC via pathPaymentStrictSend
  const tx2 = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: "200",
        destination: agent.publicKey,
        destAsset: usdc,
        destMin: "1.0",
      })
    )
    .setTimeout(TimeoutInfinite)
    .build();

  tx2.sign(kp);
  await server.submitTransaction(tx2);
}

/**
 * Executes the full live x402 v2 client payment flow against GET /proxy/:proxy_slug.
 *
 * Flow:
 * Exchange 1: GET /proxy/:slug (with X-Agent-Budget) -> 402 PAYMENT-REQUIRED
 * Client: constructs & signs Soroban micropayment -> PAYMENT-SIGNATURE
 * Exchange 2: GET /proxy/:slug (with PAYMENT-SIGNATURE + X-Agent-Budget) -> 200 / 403 / 502
 */
export async function executeX402Call(params: {
  slug: string;
  agent: AgentAccount;
  budgetStroops: number;
  isFirstCall?: boolean;
  omitBudgetHeader?: boolean;
}): Promise<CallResult> {
  const { slug, agent, budgetStroops, omitBudgetHeader } = params;
  const exchanges: HttpExchangeLog[] = [];

  // =========================================================================
  // Exchange 1: Initial probe without payment (expects 402)
  // =========================================================================
  const probeHeaders: Record<string, string> = {
    Accept: "application/json",
  };
  if (!omitBudgetHeader) {
    probeHeaders["X-Agent-Budget"] = String(budgetStroops);
  }

  const t1 = Date.now();
  const probeRes = await callProxy(slug, probeHeaders);
  const d1 = Date.now() - t1;

  const probeResHeaders: Record<string, string> = {};
  probeRes.headers.forEach((v, k) => {
    probeResHeaders[k.toLowerCase()] = v;
  });

  const paymentRequiredHeader =
    probeRes.headers.get("payment-required") ||
    probeResHeaders["payment-required"];

  let decodedPaymentRequired: unknown = null;
  if (paymentRequiredHeader) {
    try {
      decodedPaymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
    } catch {
      try {
        decodedPaymentRequired = JSON.parse(atob(paymentRequiredHeader));
      } catch {
        // failed to parse
      }
    }
  }

  let probeBody: unknown = null;
  try {
    probeBody = await probeRes.clone().json();
  } catch {
    probeBody = await probeRes.clone().text();
  }

  exchanges.push({
    id: `exchange-1-${Date.now()}`,
    timestamp: new Date().toISOString(),
    phase: "probe_402",
    method: "GET",
    url: `/proxy/${slug}`,
    status: probeRes.status,
    statusText: probeRes.statusText || (probeRes.status === 402 ? "Payment Required" : probeRes.status === 400 ? "Bad Request" : ""),
    headersSent: probeHeaders,
    headersReceived: probeResHeaders,
    decodedPaymentRequired,
    responseBody: probeBody,
    durationMs: d1,
  });

  if (probeRes.status !== 402 || !paymentRequiredHeader || !decodedPaymentRequired) {
    const errorBody =
      probeBody && typeof probeBody === "object"
        ? (probeBody as { error?: string; message?: string })
        : null;
    const isMissingBudget =
      errorBody?.error === "missing_budget_header" || probeRes.status === 400;

    return {
      success: false,
      status: probeRes.status,
      exchanges,
      missingBudgetHeaderMessage: isMissingBudget
        ? errorBody?.message ||
          "Mandatory X-Agent-Budget header was omitted. The gateway refused execution to prevent unbounded agent spend."
        : undefined,
      errorMessage: isMissingBudget
        ? "Missing mandatory X-Agent-Budget header: The gateway blocked the call to protect the agent before payment."
        : `Expected 402 Payment Required with PAYMENT-REQUIRED header, got status ${probeRes.status}`,
    };
  }

  // =========================================================================
  // Step 2: Sign x402 payment using agent's keypair
  // =========================================================================
  const reqObj = decodedPaymentRequired as {
    x402Version: number;
    accepts: Array<{
      scheme: string;
      network: `${string}:${string}`;
      asset: string;
      amount: string;
      payTo: string;
      maxTimeoutSeconds: number;
      extra: Record<string, unknown>;
    }>;
  };

  const requirement = reqObj.accepts?.[0];
  if (!requirement) {
    return {
      success: false,
      status: 402,
      exchanges,
      errorMessage: "PAYMENT-REQUIRED header contained no acceptable payment terms",
    };
  }

  const priceStroops = Number(requirement.amount);
  const signer = createEd25519Signer(agent.secretKey, "stellar:testnet");
  const scheme = new ExactStellarScheme(signer, { url: SOROBAN_TESTNET_RPC });

  let paymentSignatureHeader: string;
  let decodedPaymentSignature: unknown = null;
  try {
    const payloadResult = await scheme.createPaymentPayload(reqObj.x402Version, requirement);
    const paymentPayload = {
      x402Version: reqObj.x402Version,
      accepted: requirement,
      payload: payloadResult.payload,
    };
    decodedPaymentSignature = paymentPayload;
    paymentSignatureHeader = encodePaymentSignatureHeader(paymentPayload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      status: 402,
      exchanges,
      priceStroops,
      errorMessage: `Failed to assemble/sign x402 payment: ${msg}`,
    };
  }

  // =========================================================================
  // Exchange 2: Retry with PAYMENT-SIGNATURE
  // =========================================================================
  const retryHeaders: Record<string, string> = {
    Accept: "application/json",
    "PAYMENT-SIGNATURE": paymentSignatureHeader,
  };
  if (!omitBudgetHeader) {
    retryHeaders["X-Agent-Budget"] = String(budgetStroops);
  }

  const t2 = Date.now();
  const retryRes = await callProxy(slug, retryHeaders);
  const d2 = Date.now() - t2;

  const retryResHeaders: Record<string, string> = {};
  retryRes.headers.forEach((v, k) => {
    retryResHeaders[k.toLowerCase()] = v;
  });

  const paymentResponseHeader =
    retryRes.headers.get("payment-response") ||
    retryResHeaders["payment-response"];

  let decodedPaymentResponse: unknown = null;
  if (paymentResponseHeader) {
    try {
      decodedPaymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
    } catch {
      try {
        decodedPaymentResponse = JSON.parse(atob(paymentResponseHeader));
      } catch {
        // ignore
      }
    }
  }

  let retryBody: unknown = null;
  const rawText = await retryRes.text();
  try {
    retryBody = JSON.parse(rawText);
  } catch {
    retryBody = rawText;
  }

  exchanges.push({
    id: `exchange-2-${Date.now()}`,
    timestamp: new Date().toISOString(),
    phase: "retry_paid",
    method: "GET",
    url: `/proxy/${slug}`,
    status: retryRes.status,
    statusText: retryRes.statusText || (retryRes.status === 200 ? "OK" : ""),
    headersSent: retryHeaders,
    headersReceived: retryResHeaders,
    decodedPaymentSignature,
    decodedPaymentResponse,
    responseBody: retryBody,
    durationMs: d2,
  });

  // Check settlement receipt
  const settlementTxHash =
    (decodedPaymentResponse as { transaction?: string })?.transaction || undefined;

  // -------------------------------------------------------------------------
  // Case 200: Success
  // -------------------------------------------------------------------------
  if (retryRes.status === 200) {
    return {
      success: true,
      status: 200,
      exchanges,
      priceStroops,
      settlementTxHash,
      upstreamBody: retryBody,
    };
  }

  // -------------------------------------------------------------------------
  // Case 403: Budget Exceeded (On-chain deliberate enforcement)
  // Rule: BudgetExceededResponse.tx_hash is string | null
  // -------------------------------------------------------------------------
  if (retryRes.status === 403) {
    const errorBody = retryBody as Partial<BudgetExceededResponse>;
    const rejectedTxHash: string | null =
      typeof errorBody?.tx_hash === "string" ? errorBody.tx_hash : null;

    return {
      success: false,
      status: 403,
      exchanges,
      priceStroops,
      rejectedTxHash,
      budgetExceededMessage:
        errorBody?.message ||
        "Spending limit exceeded on-chain for this agent & endpoint pair. Payment cancelled.",
    };
  }

  // -------------------------------------------------------------------------
  // Case 502: Upstream Failed (API unreachable or error)
  // -------------------------------------------------------------------------
  if (retryRes.status === 502) {
    const errorBody = retryBody as Partial<UpstreamFailedResponse>;
    return {
      success: false,
      status: 502,
      exchanges,
      priceStroops,
      settlementTxHash,
      upstreamFailedMessage:
        errorBody?.message || "The upstream seller API returned a non-2xx status or timed out.",
    };
  }

  // Other error
  return {
    success: false,
    status: retryRes.status,
    exchanges,
    priceStroops,
    errorMessage: `Gateway responded with status ${retryRes.status}`,
    upstreamBody: retryBody,
  };
}
