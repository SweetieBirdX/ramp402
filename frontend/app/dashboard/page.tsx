"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { getBalance, listEndpoints, ApiError } from "@/lib/api";
import { stroopsToDisplay } from "@/lib/format";
import type { EndpointSummary, GetBalanceResponse } from "@/lib/types";

export default function DashboardPage() {
  const {
    ready,
    authenticated,
    stellarAddress,
    email,
    isCreatingWallet,
    isBootstrapping,
    isBootstrapped,
    bootstrapError,
    bootstrap,
  } = useAuth();
  const router = useRouter();

  const [balance, setBalance] = useState<GetBalanceResponse | null>(null);
  const [balanceError, setBalanceError] = useState<ApiError | Error | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointSummary[] | null>(null);
  const [endpointsError, setEndpointsError] = useState<ApiError | Error | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);

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

  useEffect(() => {
    if (ready && !authenticated) {
      router.replace("/");
      return;
    }

    if (ready && authenticated && stellarAddress && !isBootstrapping) {
      let isSubscribed = true;

      const runInitialFetch = async () => {
        await Promise.resolve();
        if (!isSubscribed) return;

        setIsLoadingData(true);
        setBalanceError(null);
        setEndpointsError(null);

        const [balanceRes, endpointsRes] = await Promise.allSettled([
          getBalance(),
          listEndpoints(),
        ]);

        if (!isSubscribed) return;

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
      };

      runInitialFetch();

      return () => {
        isSubscribed = false;
      };
    }
  }, [ready, authenticated, stellarAddress, isBootstrapping, isBootstrapped, router]);

  // Loading view while checking auth
  if (!ready || !authenticated) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-neutral-200 animate-pulse rounded-md" />
        <div className="p-12 text-center border border-neutral-200 bg-white rounded-lg">
          <div className="inline-block h-6 w-6 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin mb-3" />
          <p className="text-sm text-neutral-600">Verifying authentication status...</p>
        </div>
      </div>
    );
  }

  // Loading view while provisioning wallet
  if (isCreatingWallet || (!stellarAddress && !bootstrapError)) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-neutral-200 animate-pulse rounded-md" />
        <div className="p-12 text-center border border-neutral-200 bg-white rounded-lg space-y-3">
          <div className="inline-block h-7 w-7 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin" />
          <h3 className="text-base font-semibold text-neutral-900">Provisioning Embedded Stellar Wallet</h3>
          <p className="text-sm text-neutral-500 max-w-md mx-auto">
            Creating non-custodial Ed25519 keypair for your account. Please wait a moment...
          </p>
        </div>
      </div>
    );
  }

  // Loading view during the 6-second Friendbot bootstrap
  if (isBootstrapping) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-neutral-200 animate-pulse rounded-md" />
        <div className="p-12 text-center border border-neutral-200 bg-white rounded-lg space-y-3">
          <div className="inline-block h-7 w-7 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin" />
          <h3 className="text-base font-semibold text-neutral-900">Bootstrapping Seller Account</h3>
          <p className="text-sm text-neutral-600 max-w-md mx-auto">
            Registering your Stellar address on the gateway and funding it via Friendbot on testnet.
          </p>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-xs font-medium text-amber-800">
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            First login initialization takes ~6 seconds...
          </div>
        </div>
      </div>
    );
  }

  const renderError = (err: ApiError | Error) => {
    if (err instanceof ApiError) {
      if (err.status === 403) {
        return (
          <div className="rounded-lg bg-amber-50 border border-amber-300 p-4 text-xs text-amber-900 space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold bg-amber-200 text-amber-900">
                  403 Forbidden
                </span>
                <span>Seller Account Not Bootstrapped</span>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const ok = await bootstrap();
                  if (ok) fetchDashboardData();
                }}
                disabled={isBootstrapping}
                className="px-3 py-1 bg-amber-800 hover:bg-amber-900 text-white rounded font-medium text-xs shadow-xs transition-colors cursor-pointer disabled:opacity-50 self-start sm:self-auto"
              >
                {isBootstrapping ? "Bootstrapping (~6s)..." : "Bootstrap Account"}
              </button>
            </div>
            <p className="text-amber-800">
              Gateway message: <code className="font-mono bg-amber-100/70 px-1 py-0.5 rounded text-amber-950">{err.message}</code>
            </p>
            <p className="text-neutral-600 text-[11px]">
              The read routes require an initialized seller record in the database. Click &quot;Bootstrap Account&quot; to register your address and fund it via Friendbot.
            </p>
          </div>
        );
      }

      return (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-4 text-xs text-amber-900">
          <div className="flex items-center gap-2 font-semibold">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium bg-amber-200 text-amber-800">
              {err.status} {err.code}
            </span>
            <span className="font-mono">{err.message}</span>
          </div>
          <p className="mt-1 text-amber-700">
            {err.status === 501
              ? "Gateway returned 501 Not Implemented (endpoint stubbed in gateway)."
              : "An API error was returned by the gateway."}
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-md bg-red-50 border border-red-200 p-4 text-xs text-red-900">
        <p className="font-semibold">Network / Client Error</p>
        <p className="mt-1 text-red-700">{err.message}</p>
      </div>
    );
  };

  const totalCalls = endpoints
    ? endpoints.reduce((sum, ep) => sum + (ep.call_count || 0), 0)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">Seller Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Manage your monetized endpoints, view on-chain balance, and withdraw to TRY.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span>Account:</span>
            <span className="font-semibold text-neutral-700">{email}</span>
            <span className="text-neutral-300">|</span>
            <span>Stellar Address:</span>
            <code className="font-mono bg-white px-2 py-0.5 border border-neutral-200 rounded text-neutral-800">
              {stellarAddress || "Pending creation..."}
            </code>
            {isBootstrapped ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-100 text-emerald-800">
                ✓ Bootstrapped &amp; Funded
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchDashboardData()}
            disabled={isLoadingData || isBootstrapping}
            className="inline-flex items-center px-3 py-2 border border-neutral-300 text-xs font-medium rounded-md text-neutral-700 bg-white hover:bg-neutral-50 disabled:opacity-50 transition-colors"
          >
            {isLoadingData ? "Fetching..." : "Refresh Data"}
          </button>
          <button
            type="button"
            disabled
            className="inline-flex items-center px-4 py-2 border border-neutral-300 text-sm font-medium rounded-md text-neutral-400 bg-neutral-100 cursor-not-allowed"
          >
            + Register Endpoint
          </button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        {/* Balance Card */}
        <div className="border border-neutral-200 bg-white rounded-lg p-5 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
              On-Chain Balance
            </p>
            {isLoadingData ? (
              <div className="mt-2 h-9 w-32 bg-neutral-100 animate-pulse rounded" />
            ) : balanceError ? (
              <div className="mt-3">{renderError(balanceError)}</div>
            ) : balance ? (
              <div className="mt-2">
                <p className="text-3xl font-bold text-neutral-900">
                  {stroopsToDisplay(balance.balance_stroops)} USDC
                </p>
                <p className="mt-1 text-xs text-neutral-500 font-mono">
                  {balance.balance_stroops.toLocaleString()} stroops
                </p>
              </div>
            ) : (
              <p className="mt-2 text-3xl font-bold text-neutral-900">0.00 USDC</p>
            )}
          </div>
          <button
            type="button"
            disabled
            className="mt-4 w-full py-2 px-3 border border-neutral-300 rounded text-xs font-medium text-neutral-400 bg-neutral-50 cursor-not-allowed"
          >
            Withdraw to TRY (Off-Ramp)
          </button>
        </div>

        {/* Endpoints Count */}
        <div className="border border-neutral-200 bg-white rounded-lg p-5">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Active Endpoints
          </p>
          {isLoadingData ? (
            <div className="mt-2 h-9 w-16 bg-neutral-100 animate-pulse rounded" />
          ) : endpointsError ? (
            <p className="mt-2 text-3xl font-bold text-neutral-400">—</p>
          ) : (
            <p className="mt-2 text-3xl font-bold text-neutral-900">
              {endpoints ? endpoints.length : 0}
            </p>
          )}
          <p className="mt-1 text-xs text-neutral-500 font-mono">Registered on-chain</p>
        </div>

        {/* Calls Count */}
        <div className="border border-neutral-200 bg-white rounded-lg p-5">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Total Calls Served
          </p>
          {isLoadingData ? (
            <div className="mt-2 h-9 w-16 bg-neutral-100 animate-pulse rounded" />
          ) : endpointsError ? (
            <p className="mt-2 text-3xl font-bold text-neutral-400">—</p>
          ) : (
            <p className="mt-2 text-3xl font-bold text-neutral-900">
              {totalCalls.toLocaleString()}
            </p>
          )}
          <p className="mt-1 text-xs text-neutral-500 font-mono">Paid via x402</p>
        </div>
      </div>

      {/* Endpoints Section */}
      <div className="border border-neutral-200 bg-white rounded-lg p-6">
        <h2 className="text-lg font-semibold text-neutral-900">Endpoints</h2>
        {isLoadingData ? (
          <div className="mt-4 p-8 text-center">
            <div className="inline-block h-5 w-5 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin" />
            <p className="mt-2 text-xs text-neutral-500">Loading endpoints...</p>
          </div>
        ) : endpointsError ? (
          <div className="mt-4">{renderError(endpointsError)}</div>
        ) : endpoints && endpoints.length > 0 ? (
          <div className="mt-4 divide-y divide-neutral-200">
            {endpoints.map((ep) => (
              <div key={ep.endpoint_id} className="py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-neutral-900">{ep.upstream_url}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-xs text-neutral-500 font-mono">Slug: {ep.proxy_slug}</p>
                    <span className="text-neutral-300">&bull;</span>
                    <span className="text-xs px-2 py-0.5 bg-neutral-100 rounded-full font-mono text-neutral-700">
                      {ep.call_count ?? 0} {ep.call_count === 1 ? "call" : "calls"}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-neutral-900">
                    {stroopsToDisplay(ep.price_stroops)} USDC
                  </p>
                  <p className="text-xs text-neutral-400 font-mono">{ep.price_stroops} stroops</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 p-8 text-center border border-dashed border-neutral-200 rounded-md">
            <p className="text-sm text-neutral-500">No endpoints registered yet.</p>
            <p className="text-xs text-neutral-400 mt-1">
              Click &quot;Register Endpoint&quot; once the prepare/submit pipeline is active.
            </p>
          </div>
        )}
      </div>

      {/* Recent Calls Section */}
      <div className="border border-neutral-200 bg-white rounded-lg p-6">
        <h2 className="text-lg font-semibold text-neutral-900">Recent Calls</h2>
        <div className="mt-4 p-8 text-center border border-dashed border-neutral-200 rounded-md">
          <p className="text-sm text-neutral-500">No calls recorded yet.</p>
        </div>
      </div>
    </div>
  );
}
