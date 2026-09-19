"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";

export default function HomePage() {
  const {
    ready,
    authenticated,
    email,
    stellarAddress,
    getAccessToken,
    login,
    logout,
    isCreatingWallet,
    isBootstrapping,
    isBootstrapped,
    bootstrapError,
    bootstrap,
  } = useAuth();
  const [copiedToken, setCopiedToken] = useState(false);
  const [tokenLoading, setTokenLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as unknown as { getPrivyToken: typeof getAccessToken }).getPrivyToken = getAccessToken;
    }
  }, [getAccessToken]);

  const handleCopyToken = async () => {
    setTokenLoading(true);
    try {
      const token = await getAccessToken();
      if (token) {
        await navigator.clipboard.writeText(token);
        setCopiedToken(true);
        setTimeout(() => setCopiedToken(false), 2500);
      } else {
        alert("Token not available. Make sure you are logged in.");
      }
    } catch (err) {
      console.error("Failed to copy token:", err);
    } finally {
      setTokenLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="border border-neutral-200 bg-white rounded-2xl p-8 sm:p-10 shadow-xs">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-10 w-10 rounded-xl bg-neutral-900 text-white flex items-center justify-center font-mono font-black text-sm shadow-xs border border-neutral-800 tracking-tighter">
            402
          </div>
          <div>
            <h1 className="text-3xl font-black text-neutral-900 tracking-tight leading-none">
              Ramp<span className="text-indigo-600">402</span>
            </h1>
            <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-widest mt-0.5 block">
              Stellar x402 Micropayments &amp; Off-Ramp Gateway
            </span>
          </div>
        </div>

        <p className="mt-3 text-base text-neutral-600 max-w-2xl leading-relaxed">
          Monetize your APIs on the x402 payment protocol. Autonomous AI agents pay per call in USDC with hard on-chain spending bounds, and sellers withdraw directly to Turkish Lira (TRY) via Stellar anchors.
        </p>

        <div className="mt-8">
          {!ready ? (
            <div className="h-10 w-40 bg-neutral-100 animate-pulse rounded-md" />
          ) : !authenticated ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => login()}
                  className="inline-flex items-center px-6 py-3 border border-transparent text-sm font-bold rounded-xl shadow-xs text-white bg-neutral-900 hover:bg-neutral-800 transition-colors cursor-pointer"
                >
                  Log In with Email
                </button>
                <Link
                  href="/agent-console"
                  className="inline-flex items-center px-5 py-3 border border-neutral-300 text-sm font-semibold rounded-xl text-neutral-700 bg-white hover:bg-neutral-50 transition-colors shadow-xs"
                >
                  Open Agent Console &rarr;
                </Link>
              </div>
              <p className="text-xs text-neutral-500">
                Email login automatically provisions an embedded non-custodial Stellar wallet via Privy.
              </p>
            </div>
          ) : (
            <div className="space-y-4 p-6 rounded-xl bg-neutral-50 border border-neutral-200">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 mb-2">
                    ✓ Authenticated Seller Session
                  </span>
                  <p className="text-sm font-medium text-neutral-900">
                    Logged in as: <span className="font-semibold">{email || "Seller"}</span>
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-xs text-neutral-500 font-medium">Stellar Address:</span>
                    {isCreatingWallet ? (
                      <span className="text-xs text-amber-600 font-mono animate-pulse">
                        Provisioning embedded Stellar wallet...
                      </span>
                    ) : stellarAddress ? (
                      <code className="text-xs font-mono bg-white px-2 py-0.5 border border-neutral-200 rounded-md text-neutral-800 select-all font-semibold">
                        {stellarAddress}
                      </code>
                    ) : (
                      <span className="text-xs text-neutral-400 font-mono">None detected</span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-neutral-500 font-medium">Privy Token:</span>
                    <button
                      type="button"
                      onClick={handleCopyToken}
                      disabled={tokenLoading}
                      className="inline-flex items-center px-2.5 py-1 border border-neutral-300 text-xs font-semibold rounded-md bg-white hover:bg-neutral-100 text-neutral-800 transition-colors cursor-pointer shadow-xs"
                    >
                      {copiedToken ? "✓ Copied to Clipboard!" : tokenLoading ? "Retrieving..." : "📋 Copy Access Token"}
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-neutral-500 font-medium">Gateway Seller Status:</span>
                    {isBootstrapping ? (
                      <span className="text-xs text-amber-600 font-mono animate-pulse">
                        Bootstrapping via Friendbot (~6s)...
                      </span>
                    ) : isBootstrapped ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-emerald-100 text-emerald-800">
                        ✓ Bootstrapped &amp; Funded
                      </span>
                    ) : bootstrapError ? (
                      <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-2.5 py-1 rounded-md text-xs">
                        <span className="text-red-700 font-medium">
                          Gateway initialization delayed: {bootstrapError}
                        </span>
                        <button
                          type="button"
                          onClick={() => bootstrap()}
                          className="px-2 py-0.5 bg-red-700 hover:bg-red-800 text-white rounded text-[11px] font-semibold transition-colors cursor-pointer"
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-400 font-mono">Waiting for wallet</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Link
                    href="/dashboard"
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-neutral-900 hover:bg-neutral-800 transition-colors"
                  >
                    Go to Seller Dashboard &rarr;
                  </Link>
                  <button
                    type="button"
                    onClick={() => logout()}
                    className="inline-flex items-center px-3 py-2 border border-neutral-300 text-sm font-medium rounded-md text-neutral-700 bg-white hover:bg-neutral-50 transition-colors"
                  >
                    Logout
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="border border-neutral-200 bg-white rounded-2xl p-7 shadow-xs hover:border-neutral-300 transition-colors flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                Seller Flow
              </span>
              <span className="text-xs text-neutral-400 font-mono">Privy TEE</span>
            </div>
            <h2 className="text-lg font-bold text-neutral-900">For API Creators &amp; Sellers</h2>
            <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
              Log in with email, register your protected API endpoints, configure per-call stroop prices, and withdraw settled earnings directly to Turkish Lira via Stellar anchors.
            </p>
          </div>
          <div className="mt-6 pt-4 border-t border-neutral-100 flex items-center justify-between">
            <span className="text-xs text-neutral-500">Non-custodial identity &amp; signing</span>
            {authenticated ? (
              <Link href="/dashboard" className="text-xs font-bold text-indigo-600 hover:text-indigo-800">
                Go to Dashboard &rarr;
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => login()}
                className="text-xs font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
              >
                Sign in to start &rarr;
              </button>
            )}
          </div>
        </div>

        <div className="border border-neutral-200 bg-white rounded-2xl p-7 shadow-xs hover:border-neutral-300 transition-colors flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded">
                Agent Flow
              </span>
              <span className="text-xs text-neutral-400 font-mono">x402 v2 Client</span>
            </div>
            <h2 className="text-lg font-bold text-neutral-900">For Autonomous AI Agents</h2>
            <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
              Execute live 402 challenge probes, sign micropayments with Ed25519 agent keypairs, inspect wire headers, and test on-chain budget limits in real time.
            </p>
          </div>
          <div className="mt-6 pt-4 border-t border-neutral-100 flex items-center justify-between">
            <span className="text-xs text-neutral-500">Genesis Track Demo</span>
            <Link href="/agent-console" className="text-xs font-bold text-emerald-600 hover:text-emerald-800">
              Launch Agent Simulator &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
