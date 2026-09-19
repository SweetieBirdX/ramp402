import { Keypair, Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

export interface SignRawHashOptions {
  address: string;
  chainType: "stellar";
  hash: `0x${string}`;
}

export type SignRawHashFn = (
  options: SignRawHashOptions
) => Promise<{ signature: string }>;

/**
 * Signs an unsigned Stellar transaction XDR with Privy's embedded wallet.
 *
 * Spike S3 verified:
 * 1. Parse transaction with Networks.TESTNET
 * 2. Hash the transaction envelope (32 bytes)
 * 3. Call Privy's signRawHash with 0x-prefixed hex hash
 * 4. Construct xdr.DecoratedSignature with Keypair.fromPublicKey(address).signatureHint()
 * 5. Push decorated signature to tx.signatures and export signed XDR
 */
export async function signTransactionWithPrivy(
  unsignedXdr: string,
  stellarAddress: string,
  signRawHash: SignRawHashFn,
  networkPassphrase: string = Networks.TESTNET
): Promise<string> {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  const txHashBytes = tx.hash();
  const hexHash: `0x${string}` = `0x${Buffer.from(txHashBytes).toString("hex")}`;

  const { signature } = await signRawHash({
    address: stellarAddress,
    chainType: "stellar",
    hash: hexHash,
  });

  const kp = Keypair.fromPublicKey(stellarAddress);
  const hint = kp.signatureHint();
  const rawSig = Buffer.from(
    signature.startsWith("0x") ? signature.slice(2) : signature,
    "hex"
  );

  const decoratedSig = new xdr.DecoratedSignature({
    hint,
    signature: rawSig,
  });

  // Attach signature
  tx.signatures.push(decoratedSig);

  return tx.toXDR();
}
