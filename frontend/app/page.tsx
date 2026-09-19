"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

export default function HomePage() {
  const { ready, authenticated, email, stellarAddress, login, logout, isCreatingWallet } = useAuth();

  return (
    <div className="space-y-6">
      <div className="border border-neutral-200 bg-white rounded-lg p-8 shadow-xs">
        <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">
          Welcome to Ramp402
        </h1>
        <p className="mt-2 text-neutral-600 max-w-2xl">
          Monetize your APIs on the x402 protocol. Autonomous AI agents pay per call in USDC,
          and sellers withdraw their earnings directly to Turkish Lira via Stellar anchors.
        </p>

        <div className="mt-6">
          {!ready ? (
            <div className="h-10 w-40 bg-neutral-100 animate-pulse rounded-md" />
          ) : !authenticated ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => login()}
                  className="inline-flex items-center px-5 py-2.5 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-neutral-900 hover:bg-neutral-800 transition-colors"
                >
                  Log In with Email
                </button>
                <Link
                  href="/agent-console"
                  className="inline-flex items-center px-4 py-2 border border-neutral-300 text-sm font-medium rounded-md text-neutral-700 bg-white hover:bg-neutral-50 transition-colors"
                >
                  Open Agent Console
                </Link>
              </div>
              <p className="text-xs text-neutral-500">
                Email onboarding automatically provisions an embedded Stellar keypair.
              </p>
            </div>
          ) : (
            <div className="space-y-4 p-5 rounded-lg bg-neutral-50 border border-neutral-200">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 mb-2">
                    Authenticated
                  </span>
                  <p className="text-sm font-medium text-neutral-900">
                    Logged in as: <span className="font-semibold">{email || "Seller"}</span>
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-neutral-500 font-medium">Stellar Address:</span>
                    {isCreatingWallet ? (
                      <span className="text-xs text-amber-600 font-mono animate-pulse">
                        Provisioning embedded Stellar wallet...
                      </span>
                    ) : stellarAddress ? (
                      <code className="text-xs font-mono bg-white px-2 py-0.5 border border-neutral-200 rounded-md text-neutral-800 select-all">
                        {stellarAddress}
                      </code>
                    ) : (
                      <span className="text-xs text-neutral-400 font-mono">None detected</span>
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
        <div className="border border-neutral-200 bg-white rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-900">For Developers &amp; Sellers</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Log in with Privy, register your API endpoint, set a per-call stroop price, and track live earnings.
          </p>
          <div className="mt-4 pt-4 border-t border-neutral-100 flex items-center justify-between">
            <span className="text-xs text-neutral-500">Non-custodial identity &amp; signing</span>
            {authenticated ? (
              <Link href="/dashboard" className="text-xs font-medium text-neutral-900 hover:underline">
                View Dashboard &rarr;
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => login()}
                className="text-xs font-medium text-neutral-900 hover:underline"
              >
                Sign in to start &rarr;
              </button>
            )}
          </div>
        </div>

        <div className="border border-neutral-200 bg-white rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-900">For Autonomous Agents</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Simulate x402 requests, monitor budget limits on-chain, and verify micropayment responses.
          </p>
          <div className="mt-4 pt-4 border-t border-neutral-100 flex items-center justify-between">
            <span className="text-xs text-neutral-500">Genesis Track Demo</span>
            <Link href="/agent-console" className="text-xs font-medium text-neutral-900 hover:underline">
              Launch Agent Simulator &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
