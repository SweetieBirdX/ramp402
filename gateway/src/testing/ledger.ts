// Test-only ledger: builds REAL Stellar transactions offline (so hashing and signing behave exactly as
// on the network) and fakes only submission, with a return value the test controls.
import { Account, BASE_FEE, Networks, Operation, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";
import type { EndpointRouteDeps } from "../endpointRoutes.js";
import { SorobanError, type InvokeResult } from "../stellar.js";

export const TEST_CONTRACT_ID = "CC73BWETYN2PWAO6YPDLX4H75XUUMH4HDQQJMJYQPY2SW3PE2TEP4CVJ";

export interface FakeLedger extends Pick<EndpointRouteDeps, "ledger"> {
  ledger: EndpointRouteDeps["ledger"];
  built: Array<{ method: string; args: xdr.ScVal[]; source: string }>;
  submitted: string[];
  /** What the next submit returns (as the contract's return value), or throws. */
  nextResult: () => InvokeResult | Promise<InvokeResult>;
  unfundedSources: Set<string>;
}

export function fakeLedger(): FakeLedger {
  let seq = 100n;
  const fake: FakeLedger = {
    built: [],
    submitted: [],
    unfundedSources: new Set(),
    nextResult: () => ({ txHash: "f".repeat(64), returnValue: 1n }),
    ledger: {
      contractId: TEST_CONTRACT_ID,
      async buildUnsignedInvoke(contractId, method, args, sourceAccount) {
        if (fake.unfundedSources.has(sourceAccount)) throw new Error(`Account not found: ${sourceAccount}`);
        fake.built.push({ method, args, source: sourceAccount });
        return new TransactionBuilder(new Account(sourceAccount, (seq++).toString()), {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(Operation.invokeContractFunction({ contract: contractId, function: method, args }))
          .setTimeout(600)
          .build()
          .toXDR();
      },
      transactionHash(envelopeXdr) {
        return Buffer.from(TransactionBuilder.fromXDR(envelopeXdr, Networks.TESTNET).hash()).toString("hex");
      },
      async submitSignedXdr(signedXdr) {
        fake.submitted.push(signedXdr);
        return fake.nextResult();
      },
    },
  };
  return fake;
}

/** A ledger for tests that must never reach it. */
export const unusedLedger: EndpointRouteDeps["ledger"] = {
  contractId: TEST_CONTRACT_ID,
  buildUnsignedInvoke: async () => {
    throw new SorobanError("simulation", "unused in this test");
  },
  transactionHash: () => {
    throw new Error("unused in this test");
  },
  submitSignedXdr: async () => {
    throw new SorobanError("send", "unused in this test");
  },
};
