// Talks to the real Soroban RPC and the deployed ramp_ledger. Run with `npm run test:integration`.
// Excluded from the offline `npm test`, and skipped when STELLAR_RPC_URL / STELLAR_NETWORK /
// CONTRACT_ID are not set.
import { Keypair } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { createStellarClient, scv, SorobanError, stellarConfigFromEnv } from "./stellar.js";

dotenv.config({ quiet: true });

const configured = Boolean(process.env.STELLAR_RPC_URL && process.env.STELLAR_NETWORK && process.env.CONTRACT_ID);

describe.skipIf(!configured)("Soroban RPC wiring against the deployed ramp_ledger (network)", () => {
  const client = () => createStellarClient(stellarConfigFromEnv());

  it("get_operator returns the operator this gateway signs with", async () => {
    const c = client();
    const operator = await c.readView<string>("get_operator", []);
    expect(operator).toMatch(/^G[A-Z2-7]{55}$/);
    // Every record_call / settle fails with NotOperator if these two ever differ.
    if (c.operatorAddress) expect(operator).toBe(c.operatorAddress);
  }, 30_000);

  it("get_balance for an address that never earned anything is 0 (as bigint, i128)", async () => {
    const balance = await client().readView<bigint>("get_balance", [scv.address(Keypair.random().publicKey())]);
    expect(balance).toBe(0n);
  }, 30_000);

  it("get_endpoint for an unknown id fails with contract error 2 (EndpointNotFound)", async () => {
    const err = await client()
      .readView("get_endpoint", [scv.u64(2n ** 63n)])
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(SorobanError);
    expect((err as SorobanError).contractErrorCode).toBe(2);
  }, 30_000);

  it("a wrong method name is a host error, not a contract error", async () => {
    const err = (await client()
      .readView("no_such_function", [])
      .then(() => undefined, (e: unknown) => e)) as SorobanError;
    expect(err.message).toMatch(/non-existent contract function/);
    expect(err.contractErrorCode).toBeUndefined();
  }, 30_000);
});
