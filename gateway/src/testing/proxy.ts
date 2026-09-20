// Test-only doubles for /proxy: a contract that enforces ramp_ledger's record_call rules exactly
// (contract/src/lib.rs), and an x402 gate that records whether each payment was settled or cancelled.
import { scValToNative, type xdr } from "@stellar/stellar-sdk";
import type { PaymentGate, VerifiedPayment } from "../payments.js";
import type { ProxyLedger } from "../proxyLedger.js";
import { SorobanError, type StellarClient } from "../stellar.js";

export const OPERATOR = "GBTTFVGWRRZUGDOVCZZYHDJTN5733JT5NCDIQK42Y2PPFUTYYPURQPW6";

type ContractStellar = Pick<StellarClient, "operatorAddress" | "invokeAsOperator" | "submitExpectedRejection">;

const contractError = (code: number) =>
  new SorobanError("simulation", `HostError: Error(Contract, #${code})`, undefined, code);

/** In-memory ramp_ledger: Endpoints, Budgets, SellerBalances, TreasuryTotal, same panics, same codes. */
export function fakeContract(endpoints: Record<string, bigint>) {
  const budgets = new Map<string, { allocated: bigint; spent: bigint }>();
  const settles: Array<{ endpointId: string; amount: bigint }> = [];
  const recordCalls: Array<{ agent: string; endpointId: string; budget: bigint }> = [];
  const rejections: string[] = [];
  let treasury = 0n;
  let seq = 0;
  let proofFails = false;

  const stellar: ContractStellar = {
    operatorAddress: OPERATOR,
    async invokeAsOperator(method: string, args: xdr.ScVal[]) {
      const native = args.map((a) => scValToNative(a));
      if (native[0] !== OPERATOR) throw contractError(5); // NotOperator
      if (method === "record_call") {
        const [, agent, id, budget] = native as [string, string, bigint, bigint];
        const price = endpoints[String(id)];
        if (price === undefined) throw contractError(2); // EndpointNotFound
        const key = `${agent}|${id}`;
        let entry = budgets.get(key);
        if (!entry) {
          if (budget <= 0n) throw contractError(4); // InvalidAmount — first call only
          entry = { allocated: budget, spent: 0n }; // frozen here, never re-read
        }
        if (entry.spent + price > entry.allocated) throw contractError(1); // SpendingLimitExceeded
        entry.spent += price;
        budgets.set(key, entry);
        recordCalls.push({ agent, endpointId: String(id), budget });
        return { txHash: `record-${++seq}`, returnValue: undefined };
      }
      if (method === "settle") {
        const [, id, amount] = native as [string, bigint, bigint];
        if (endpoints[String(id)] === undefined) throw contractError(2);
        if (amount <= 0n) throw contractError(4);
        treasury += amount / 100n;
        settles.push({ endpointId: String(id), amount });
        return { txHash: `settle-${++seq}`, returnValue: undefined };
      }
      throw new Error(`fake contract: unexpected ${method}`);
    },
    async submitExpectedRejection(method: string, args: xdr.ScVal[]) {
      if (proofFails) throw new Error("rpc unavailable");
      const hash = `rejected-${++seq}`;
      rejections.push(`${method}:${String(scValToNative(args[1]!))}:${hash}`);
      return hash;
    },
  };

  return {
    stellar,
    budgets,
    settles,
    recordCalls,
    rejections,
    budgetOf: (agent: string, endpointId: string) => budgets.get(`${agent}|${endpointId}`),
    treasury: () => treasury,
    setProofFails: (v: boolean) => void (proofFails = v),
  };
}

/**
 * x402 double. `PAYMENT-SIGNATURE: agent=<G…>` verifies as that payer; `invalid` fails verification;
 * no header → 402 with PAYMENT-REQUIRED. Every verified payment ends as settled or cancelled.
 */
export function fakeGate() {
  const settled: string[] = [];
  const cancelled: Array<{ payer: string; status: number }> = [];
  let seq = 0;
  let settleFails = false;
  let cancelFails = false;

  const gate: PaymentGate = {
    async process(req, priceStroops) {
      const sig = req.get("payment-signature");
      const required = { status: 402, headers: { "PAYMENT-REQUIRED": `fake:${priceStroops}` }, body: {} };
      if (!sig) return { kind: "respond", response: required };
      if (!sig.startsWith("agent=")) return { kind: "respond", response: { ...required, body: { error: "invalid_payment" } } };
      const payer = sig.slice("agent=".length);
      const payment: VerifiedPayment = {
        payer,
        async settle() {
          if (settleFails) return { ok: false, reason: "facilitator down", response: { status: 402, headers: {}, body: { error: "settle_failed" } } };
          const txHash = `payment-${++seq}`;
          settled.push(payer);
          return { ok: true, headers: { "PAYMENT-RESPONSE": `receipt:${txHash}` }, txHash };
        },
        async cancel(status) {
          cancelled.push({ payer, status });
          // A facilitator that will not take the cancellation. Nothing was charged either way — the
          // payment is simply never settled — so the refusal the caller already decided must stand.
          if (cancelFails) throw new Error("facilitator refused the cancellation");
        },
      };
      return { kind: "verified", payment };
    },
  };
  return {
    gate,
    settled,
    cancelled,
    setSettleFails: (v: boolean) => void (settleFails = v),
    setCancelFails: (v: boolean) => void (cancelFails = v),
  };
}

/** For apps whose tests never reach /proxy. */
export const unusedGate: PaymentGate = {
  process: async () => {
    throw new Error("unused in this test");
  },
};
export const unusedProxyLedger: ProxyLedger = {
  recordCall: async () => {
    throw new Error("unused in this test");
  },
  settle: async () => {
    throw new Error("unused in this test");
  },
};
