// Talks to the real Soroban RPC. Run with `npm run test:integration`. Excluded from the offline
// `npm test`, and skipped when STELLAR_RPC_URL / STELLAR_NETWORK / CONTRACT_ID are not set.
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { createStellarClient, scv, SorobanError, stellarConfigFromEnv } from "./stellar.js";

dotenv.config({ quiet: true });

const configured = Boolean(process.env.STELLAR_RPC_URL && process.env.STELLAR_NETWORK && process.env.CONTRACT_ID);

async function readViewError(method: string, args: Parameters<typeof scv.u64>[0][] = []): Promise<SorobanError> {
  const client = createStellarClient(stellarConfigFromEnv());
  const err = await client.readView(method, args.map(scv.u64)).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SorobanError);
  return err as SorobanError;
}

describe.skipIf(!configured)("Soroban RPC wiring (network)", () => {
  // TODO(real contract): every function of the deployed stub is todo!(), so get_endpoint traps.
  // Once the real ramp_ledger is deployed, register an endpoint and assert readView returns
  // { seller, price } instead. Until then this trap is the proof that simulation reached our
  // contract and ran get_endpoint with a correctly encoded u64: a wrong CONTRACT_ID, method name or
  // argument count each fails with a different host error (the other two tests pin that down).
  it("readView('get_endpoint', [u64]) reaches the contract and executes get_endpoint", async () => {
    const err = await readViewError("get_endpoint", [1n]);
    expect(err.stage).toBe("simulation");
    expect(err.message).toMatch(/fn_call, C[A-Z2-7]{55}, get_endpoint\], data:1\b/);
    expect(err.message).toMatch(/VM call trapped: UnreachableCodeReached/);
  }, 30_000);

  it("a wrong method name fails differently from the stub trap", async () => {
    const err = await readViewError("no_such_function");
    expect(err.message).toMatch(/non-existent contract function/);
  }, 30_000);

  it("a wrong argument count fails differently from the stub trap", async () => {
    const err = await readViewError("get_endpoint");
    expect(err.message).toMatch(/MismatchingParameterLen/);
  }, 30_000);
});
