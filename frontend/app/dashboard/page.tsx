"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function DashboardPage() {
  const { ready, authenticated, stellarAddress, email } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !authenticated) {
      router.replace("/");
    }
  }, [ready, authenticated, router]);

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

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">Seller Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Manage your monetized endpoints, view on-chain balance, and withdraw to TRY.
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
            <span>Account:</span>
            <span className="font-semibold text-neutral-700">{email}</span>
            <span className="text-neutral-300">|</span>
            <span>Stellar Address:</span>
            <code className="font-mono bg-white px-2 py-0.5 border border-neutral-200 rounded text-neutral-800">
              {stellarAddress || "Pending creation..."}
            </code>
          </div>
        </div>

        <button
          type="button"
          disabled
          className="inline-flex items-center px-4 py-2 border border-neutral-300 text-sm font-medium rounded-md text-neutral-400 bg-neutral-100 cursor-not-allowed self-start sm:self-auto"
        >
          + Register Endpoint
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div className="border border-neutral-200 bg-white rounded-lg p-5">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">On-Chain Balance</p>
          <p className="mt-2 text-3xl font-bold text-neutral-900">0.00 USDC</p>
          <p className="mt-1 text-xs text-neutral-500 font-mono">0 stroops</p>
        </div>
        <div className="border border-neutral-200 bg-white rounded-lg p-5">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Active Endpoints</p>
          <p className="mt-2 text-3xl font-bold text-neutral-900">0</p>
          <p className="mt-1 text-xs text-neutral-500 font-mono">Registered on-chain</p>
        </div>
        <div className="border border-neutral-200 bg-white rounded-lg p-5">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Total Calls Served</p>
          <p className="mt-2 text-3xl font-bold text-neutral-900">0</p>
          <p className="mt-1 text-xs text-neutral-500 font-mono">Paid via x402</p>
        </div>
      </div>

      <div className="border border-neutral-200 bg-white rounded-lg p-6">
        <h2 className="text-lg font-semibold text-neutral-900">Endpoints</h2>
        <div className="mt-4 p-8 text-center border border-dashed border-neutral-200 rounded-md">
          <p className="text-sm text-neutral-500">No endpoints registered yet.</p>
          <p className="text-xs text-neutral-400 mt-1">Endpoint registration will be enabled in the next step.</p>
        </div>
      </div>

      <div className="border border-neutral-200 bg-white rounded-lg p-6">
        <h2 className="text-lg font-semibold text-neutral-900">Recent Calls</h2>
        <div className="mt-4 p-8 text-center border border-dashed border-neutral-200 rounded-md">
          <p className="text-sm text-neutral-500">No calls recorded yet.</p>
        </div>
      </div>
    </div>
  );
}
