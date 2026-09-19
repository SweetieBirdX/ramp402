/**
 * A headless x402 agent, for `verify-e2e.ts`.
 *
 * The same flow as the browser agent console (`frontend/lib/agent.ts`), without the browser: no
 * localStorage, no React, and a keypair that lives only for the run. It pays for real — a genuine
 * x402 v2 exchange against the facilitator, settling actual testnet USDC.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TimeoutInfinite,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { FRIENDBOT_URL, HORIZON_URL, RPC_URL } from "./chain.js";

const horizon = new Horizon.Server(HORIZON_URL);

export interface Agent {
  keypair: Keypair;
  publicKey: string;
}

export function newAgent(): Agent {
  const keypair = Keypair.random();
  return { keypair, publicKey: keypair.publicKey() };
}

/**
 * Give the agent XLM, a USDC trustline and some USDC.
 *
 * The USDC comes from the testnet DEX via a path payment, not from us: an agent in the real world
 * funds itself, and having the platform pool hand it money would quietly make the test circular.
 *
 * `usdcIssuer` is passed in rather than hardcoded — it is read from the anchor's stellar.toml by
 * the caller (§1.5).
 */
export async function fundAgent(agent: Agent, usdcIssuer: string, sendXlm = "200"): Promise<string> {
  const usdc = new Asset("USDC", usdcIssuer);

  const response = await fetch(`${FRIENDBOT_URL}/?addr=${agent.publicKey}`);
  if (!response.ok) {
    const body = await response.text();
    if (!body.includes("op_already_exists")) {
      throw new Error(`Friendbot refused to fund the agent: ${response.status}`);
    }
  }

  // Horizon can lag a moment behind Friendbot.
  let account: Awaited<ReturnType<typeof horizon.loadAccount>> | undefined;
  for (let attempt = 0; attempt < 6 && !account; attempt += 1) {
    try {
      account = await horizon.loadAccount(agent.publicKey);
    } catch {
      await sleep(1_000);
    }
  }
  if (!account) throw new Error("the agent account never appeared on Horizon");

  const hasTrustline = account.balances.some(
    (b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === usdcIssuer,
  );
  if (!hasTrustline) {
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(TimeoutInfinite)
      .build();
    tx.sign(agent.keypair);
    await horizon.submitTransaction(tx);
    account = await horizon.loadAccount(agent.publicKey);
  }

  const swap = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: sendXlm,
        destination: agent.publicKey,
        destAsset: usdc,
        destMin: "1.0",
      }),
    )
    .setTimeout(TimeoutInfinite)
    .build();
  swap.sign(agent.keypair);
  await horizon.submitTransaction(swap);

  return await usdcBalance(agent.publicKey, usdcIssuer);
}

export async function usdcBalance(publicKey: string, usdcIssuer: string): Promise<string> {
  const account = await horizon.loadAccount(publicKey);
  const found = account.balances.find(
    (b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === usdcIssuer,
  ) as { balance: string } | undefined;
  return found?.balance ?? "0";
}

export interface ProxyCallResult {
  /** The status of the SECOND request — the one carrying payment. */
  status: number;
  body: unknown;
  /** The status of the first, unpaid request. 402 when the endpoint is behind x402. */
  probeStatus: number;
  /** Set when the gateway asked for payment and the agent produced one. */
  paid: boolean;
}

/**
 * One paid call: probe, and if the answer is 402, sign a payment and retry.
 *
 * `budgetStroops` goes in `X-Agent-Budget`, which is ours rather than x402's. It is mandatory on an
 * (agent, endpoint) pair's first call and ignored afterwards (§1.3); pass `omitBudget` to prove the
 * gateway refuses a first call without it.
 */
export async function payForCall(options: {
  gatewayUrl: string;
  slug: string;
  agent: Agent;
  budgetStroops?: number;
  omitBudget?: boolean;
}): Promise<ProxyCallResult> {
  const { gatewayUrl, slug, agent, budgetStroops, omitBudget } = options;
  const url = `${gatewayUrl.replace(/\/+$/, "")}/proxy/${slug}`;

  const headers: Record<string, string> = { accept: "application/json" };
  if (!omitBudget && budgetStroops !== undefined) headers["X-Agent-Budget"] = String(budgetStroops);

  const probe = await fetch(url, { headers });
  const probeStatus = probe.status;

  if (probeStatus !== 402) {
    return { status: probeStatus, body: await readBody(probe), probeStatus, paid: false };
  }

  const required = probe.headers.get("payment-required");
  if (!required) throw new Error("the gateway answered 402 without a PAYMENT-REQUIRED header");

  const decoded = decodePaymentRequiredHeader(required) as {
    x402Version: number;
    accepts: unknown[];
  };
  const requirement = decoded.accepts?.[0];
  if (!requirement) throw new Error("the 402 named no payment requirement the agent could satisfy");

  const signer = createEd25519Signer(agent.keypair.secret(), "stellar:testnet");
  const scheme = new ExactStellarScheme(signer, { url: RPC_URL });
  const signed = await scheme.createPaymentPayload(decoded.x402Version, requirement as never);

  // The header carries the whole envelope — version, the requirement being accepted, and the
  // signed payload — not just the signature. Same shape the browser client builds.
  const paymentPayload = {
    x402Version: decoded.x402Version,
    accepted: requirement,
    payload: signed.payload,
  };

  const paidResponse = await fetch(url, {
    headers: {
      ...headers,
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload as never),
    },
  });

  return { status: paidResponse.status, body: await readBody(paidResponse), probeStatus, paid: true };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
