// The two contract writes behind every paid call (CONVENTIONS.md §1.2), signed by the operator.
// The budget rules live in the contract; this module only translates its answers.
import { Keypair } from "@stellar/stellar-sdk";
import { scv, SorobanError, type StellarClient } from "./stellar.js";

const SPENDING_LIMIT_EXCEEDED = 1;
const ENDPOINT_NOT_FOUND = 2;
const INVALID_AMOUNT = 4;

export type RecordCallOutcome =
  | { kind: "recorded"; txHash: string }
  /** First call for the (agent, endpoint) pair and no X-Agent-Budget to freeze. */
  | { kind: "missing_budget" }
  /** spent + price > allocated. `rejectedTxHash` is the on-chain refusal, or null if proving it failed. */
  | { kind: "budget_exceeded"; rejectedTxHash: string | null }
  | { kind: "endpoint_not_found" };

export interface ProxyLedger {
  /**
   * record_call(operator, agent, endpoint_id, budget). `budget` is the X-Agent-Budget value, or 0n when
   * the header is absent: the contract reads it only on the pair's first call and rejects 0 there with
   * InvalidAmount — which is how "first call without a budget" is detected, by the chain itself.
   */
  recordCall(agent: string, endpointId: string, budget: bigint, priceStroops: number): Promise<RecordCallOutcome>;
  /** settle(operator, endpoint_id, amount): 1% treasury, 99% seller. Resolves with the tx hash. */
  settle(endpointId: string, amountStroops: number): Promise<string>;
}

export function createProxyLedger(
  stellar: Pick<StellarClient, "operatorAddress" | "invokeAsOperator" | "submitExpectedRejection">,
  log: (line: string) => void = console.error,
): ProxyLedger {
  const operator = () => {
    const address = stellar.operatorAddress;
    if (!address) throw new Error("OPERATOR_SECRET_KEY is not configured");
    return address;
  };

  return {
    async recordCall(agent, endpointId, budget, priceStroops) {
      const args = [scv.address(operator()), scv.address(agent), scv.u64(endpointId), scv.i128(budget)];
      try {
        const { txHash } = await stellar.invokeAsOperator("record_call", args);
        return { kind: "recorded", txHash };
      } catch (err) {
        if (!(err instanceof SorobanError)) throw err;
        switch (err.contractErrorCode) {
          case INVALID_AMOUNT:
            if (budget <= 0n) return { kind: "missing_budget" };
            break;
          case ENDPOINT_NOT_FOUND:
            return { kind: "endpoint_not_found" };
          case SPENDING_LIMIT_EXCEEDED: {
            // Enforcement is already done: the call is refused. What follows only puts that refusal
            // on-chain so the 403 can carry a hash anyone can look up; its failure never un-refuses.
            // The footprint comes from the same call for a throwaway agent with budget = price.
            const footprintArgs = [scv.address(operator()), scv.address(Keypair.random().publicKey()), scv.u64(endpointId), scv.i128(priceStroops)];
            try {
              return { kind: "budget_exceeded", rejectedTxHash: await stellar.submitExpectedRejection("record_call", args, footprintArgs) };
            } catch (proofErr) {
              log(`budget_exceeded for ${agent} on endpoint ${endpointId}; could not record the rejection on-chain: ${String(proofErr)}`);
              return { kind: "budget_exceeded", rejectedTxHash: null };
            }
          }
        }
        throw err;
      }
    },

    async settle(endpointId, amountStroops) {
      const { txHash } = await stellar.invokeAsOperator("settle", [scv.address(operator()), scv.u64(endpointId), scv.i128(amountStroops)]);
      return txHash;
    },
  };
}
