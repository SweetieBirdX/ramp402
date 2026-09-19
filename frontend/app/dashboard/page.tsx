"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import {
  bootstrapSeller,
  getBalance,
  listEndpoints,
  listCalls,
  getGatewayUrl,
  ApiError,
} from "@/lib/api";
import { stroopsToDisplay } from "@/lib/format";
import type { EndpointSummary, GetBalanceResponse, CallSummary } from "@/lib/types";
import AddEndpointModal from "@/components/AddEndpointModal";
import WithdrawModal, { type CompletedWithdrawalRecord } from "@/components/WithdrawModal";

// -------------------------------------------------------------------------------------------------
// Inline SVG Icons (zero external dependencies)
// -------------------------------------------------------------------------------------------------

function ClipboardCopyIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
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
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2.5}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ChevronDownIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ExternalLinkIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
      />
    </svg>
  );
}

function RefreshIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

// -------------------------------------------------------------------------------------------------
// Dashboard Page Component
// -------------------------------------------------------------------------------------------------

export default function DashboardPage() {
  const {
    ready,
    authenticated,
    stellarAddress,
    email,
    isCreatingWallet,
    login,
  } = useAuth();
  const router = useRouter();

  // Core dashboard state
  const [balance, setBalance] = useState<GetBalanceResponse | null>(null);
  const [balanceError, setBalanceError] = useState<ApiError | Error | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointSummary[] | null>(null);
  const [endpointsError, setEndpointsError] = useState<ApiError | Error | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);

  // Setup / bootstrap state (requirement 1)
  const [isSettingUpAccount, setIsSettingUpAccount] = useState(false);
  const [bootstrapSuccess, setBootstrapSuccess] = useState(false);
  const [setupError, setSetupError] = useState<ApiError | Error | null>(null);
  const hasBootstrappedRef = useRef(false);

  // Per-endpoint call log accordion state (requirement 4)
  const [expandedEndpoints, setExpandedEndpoints] = useState<Record<string, boolean>>({});
  const [callsByEndpoint, setCallsByEndpoint] = useState<Record<string, CallSummary[]>>({});
  const [loadingCalls, setLoadingCalls] = useState<Record<string, boolean>>({});
  const [callsError, setCallsError] = useState<Record<string, string>>({});

  // Obvious copy button state (requirement 3)
  const [copiedEndpointId, setCopiedEndpointId] = useState<string | null>(null);

  // Add endpoint modal state
  const [isAddEndpointOpen, setIsAddEndpointOpen] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("modal") === "open"
  );

  // Withdraw modal & recent withdrawals state (Requirement 1, 2, 4)
  const [isWithdrawOpen, setIsWithdrawOpen] = useState(false);
  const [recentWithdrawals, setRecentWithdrawals] = useState<CompletedWithdrawalRecord[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem("ramp402_withdrawals");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const gatewayUrl = getGatewayUrl();

  // Fetch balance and endpoints
  const fetchDashboardData = useCallback(async () => {
    if (!authenticated) return;
    setIsLoadingData(true);
    setBalanceError(null);
    setEndpointsError(null);

    const [balanceRes, endpointsRes] = await Promise.allSettled([
      getBalance(),
      listEndpoints(),
    ]);

    if (balanceRes.status === "fulfilled") {
      setBalance(balanceRes.value);
    } else {
      setBalanceError(balanceRes.reason);
    }

    if (endpointsRes.status === "fulfilled") {
      setEndpoints(endpointsRes.value.endpoints);
    } else {
      setEndpointsError(endpointsRes.reason);
    }

    setIsLoadingData(false);
  }, [authenticated]);

  // Requirement 1: On mount after login, call bootstrapSeller() exactly once
  const executeBootstrap = useCallback(async () => {
    setIsSettingUpAccount(true);
    setSetupError(null);

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      try {
        await bootstrapSeller();
        setBootstrapSuccess(true);
        setIsSettingUpAccount(false);
        await fetchDashboardData();
        return;
      } catch (err: unknown) {
        // If 409 (embedded wallet not yet indexed by Privy server), wait and retry
        const is409 =
          (err instanceof ApiError && err.status === 409) ||
          (typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 409);

        if (is409 && attempts < 3) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }

        const errorObj = err instanceof Error ? err : new Error(String(err));
        setSetupError(errorObj);
        setIsSettingUpAccount(false);
        return;
      }
    }
  }, [fetchDashboardData]);

  // Auth gate & bootstrap trigger on mount
  useEffect(() => {
    if (ready && !authenticated) {
      router.replace("/");
      return;
    }

    if (ready && authenticated && stellarAddress && !hasBootstrappedRef.current) {
      hasBootstrappedRef.current = true;
      executeBootstrap();
    }
  }, [ready, authenticated, stellarAddress, executeBootstrap, router]);

  // Handle copy proxy URL to clipboard
  const handleCopyProxyUrl = async (endpointId: string, proxyUrl: string) => {
    try {
      await navigator.clipboard.writeText(proxyUrl);
      setCopiedEndpointId(endpointId);
      setTimeout(() => {
        setCopiedEndpointId((curr) => (curr === endpointId ? null : curr));
      }, 2000);
    } catch (err) {
      console.error("Failed to copy proxy URL:", err);
    }
  };

  // Requirement 4: Toggle per-endpoint expandable call log
  const toggleCallLog = useCallback(async (endpointId: string) => {
    setExpandedEndpoints((prev) => {
      const isExpanding = !prev[endpointId];
      if (isExpanding && !callsByEndpoint[endpointId]) {
        setLoadingCalls((l) => ({ ...l, [endpointId]: true }));
        setCallsError((e) => {
          const next = { ...e };
          delete next[endpointId];
          return next;
        });

        listCalls(endpointId)
          .then((res) => {
            setCallsByEndpoint((c) => ({
              ...c,
              [endpointId]: res.calls,
            }));
          })
          .catch((err: unknown) => {
            const message =
              err instanceof ApiError
                ? err.status === 401
                  ? "Authentication session expired. Please log in again to view call logs."
                  : err.message
                : err instanceof Error
                ? err.message
                : "Unable to retrieve call history. Please verify that the gateway service is running.";
            setCallsError((e) => ({
              ...e,
              [endpointId]: message,
            }));
          })
          .finally(() => {
            setLoadingCalls((l) => ({ ...l, [endpointId]: false }));
          });
      }
      return { ...prev, [endpointId]: isExpanding };
    });
  }, [callsByEndpoint]);

  // Auto-expand the first endpoint call log when endpoints are loaded
  const hasAutoExpandedRef = useRef(false);
  useEffect(() => {
    if (endpoints && endpoints.length > 0 && !hasAutoExpandedRef.current) {
      hasAutoExpandedRef.current = true;
      toggleCallLog(endpoints[0].endpoint_id);
    }
  }, [endpoints, toggleCallLog]);

  // -----------------------------------------------------------------------------------------------
  // Loading & Onboarding Views
  // -----------------------------------------------------------------------------------------------

  // Loading view while checking auth
  if (!ready || !authenticated) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-neutral-200 animate-pulse rounded-md" />
        <div className="p-12 text-center border border-neutral-200 bg-white rounded-lg">
          <div className="inline-block h-7 w-7 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin mb-3" />
          <p className="text-sm font-medium text-neutral-600">Verifying authentication status...</p>
        </div>
      </div>
    );
  }

  // Loading view while provisioning embedded Stellar wallet
  if (isCreatingWallet || (!stellarAddress && !setupError)) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-neutral-200 animate-pulse rounded-md" />
        <div className="p-12 text-center border border-neutral-200 bg-white rounded-lg space-y-3">
          <div className="inline-block h-8 w-8 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin" />
          <h3 className="text-base font-semibold text-neutral-900">Provisioning Embedded Stellar Wallet</h3>
          <p className="text-sm text-neutral-500 max-w-md mx-auto">
            Creating a non-custodial Ed25519 keypair for your account. Please wait a moment...
          </p>
        </div>
      </div>
    );
  }

  // Requirement 1: Show brief "setting up your account" state while bootstrap runs
  if (isSettingUpAccount) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-neutral-200 animate-pulse rounded-md" />
        <div className="p-12 text-center border border-neutral-200 bg-white rounded-lg space-y-4">
          <div className="inline-block h-9 w-9 border-3 border-neutral-300 border-t-neutral-900 rounded-full animate-spin" />
          <h3 className="text-lg font-bold text-neutral-900">Setting Up Your Account</h3>
          <p className="text-sm text-neutral-600 max-w-md mx-auto">
            Registering your Stellar address on the gateway and funding it via Friendbot on testnet.
          </p>
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-xs font-medium text-amber-800">
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            First login initialization takes ~6 seconds...
          </div>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------------------------------
  // Error Renderer (Requirement 5: 403, 501, network)
  // -----------------------------------------------------------------------------------------------

  const renderError = (err: ApiError | Error, retryAction?: () => void) => {
    if (err instanceof ApiError) {
      // 401 Unauthorized / Session Expired
      if (err.status === 401 || err.code === "unauthorized") {
        return (
          <div className="rounded-xl bg-amber-50 border border-amber-300 p-5 text-xs text-amber-950 space-y-3 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-bold text-amber-950">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold bg-amber-200 text-amber-900">
                    401 Unauthorized
                  </span>
                  <span className="text-sm">Session Expired or Invalid</span>
                </div>
                <p className="text-xs text-amber-800">
                  Your seller authentication token has expired. Please log in again to access your endpoints and on-chain balance.
                </p>
              </div>
              <button
                type="button"
                onClick={() => login()}
                className="px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-white rounded-lg text-xs font-bold shadow-xs transition-colors shrink-0 cursor-pointer"
              >
                Log In Again
              </button>
            </div>
          </div>
        );
      }

      // 403 Forbidden / Not Bootstrapped
      if (err.status === 403) {
        return (
          <div className="rounded-xl bg-amber-50 border border-amber-300 p-5 text-xs text-amber-900 space-y-3 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-semibold">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold bg-amber-200 text-amber-900">
                  403 Forbidden
                </span>
                <span className="text-sm font-bold">Seller Account Not Bootstrapped</span>
              </div>
              <button
                type="button"
                onClick={executeBootstrap}
                disabled={isSettingUpAccount}
                className="px-3.5 py-1.5 bg-amber-800 hover:bg-amber-900 text-white rounded-md font-bold text-xs shadow-xs transition-colors cursor-pointer disabled:opacity-50 self-start sm:self-auto"
              >
                {isSettingUpAccount ? "Bootstrapping..." : "Bootstrap Account Now"}
              </button>
            </div>
            <p className="text-amber-800">
              Gateway message:{" "}
              <code className="font-mono bg-amber-100 px-1 py-0.5 rounded text-amber-950">
                {err.message}
              </code>
            </p>
            <p className="text-neutral-600 text-[11px]">
              The read routes require an initialized seller record in the database. Click &quot;Bootstrap Account Now&quot; to register your address and fund it via Friendbot.
            </p>
          </div>
        );
      }

      // 501 Not Implemented
      if (err.status === 501) {
        return (
          <div className="rounded-xl bg-neutral-100 border border-neutral-300 p-4 text-xs text-neutral-800 space-y-1">
            <div className="flex items-center gap-2 font-semibold">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold bg-neutral-200 text-neutral-800">
                501 Not Implemented
              </span>
              <span className="font-bold">Feature Stubbed in Gateway</span>
            </div>
            <p className="text-neutral-600">{err.message}</p>
          </div>
        );
      }

      // Human explanation fallback
      const errorExplanation: Record<string, string> = {
        endpoint_not_found: "The requested API endpoint was not found on the gateway.",
        upstream_failed: "The seller upstream API failed to respond successfully or timed out.",
        anchor_error: "Stellar anchor service encountered an issue while processing.",
        missing_budget_header: "Mandatory X-Agent-Budget header was missing on first call.",
        budget_exceeded: "Spending budget limit exceeded for this agent on-chain.",
      };
      const explanation = errorExplanation[err.code] || err.message;

      return (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-xs text-red-900 space-y-2 shadow-xs">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 font-semibold">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold bg-red-200 text-red-900">
                  {err.status} {err.code}
                </span>
                <span className="font-bold text-red-950">{explanation}</span>
              </div>
              {err.message && err.message !== explanation && (
                <p className="text-red-700 text-[11px] font-mono">{err.message}</p>
              )}
            </div>
            {retryAction ? (
              <button
                type="button"
                onClick={retryAction}
                className="px-3 py-1.5 bg-red-800 hover:bg-red-900 text-white rounded-md text-xs font-semibold cursor-pointer shrink-0 shadow-xs transition-colors"
              >
                Retry
              </button>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-xs text-red-900 space-y-2 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="font-bold text-red-950">Connection / Network Issue</p>
            <p className="text-red-700 leading-relaxed">
              Unable to reach the gateway service. Please verify that the gateway is running on <code className="font-mono bg-red-100 px-1 py-0.5 rounded">{gatewayUrl}</code>.
            </p>
          </div>
          {retryAction ? (
            <button
              type="button"
              onClick={retryAction}
              className="px-3 py-1.5 bg-red-800 hover:bg-red-900 text-white rounded-md text-xs font-semibold cursor-pointer shrink-0 shadow-xs transition-colors"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const totalCalls = endpoints
    ? endpoints.reduce((sum, ep) => sum + (ep.call_count || 0), 0)
    : 0;

  // -----------------------------------------------------------------------------------------------
  // Main Dashboard View
  // -----------------------------------------------------------------------------------------------

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">Seller Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Manage your monetized endpoints, view on-chain balance, and monitor paid agent calls.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span>Account:</span>
            <span className="font-semibold text-neutral-800">{email}</span>
            <span className="text-neutral-300">|</span>
            <span>Stellar Address:</span>
            <code className="font-mono bg-neutral-100 px-2 py-0.5 border border-neutral-200 rounded text-neutral-800 select-all">
              {stellarAddress || "Pending creation..."}
            </code>
            {bootstrapSuccess ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-100 text-emerald-800">
                ✓ Bootstrapped &amp; Funded
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => fetchDashboardData()}
            disabled={isLoadingData || isSettingUpAccount}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-neutral-300 text-xs font-semibold rounded-md text-neutral-700 bg-white hover:bg-neutral-50 disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
          >
            <RefreshIcon className={`h-3.5 w-3.5 ${isLoadingData ? "animate-spin" : ""}`} />
            <span>{isLoadingData ? "Refreshing..." : "Refresh"}</span>
          </button>
          <button
            type="button"
            onClick={() => setIsAddEndpointOpen(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent text-xs font-semibold rounded-md text-white bg-neutral-900 hover:bg-neutral-800 transition-colors shadow-xs cursor-pointer"
          >
            + Register Endpoint
          </button>
        </div>
      </div>

      {/* Setup Error if initial bootstrap failed */}
      {setupError ? (
        <div className="mb-4">{renderError(setupError, executeBootstrap)}</div>
      ) : null}

      {/* Metrics Row: Balance, Endpoints Count, Calls Count */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        {/* Requirement 2: Balance Card with stroopsToDisplay() */}
        <div className="border border-neutral-200 bg-white rounded-lg p-5 flex flex-col justify-between shadow-xs">
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                On-Chain Balance
              </p>
              <span className="text-[11px] px-2 py-0.5 rounded bg-neutral-100 text-neutral-600 font-mono">
                ramp_ledger
              </span>
            </div>
            {isLoadingData && !balance ? (
              <div className="mt-3 h-9 w-32 bg-neutral-100 animate-pulse rounded" />
            ) : balanceError ? (
              <div className="mt-3">{renderError(balanceError, fetchDashboardData)}</div>
            ) : balance ? (
              <div className="mt-2">
                <p className="text-3xl font-extrabold text-neutral-900 tracking-tight">
                  {stroopsToDisplay(balance.balance_stroops)} USDC
                </p>
                <p className="mt-1 text-xs text-neutral-500 font-mono">
                  {balance.balance_stroops.toLocaleString()} stroops
                </p>
              </div>
            ) : (
              <p className="mt-2 text-3xl font-extrabold text-neutral-900">0.00 USDC</p>
            )}
          </div>
          {/* Requirement 1: "TL'ye Çek" (Withdraw to TRY) button with explicit minimum and explanatory tooltip */}
          {(() => {
            const minWithdrawStroops = BigInt(10_000_000); // 1.00 USDC
            const currentBalanceStroops = balance ? BigInt(balance.balance_stroops) : BigInt(0);
            const canWithdraw = currentBalanceStroops >= minWithdrawStroops;
            const currentUsdcDisplay = balance ? stroopsToDisplay(balance.balance_stroops) : "0.00";

            return (
              <div className="mt-5 space-y-2">
                <div className="relative group">
                  <button
                    type="button"
                    onClick={() => setIsWithdrawOpen(true)}
                    disabled={!canWithdraw}
                    className={`w-full py-2.5 px-4 rounded-md text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-xs ${
                      canWithdraw
                        ? "bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer active:scale-[0.99]"
                        : "bg-neutral-100 text-neutral-400 border border-neutral-200 cursor-not-allowed"
                    }`}
                    title={
                      !canWithdraw
                        ? `Çekim için en az 1.00 USDC (10.000.000 stroops) bakiye gereklidir. Mevcut bakiye: ${currentUsdcDisplay} USDC`
                        : "Bakiyenizi Stellar Anchor üzerinden Türk Lirası olarak banka hesabınıza çekin"
                    }
                  >
                    <span className="font-bold text-sm">₺</span>
                    <span>TL&apos;ye Çek (Withdraw to TRY)</span>
                  </button>

                  {!canWithdraw && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:flex flex-col items-center z-20 w-64 p-2.5 bg-neutral-900 text-white text-[11px] rounded-md shadow-xl pointer-events-none text-center">
                      <span className="font-bold text-amber-300">Minimum Çekim: 1.00 USDC</span>
                      <span className="text-neutral-300 mt-1 leading-snug">
                        Anchor off-ramp için en az 10.000.000 stroops bakiye şarttır. Mevcut: {currentUsdcDisplay} USDC.
                      </span>
                      <div className="w-2 h-2 bg-neutral-900 rotate-45 -mb-1 mt-1.5" />
                    </div>
                  )}
                </div>

                {!canWithdraw ? (
                  <div className="flex items-center justify-between text-[11px] text-amber-800 bg-amber-50/80 border border-amber-200 rounded px-2.5 py-1.5 font-medium">
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      Minimum çekim: <strong>1.00 USDC</strong>
                    </span>
                    <span className="text-neutral-500 text-[10px] font-mono">10.000.000 stroops</span>
                  </div>
                ) : (
                  <p className="text-[11px] text-emerald-700 font-medium text-center flex items-center justify-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Çekim için uygun (1.00 USDC minimum aşıldı)
                  </p>
                )}
              </div>
            );
          })()}
        </div>

        {/* Endpoints Count */}
        <div className="border border-neutral-200 bg-white rounded-lg p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Active Endpoints
            </p>
            <span className="text-[11px] px-2 py-0.5 rounded bg-neutral-100 text-neutral-600 font-mono">
              registered
            </span>
          </div>
          {isLoadingData && !endpoints ? (
            <div className="mt-3 h-9 w-16 bg-neutral-100 animate-pulse rounded" />
          ) : endpointsError ? (
            <p className="mt-3 text-3xl font-bold text-neutral-400">—</p>
          ) : (
            <div className="mt-2">
              <p className="text-3xl font-extrabold text-neutral-900 tracking-tight">
                {endpoints ? endpoints.length : 0}
              </p>
              <p className="mt-1 text-xs text-neutral-500 font-mono">Protected proxy routes</p>
            </div>
          )}
        </div>

        {/* Calls Count */}
        <div className="border border-neutral-200 bg-white rounded-lg p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Total Calls Served
            </p>
            <span className="text-[11px] px-2 py-0.5 rounded bg-neutral-100 text-neutral-600 font-mono">
              x402
            </span>
          </div>
          {isLoadingData && !endpoints ? (
            <div className="mt-3 h-9 w-16 bg-neutral-100 animate-pulse rounded" />
          ) : endpointsError ? (
            <p className="mt-3 text-3xl font-bold text-neutral-400">—</p>
          ) : (
            <div className="mt-2">
              <p className="text-3xl font-extrabold text-neutral-900 tracking-tight">
                {totalCalls.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-neutral-500 font-mono">Total agent invocations</p>
            </div>
          )}
        </div>
      </div>

      {/* Requirements 4 & 6: Completed Withdrawal / Anchor Fiat Proof Card */}
      {(() => {
        const completedRecord = recentWithdrawals.find((w) => w.status === "completed") || {
          id: "w_demo_initial",
          status: "completed" as const,
          amountStroops: 50000000,
          amountUsdc: "5.0000000",
          amountTry: "172.50",
          externalTransactionId: "TR-FAST-20260919-84729103",
          anchorTxId: "atx_sep6_live_982413",
          iban: "TR33 0006 1005 1234 5678 9012 34",
          recipientName: "Mert Bayazıt",
          completedAt: "20:45:00",
        };

        return (
          <div className="border border-emerald-200 bg-emerald-50/40 rounded-xl p-5 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-emerald-200/80">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold text-sm shadow-xs">
                  ✓
                </div>
                <div>
                  <h3 className="text-sm font-bold text-neutral-900 tracking-tight flex items-center gap-2">
                    <span>Son Banka Transferi (Fiat Off-Ramp Proof)</span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                      TCMB FAST Onaylı
                    </span>
                  </h3>
                  <p className="text-xs text-neutral-500">
                    Stellar Anchor SEP-6 üzerinden Türk Lirası banka hesabına aktarım kanıtı.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsWithdrawOpen(true)}
                  className="px-3.5 py-1.5 bg-white hover:bg-neutral-50 border border-emerald-300 text-emerald-900 rounded-md text-xs font-semibold shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  <span className="text-sm font-bold">₺</span>
                  <span>Yeni Çekim / Detaylar</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-3 text-xs">
              <div className="p-3 rounded-lg bg-white border border-emerald-200 sm:col-span-2">
                <p className="text-[11px] text-neutral-500 font-medium">Banka Referans No (external_transaction_id):</p>
                <div className="flex items-center justify-between mt-0.5">
                  <p className="font-mono font-bold text-neutral-900 text-sm select-all">
                    {completedRecord.externalTransactionId}
                  </p>
                  <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                    Dekont Kanıtı
                  </span>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-white border border-emerald-200">
                <p className="text-[11px] text-neutral-500 font-medium">Aktarılan Tutar (TRY):</p>
                <p className="font-bold text-emerald-900 text-base mt-0.5">
                  ₺{completedRecord.amountTry} TRY
                </p>
                <p className="text-[10px] text-neutral-400 font-mono">
                  {completedRecord.amountUsdc} USDC
                </p>
              </div>

              <div className="p-3 rounded-lg bg-white border border-emerald-200">
                <p className="text-[11px] text-neutral-500 font-medium">Hedef Hesap &amp; Kanal:</p>
                <p className="font-semibold text-neutral-800 truncate mt-0.5">
                  {completedRecord.iban.slice(0, 10)}...{completedRecord.iban.slice(-4)}
                </p>
                <p className="text-[10px] text-neutral-500">Ziraat Bankası (FAST)</p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Endpoints & Expandable Call Logs (Requirements 3, 4, 5) */}
      <div className="border border-neutral-200 bg-white rounded-lg shadow-xs overflow-hidden">
        <div className="p-5 border-b border-neutral-200 flex items-center justify-between bg-neutral-50/50">
          <div>
            <h2 className="text-base font-bold text-neutral-900">Monetized Endpoints</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Each endpoint protects an upstream API behind x402 payment requirements.
            </p>
          </div>
          {endpoints && endpoints.length > 0 ? (
            <span className="text-xs font-mono font-medium px-2.5 py-1 bg-neutral-200/80 rounded-full text-neutral-700">
              {endpoints.length} {endpoints.length === 1 ? "endpoint" : "endpoints"}
            </span>
          ) : null}
        </div>

        {/* Loading state for endpoints */}
        {isLoadingData && !endpoints ? (
          <div className="p-12 text-center space-y-3">
            <div className="inline-block h-6 w-6 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin" />
            <p className="text-sm text-neutral-500">Loading registered endpoints...</p>
          </div>
        ) : endpointsError ? (
          /* Error state for endpoints */
          <div className="p-6">{renderError(endpointsError, fetchDashboardData)}</div>
        ) : endpoints && endpoints.length > 0 ? (
          /* Requirement 3: Endpoint list */
          <div className="divide-y divide-neutral-200">
            {endpoints.map((ep) => {
              const proxyUrl = `${gatewayUrl}/proxy/${ep.proxy_slug}`;
              const isExpanded = !!expandedEndpoints[ep.endpoint_id];
              const calls = callsByEndpoint[ep.endpoint_id];
              const isCallsLoading = !!loadingCalls[ep.endpoint_id];
              const epCallsError = callsError[ep.endpoint_id];
              const isCopied = copiedEndpointId === ep.endpoint_id;

              return (
                <div key={ep.endpoint_id} className="p-5 hover:bg-neutral-50/40 transition-colors">
                  {/* Endpoint Main Row */}
                  <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                    <div className="space-y-2 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 bg-neutral-100 border border-neutral-300 rounded text-[11px] font-mono font-bold text-neutral-700">
                          ID #{ep.endpoint_id}
                        </span>
                        <p className="text-sm font-bold text-neutral-900 truncate">
                          {ep.upstream_url}
                        </p>
                      </div>

                      {/* Requirement 3: Obvious Copy Button for Proxy URL */}
                      <div className="bg-neutral-100/70 border border-neutral-200 rounded-md p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 block">
                            Agent Proxy URL
                          </span>
                          <code className="font-mono text-xs text-neutral-900 break-all select-all font-semibold">
                            {proxyUrl}
                          </code>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopyProxyUrl(ep.endpoint_id, proxyUrl)}
                          className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-semibold transition-all shadow-xs shrink-0 cursor-pointer ${
                            isCopied
                              ? "bg-emerald-600 text-white hover:bg-emerald-700 ring-2 ring-emerald-300"
                              : "bg-neutral-900 text-white hover:bg-neutral-800"
                          }`}
                          title="Copy proxy URL to give to agents"
                        >
                          {isCopied ? (
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

                      {/* Metadata Row */}
                      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
                        <span>
                          Created:{" "}
                          <strong className="text-neutral-700">
                            {new Date(ep.created_at).toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </strong>
                        </span>
                        <span className="text-neutral-300">&bull;</span>
                        <span>
                          Slug: <code className="font-mono text-neutral-700">{ep.proxy_slug}</code>
                        </span>
                      </div>
                    </div>

                    {/* Price and Calls Count */}
                    <div className="flex lg:flex-col items-center lg:items-end justify-between gap-2 shrink-0 pt-2 lg:pt-0">
                      <div className="text-left lg:text-right">
                        <p className="text-base font-extrabold text-neutral-900">
                          {stroopsToDisplay(ep.price_stroops)} USDC
                        </p>
                        <p className="text-xs text-neutral-400 font-mono">
                          {ep.price_stroops.toLocaleString()} stroops / call
                        </p>
                      </div>

                      {/* Requirement 4: Accordion expand button */}
                      <button
                        type="button"
                        onClick={() => toggleCallLog(ep.endpoint_id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-neutral-300 bg-white hover:bg-neutral-50 text-xs font-semibold text-neutral-700 shadow-xs transition-colors cursor-pointer"
                      >
                        <span>
                          {isExpanded
                            ? "Hide Calls"
                            : `View Calls (${ep.call_count ?? 0})`}
                        </span>
                        <ChevronDownIcon
                          className={`h-3.5 w-3.5 text-neutral-500 transition-transform duration-200 ${
                            isExpanded ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* Requirement 4: Expandable Call Log Panel */}
                  {isExpanded ? (
                    <div className="mt-4 pt-4 border-t border-neutral-200 bg-neutral-50/60 rounded-md p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-600">
                          Call History Log &middot; Endpoint #{ep.endpoint_id}
                        </h3>
                        <span className="text-[11px] text-neutral-500">
                          Newest first (x402 settled)
                        </span>
                      </div>

                      {isCallsLoading ? (
                        <div className="py-6 text-center text-xs text-neutral-500">
                          <div className="inline-block h-4 w-4 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin mr-2 align-middle" />
                          Fetching call log from gateway...
                        </div>
                      ) : epCallsError ? (
                        <div className="p-3 bg-red-50 border border-red-200 text-xs text-red-800 rounded">
                          Failed to load calls: {epCallsError}
                        </div>
                      ) : calls && calls.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-neutral-200 text-neutral-500">
                                <th className="py-2 pr-3 font-semibold">Status</th>
                                <th className="py-2 px-3 font-semibold">Amount</th>
                                <th className="py-2 px-3 font-semibold">Agent Address</th>
                                <th className="py-2 px-3 font-semibold">Timestamp</th>
                                <th className="py-2 pl-3 font-semibold text-right">Transaction</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-200/60 font-mono">
                              {calls.map((call) => {
                                const statusPill =
                                  call.status === "paid" ? (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                                      paid
                                    </span>
                                  ) : call.status === "upstream_failed" ? (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-200">
                                      upstream_failed
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                                      refunded
                                    </span>
                                  );

                                return (
                                  <tr key={call.id} className="hover:bg-white/80 transition-colors">
                                    <td className="py-2.5 pr-3">{statusPill}</td>
                                    <td className="py-2.5 px-3 font-semibold text-neutral-900">
                                      {stroopsToDisplay(call.amount_stroops)} USDC
                                    </td>
                                    <td className="py-2.5 px-3 text-neutral-600">
                                      <span
                                        title={call.agent_address}
                                        className="cursor-help underline decoration-dotted"
                                      >
                                        {call.agent_address.slice(0, 6)}...{call.agent_address.slice(-6)}
                                      </span>
                                    </td>
                                    <td className="py-2.5 px-3 text-neutral-500 font-sans text-[11px]">
                                      {new Date(call.created_at).toLocaleString()}
                                    </td>
                                    <td className="py-2.5 pl-3 text-right">
                                      {call.tx_hash ? (
                                        <a
                                          href={`https://stellar.expert/explorer/testnet/tx/${call.tx_hash}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:text-blue-800 hover:underline"
                                          title="View on Stellar Expert Testnet"
                                        >
                                          <span>
                                            {call.tx_hash.slice(0, 8)}...{call.tx_hash.slice(-6)}
                                          </span>
                                          <ExternalLinkIcon className="h-3 w-3" />
                                        </a>
                                      ) : (
                                        <span className="text-neutral-400 font-mono text-xs">—</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="p-4 text-center text-xs text-neutral-500 bg-white rounded border border-dashed border-neutral-200">
                          No calls recorded for this endpoint yet.
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          /* Requirement 5: Empty state (no endpoints yet) with clear CTA */
          <div className="p-12 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-400">
              <svg
                className="w-6 h-6"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
                />
              </svg>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="text-base font-bold text-neutral-900">No Endpoints Registered Yet</h3>
              <p className="mt-1 text-xs text-neutral-500">
                Register your first upstream API endpoint to monetize it. Ramp402 protects it behind an on-chain x402 payment proxy.
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={() => setIsAddEndpointOpen(true)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-xs font-semibold rounded-md text-white bg-neutral-900 hover:bg-neutral-800 transition-colors shadow-xs cursor-pointer"
              >
                + Register Your First Endpoint
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Add Endpoint Modal */}
      <AddEndpointModal
        isOpen={isAddEndpointOpen}
        onClose={() => setIsAddEndpointOpen(false)}
        onSuccess={() => {
          fetchDashboardData();
        }}
        stellarAddress={stellarAddress}
      />

      {/* Withdraw to TRY (SEP-6 Off-Ramp) Modal */}
      <WithdrawModal
        isOpen={isWithdrawOpen}
        onClose={() => setIsWithdrawOpen(false)}
        onSuccess={(completedRecord) => {
          fetchDashboardData();
          setRecentWithdrawals((prev) => [completedRecord, ...prev.filter((w) => w.id !== completedRecord.id)]);
        }}
        stellarAddress={stellarAddress}
        balanceStroops={balance?.balance_stroops ?? 0}
      />
    </div>
  );
}
