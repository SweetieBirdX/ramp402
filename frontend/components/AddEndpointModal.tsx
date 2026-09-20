"use client";

import { useState, useId } from "react";
import { useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { prepareEndpoint, submitEndpoint, getGatewayUrl, ApiError } from "@/lib/api";
import { displayToStroops, stroopsToDisplay } from "@/lib/format";
import { signTransactionWithPrivy } from "@/lib/signing";
import type { SubmitEndpointResponse } from "@/lib/types";

// -------------------------------------------------------------------------------------------------
// Inline SVG Icons
// -------------------------------------------------------------------------------------------------

function CloseIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function CheckCircleIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function ClipboardCopyIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

export interface AddEndpointModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (endpoint: SubmitEndpointResponse) => void;
  stellarAddress: string | null;
}

type StepState = "idle" | "preparing" | "signing" | "submitting" | "success" | "error";

interface ErrorInfo {
  title: string;
  message: string;
  isDraftExpired?: boolean;
}

export default function AddEndpointModal({
  isOpen,
  onClose,
  onSuccess,
  stellarAddress,
}: AddEndpointModalProps) {
  const modalTitleId = useId();
  const { signRawHash } = useSignRawHash();

  const [upstreamUrl, setUpstreamUrl] = useState("");
  const [priceUsdc, setPriceUsdc] = useState("0.50"); // the demo price (scripts/lib/demo.ts DEMO_PRICE_STROOPS)
  const [step, setStep] = useState<StepState>("idle");
  const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
  const [successResult, setSuccessResult] = useState<SubmitEndpointResponse | null>(null);
  const [copiedProxy, setCopiedProxy] = useState(false);

  if (!isOpen) return null;

  // Convert decimal USDC string to integer stroops (§1.1)
  let stroopsPreview: number | null = null;
  let priceFormatError: string | null = null;
  try {
    if (priceUsdc.trim()) {
      stroopsPreview = displayToStroops(priceUsdc);
      if (stroopsPreview <= 0) {
        priceFormatError = "Price must be greater than 0 USDC";
      }
    }
  } catch {
    priceFormatError = "Invalid decimal number format";
  }

  const handleCopyProxy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedProxy(true);
      setTimeout(() => setCopiedProxy(false), 2000);
    } catch (err) {
      console.error("Failed to copy proxy URL:", err);
    }
  };

  const resetForm = () => {
    setStep("idle");
    setErrorInfo(null);
    setSuccessResult(null);
    setUpstreamUrl("");
    setPriceUsdc("0.50");
    setCopiedProxy(false);
  };

  const handleClose = () => {
    if (step === "preparing" || step === "signing" || step === "submitting") {
      return; // prevent accidental close while transaction is in flight
    }
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stellarAddress) {
      setErrorInfo({
        title: "Wallet Not Ready",
        message: "Your Stellar wallet is not ready. Please wait for provisioning to complete.",
      });
      return;
    }

    const trimmedUrl = upstreamUrl.trim();
    if (!trimmedUrl) {
      setErrorInfo({
        title: "Validation Error",
        message: "Please enter a valid upstream URL.",
      });
      return;
    }

    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Protocol must be http: or https:");
      }
    } catch {
      setErrorInfo({
        title: "Invalid URL",
        message: "The upstream URL must be a valid HTTP or HTTPS address (e.g. https://api.weather.com/v1).",
      });
      return;
    }

    let stroops: number;
    try {
      stroops = displayToStroops(priceUsdc);
      if (stroops <= 0) {
        throw new Error("Price must be > 0");
      }
    } catch {
      setErrorInfo({
        title: "Invalid Price",
        message: "Please enter a valid positive decimal price in USDC (e.g. 0.05).",
      });
      return;
    }

    setErrorInfo(null);

    // -------------------------------------------------------------------------------------------
    // Step 2.a: prepareEndpoint() -> { unsigned_xdr, draft_id }
    // -------------------------------------------------------------------------------------------
    setStep("preparing");
    let unsignedXdr: string;
    let draftId: string;

    try {
      const prep = await prepareEndpoint(trimmedUrl, stroops);
      unsignedXdr = prep.unsigned_xdr;
      draftId = prep.draft_id;
    } catch (err: unknown) {
      setStep("error");
      if (err instanceof ApiError) {
        if (err.code === "invalid_request") {
          setErrorInfo({
            title: "Validation Error from Gateway",
            message: `The gateway rejected the input: ${err.message}`,
          });
          return;
        }
        if (err.status === 501) {
          setErrorInfo({
            title: "Feature Not Implemented",
            message: "The gateway has not yet implemented POST /api/endpoints/prepare (501).",
          });
          return;
        }
      }
      setErrorInfo({
        title: "Preparation Failed",
        message: err instanceof Error ? err.message : "Failed to prepare unsigned transaction draft.",
      });
      return;
    }

    // -------------------------------------------------------------------------------------------
    // Step 2.b: Have Privy sign the XDR
    // -------------------------------------------------------------------------------------------
    setStep("signing");
    let signedXdr: string;

    try {
      // The seller's key lives in their Privy embedded wallet and nowhere else. There is
      // deliberately no local signer to fall back to: one used to live here, signing with a
      // keypair hardcoded in this file, which both bypassed the flow being demonstrated and put a
      // secret key in a public repository.
      if (!stellarAddress) {
        throw new Error("No wallet connected. Sign in with Privy before registering an endpoint.");
      }
      signedXdr = await signTransactionWithPrivy(unsignedXdr, stellarAddress, signRawHash);
    } catch (err: unknown) {
      setStep("error");
      const errString = err instanceof Error ? err.message : String(err);
      const isRejection =
        errString.toLowerCase().includes("reject") ||
        errString.toLowerCase().includes("cancel") ||
        errString.toLowerCase().includes("dismiss") ||
        errString.toLowerCase().includes("user denied");

      if (isRejection) {
        setErrorInfo({
          title: "Signature Rejected",
          message: "You cancelled or rejected the transaction signature in Privy. No on-chain changes were made.",
        });
      } else {
        setErrorInfo({
          title: "Signing Failed",
          message: `Privy embedded wallet could not sign the transaction: ${errString}`,
        });
      }
      return;
    }

    // -------------------------------------------------------------------------------------------
    // Step 2.c: submitEndpoint(draft_id, signed_xdr)
    // -------------------------------------------------------------------------------------------
    setStep("submitting");

    try {
      const submitRes = await submitEndpoint(draftId, signedXdr);
      setSuccessResult(submitRes);
      setStep("success");
      onSuccess(submitRes);
    } catch (err: unknown) {
      setStep("error");
      if (err instanceof ApiError) {
        const msg = err.message.toLowerCase();
        if (
          err.code === "not_found" ||
          msg.includes("draft") ||
          msg.includes("expired")
        ) {
          setErrorInfo({
            title: "Draft Expired",
            message: "The transaction draft expired on the gateway before submission. Please try again.",
            isDraftExpired: true,
          });
          return;
        }

        if (err.status === 400 || err.code === "invalid_request") {
          setErrorInfo({
            title: "Validation Error",
            message: `Gateway rejected the transaction: ${err.message}`,
          });
          return;
        }

        if (err.status === 502 || msg.includes("soroban") || msg.includes("failed")) {
          setErrorInfo({
            title: "Submission Failed On-Chain",
            message: `The Stellar network rejected the transaction: ${err.message}. Please verify your balance and network status.`,
          });
          return;
        }
      }

      setErrorInfo({
        title: "Submission Error",
        message: err instanceof Error ? err.message : "Failed to submit signed transaction to network.",
      });
    }
  };

  const gatewayUrl = getGatewayUrl();

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-neutral-900/60 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={modalTitleId}
    >
      <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-neutral-200 overflow-hidden transition-all">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 bg-neutral-50/50">
          <div>
            <h2 id={modalTitleId} className="text-base font-bold text-neutral-900">
              Register Monetized Endpoint
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Two-step on-chain registration: unsigned XDR preparation and Privy Ed25519 signing.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={step === "preparing" || step === "signing" || step === "submitting"}
            className="text-neutral-400 hover:text-neutral-600 rounded-lg p-1.5 transition-colors disabled:opacity-30 cursor-pointer"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Progress Stepper Bar (visible when in progress or error) */}
        {step !== "idle" && step !== "success" ? (
          <div className="px-6 pt-5 pb-2 bg-neutral-50 border-b border-neutral-100">
            <div className="flex items-center justify-between text-xs font-semibold">
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${
                    step === "preparing"
                      ? "bg-neutral-900 text-white animate-pulse"
                      : "bg-emerald-600 text-white"
                  }`}
                >
                  {step === "preparing" ? "1" : "✓"}
                </span>
                <span className={step === "preparing" ? "text-neutral-900 font-bold" : "text-neutral-600"}>
                  Prepare XDR
                </span>
              </div>
              <div className="h-0.5 w-8 bg-neutral-200" />
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${
                    step === "signing"
                      ? "bg-neutral-900 text-white animate-pulse"
                      : step === "submitting"
                      ? "bg-emerald-600 text-white"
                      : "bg-neutral-200 text-neutral-600"
                  }`}
                >
                  {step === "submitting" ? "✓" : "2"}
                </span>
                <span
                  className={
                    step === "signing"
                      ? "text-neutral-900 font-bold"
                      : step === "submitting"
                      ? "text-neutral-600"
                      : "text-neutral-400"
                  }
                >
                  Privy Sign
                </span>
              </div>
              <div className="h-0.5 w-8 bg-neutral-200" />
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${
                    step === "submitting"
                      ? "bg-neutral-900 text-white animate-pulse"
                      : "bg-neutral-200 text-neutral-600"
                  }`}
                >
                  3
                </span>
                <span className={step === "submitting" ? "text-neutral-900 font-bold" : "text-neutral-400"}>
                  On-Chain Confirm
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {/* Modal Body */}
        <div className="p-6">
          {/* STATE: SUCCESS (Requirement 3) */}
          {step === "success" && successResult ? (
            <div className="space-y-5">
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-3">
                <CheckCircleIcon className="h-6 w-6 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-bold text-emerald-900">
                    Endpoint Registered Successfully!
                  </h3>
                  <p className="text-xs text-emerald-700 mt-0.5">
                    Assigned on-chain <strong className="font-mono">ID #{successResult.endpoint_id}</strong> by the ramp_ledger contract.
                  </p>
                </div>
              </div>

              {/* Requirement 3: Prominent Proxy URL with Copy Button */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-neutral-600 block">
                  Agent Proxy URL (x402 Protected)
                </label>
                <div className="bg-neutral-100 border border-neutral-300 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <code className="font-mono text-xs text-neutral-900 font-semibold break-all select-all">
                    {`${gatewayUrl}/proxy/${successResult.proxy_slug}`}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopyProxy(`${gatewayUrl}/proxy/${successResult.proxy_slug}`)}
                    className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold transition-all shadow-xs shrink-0 cursor-pointer ${
                      copiedProxy
                        ? "bg-emerald-600 text-white hover:bg-emerald-700 ring-2 ring-emerald-300"
                        : "bg-neutral-900 text-white hover:bg-neutral-800"
                    }`}
                  >
                    {copiedProxy ? (
                      <>
                        <CheckIcon className="h-3.5 w-3.5" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <ClipboardCopyIcon className="h-3.5 w-3.5" />
                        <span>Copy Proxy URL</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-[11px] text-neutral-500">
                  Give this URL to autonomous agents. Requests without x402 payment headers will receive a 402 Payment Required response.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs bg-neutral-50 p-3 rounded-lg border border-neutral-200">
                <div>
                  <span className="text-neutral-500 block">Upstream Target:</span>
                  <span className="font-semibold text-neutral-800 truncate block">
                    {successResult.upstream_url}
                  </span>
                </div>
                <div>
                  <span className="text-neutral-500 block">Price per call:</span>
                  <span className="font-bold text-neutral-900 font-mono">
                    {stroopsToDisplay(successResult.price_stroops)} USDC
                  </span>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2 text-xs font-semibold text-neutral-700 bg-white border border-neutral-300 rounded-md hover:bg-neutral-50 transition-colors cursor-pointer"
                >
                  Register Another
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-semibold text-white bg-neutral-900 rounded-md hover:bg-neutral-800 transition-colors cursor-pointer"
                >
                  View in Dashboard
                </button>
              </div>
            </div>
          ) : step === "preparing" || step === "signing" || step === "submitting" ? (
            /* STATE: IN PROGRESS (Requirement 2 clear progress) */
            <div className="py-10 text-center space-y-4">
              <div className="inline-block h-10 w-10 border-3 border-neutral-200 border-t-neutral-900 rounded-full animate-spin" />
              <div>
                <h3 className="text-base font-bold text-neutral-900">
                  {step === "preparing" && "Step 1: Preparing Transaction Draft"}
                  {step === "signing" && "Step 2: Signing with Privy Embedded Wallet"}
                  {step === "submitting" && "Step 3: Submitting On-Chain to Stellar"}
                </h3>
                <p className="text-xs text-neutral-500 mt-1 max-w-sm mx-auto">
                  {step === "preparing" &&
                    "Connecting to the gateway to build the unsigned Soroban register_endpoint invocation XDR."}
                  {step === "signing" &&
                    "Privy non-custodial wallet is signing the transaction hash. Please wait a few seconds (signing takes 1-3s and has not frozen)..."}
                  {step === "submitting" &&
                    "Submitting signed XDR to Soroban RPC on Stellar testnet and waiting for confirmation."}
                </p>
              </div>
            </div>
          ) : (
            /* STATE: FORM (Requirement 1 & Requirement 4) */
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Error Banner (Requirement 4) */}
              {errorInfo ? (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs space-y-1">
                  <p className="font-bold text-red-900">{errorInfo.title}</p>
                  <p className="text-red-700">{errorInfo.message}</p>
                  {errorInfo.isDraftExpired ? (
                    <p className="text-red-600 text-[11px] pt-1">
                      Tip: Transaction drafts expire after 5 minutes for security. Click Submit below to generate a fresh draft.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* Upstream URL Field */}
              <div>
                <label
                  htmlFor="upstream_url"
                  className="block text-xs font-bold uppercase tracking-wider text-neutral-700"
                >
                  Upstream API URL
                </label>
                <input
                  id="upstream_url"
                  type="url"
                  required
                  placeholder="https://api.example.com/v1/forecast"
                  value={upstreamUrl}
                  onChange={(e) => setUpstreamUrl(e.target.value)}
                  className="mt-1.5 block w-full px-3 py-2 text-sm border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900 bg-white"
                />
                <p className="mt-1 text-[11px] text-neutral-500">
                  The actual HTTP target behind the paywall that the proxy will forward paid requests to.
                </p>
              </div>

              {/* Price USDC Field (Requirement 1: decimal input -> integer stroops) */}
              <div>
                <label
                  htmlFor="price_usdc"
                  className="block text-xs font-bold uppercase tracking-wider text-neutral-700"
                >
                  Price per Call (USDC)
                </label>
                <div className="relative mt-1.5 rounded-md shadow-2xs">
                  <input
                    id="price_usdc"
                    type="text"
                    inputMode="decimal"
                    required
                    placeholder="0.10"
                    value={priceUsdc}
                    onChange={(e) => setPriceUsdc(e.target.value)}
                    className="block w-full px-3 py-2 text-sm border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900 bg-white font-mono"
                  />
                  <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                    <span className="text-xs font-bold text-neutral-500">USDC</span>
                  </div>
                </div>

                {/* Real-time stroop conversion preview (§1.1) */}
                <div className="mt-1.5 flex items-center justify-between text-[11px]">
                  {priceFormatError ? (
                    <span className="text-red-600 font-medium">{priceFormatError}</span>
                  ) : stroopsPreview !== null ? (
                    <span className="text-neutral-600 font-mono">
                      = <strong className="text-neutral-900">{stroopsPreview.toLocaleString()}</strong> stroops
                    </span>
                  ) : (
                    <span className="text-neutral-400">Enter price in USDC</span>
                  )}
                  <span className="text-neutral-400">1 USDC = 10,000,000 stroops</span>
                </div>
              </div>

              {/* Signing Notice */}
              <div className="p-3 bg-neutral-50 border border-neutral-200 rounded-md text-[11px] text-neutral-600 space-y-1">
                <p className="font-semibold text-neutral-800">Non-Custodial On-Chain Authorization:</p>
                <p>
                  Submitting will request a signature from your embedded Stellar wallet (
                  <code className="font-mono text-neutral-700">
                    {stellarAddress ? `${stellarAddress.slice(0, 6)}...${stellarAddress.slice(-6)}` : "..."}
                  </code>
                  ) to register the endpoint directly on the <strong className="font-semibold">ramp_ledger</strong> contract.
                </p>
              </div>

              {/* Form Action Buttons */}
              <div className="pt-3 flex items-center justify-end gap-3 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-semibold text-neutral-700 bg-white border border-neutral-300 rounded-md hover:bg-neutral-50 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={Boolean(priceFormatError) || !upstreamUrl.trim()}
                  className="px-5 py-2 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-md shadow-xs transition-colors cursor-pointer"
                >
                  Sign &amp; Register Endpoint
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
