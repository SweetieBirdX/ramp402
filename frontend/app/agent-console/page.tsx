"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import {
  getOrCreateAgent,
  generateNewAgent,
  getAgentBalances,
  fundWithFriendbot,
  fundAgentWithUSDC,
  executeX402Call,
  type AgentAccount,
  type AgentBalances,
  type CallResult,
} from "@/lib/agent";
import { displayToStroops, stroopsToDisplay } from "@/lib/format";

/**
 * The demo endpoint's price, 0.50 USDC, matching `DEMO_PRICE_STROOPS` in scripts/lib/demo.ts.
 *
 * Used only for the console's own spent/remaining display before a call returns; the price the
 * agent actually pays comes from the 402's payment requirements, and the settled figure from
 * `CallResult.priceStroops`. If the demo endpoint is registered at another price via
 * DEMO_PRICE_STROOPS, only this progress bar is affected, never what is paid.
 */
const DEMO_PRICE_STROOPS_PER_CALL = 5_000_000;

export default function AgentConsolePage() {
  // Agent Account & Balances
  const [agent, setAgent] = useState<AgentAccount | null>(() => {
    if (typeof window !== "undefined") {
      return getOrCreateAgent();
    }
    return null;
  });
  const [balances, setBalances] = useState<AgentBalances>({
    xlm: "0",
    usdc: "0",
    exists: false,
    hasTrustline: false,
  });
  const [isRefreshingBalances, setIsRefreshingBalances] = useState(false);
  const [isFundingFriendbot, setIsFundingFriendbot] = useState(false);
  const [isFundingUSDC, setIsFundingUSDC] = useState(false);

  // Configuration Inputs
  const [proxySlug, setProxySlug] = useState("demo");
  // 1.75 buys three calls at 0.50 and refuses the fourth at 2.00. Sized so the seller's net
  // (1.485 after the 1% fee) clears the anchor's 1 USDC withdrawal floor and the demo can finish.
  const [budgetUsdc, setBudgetUsdc] = useState("1.75");
  const [omitBudgetHeader, setOmitBudgetHeader] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Execution & Call History State
  const [callHistory, setCallHistory] = useState<CallResult[]>([]);
  const [isCalling, setIsCalling] = useState(false);
  const [activeCallNumber, setActiveCallNumber] = useState(1);
  const [lastResult, setLastResult] = useState<CallResult | null>(null);
  const [expandedExchangeId, setExpandedExchangeId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // If SSR rendered without window, initialize agent once mounted
  useEffect(() => {
    if (!agent) {
      const acc = getOrCreateAgent();
      Promise.resolve().then(() => setAgent(acc));
    }
  }, [agent]);

  // Fetch balances
  const refreshBalances = useCallback(async (publicKey: string) => {
    setIsRefreshingBalances(true);
    setActionError(null);
    try {
      const b = await getAgentBalances(publicKey);
      setBalances(b);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load balances";
      setActionError(msg);
    } finally {
      setIsRefreshingBalances(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (agent?.publicKey) {
      getAgentBalances(agent.publicKey)
        .then((b) => {
          if (active) setBalances(b);
        })
        .catch((err: unknown) => {
          if (active) {
            const msg = err instanceof Error ? err.message : "Failed to load balances";
            setActionError(msg);
          }
        })
        .finally(() => {
          if (active) setIsRefreshingBalances(false);
        });
    }
    return () => {
      active = false;
    };
  }, [agent?.publicKey]);

  // Generate a new Agent keypair
  const handleGenerateNewAgent = () => {
    const fresh = generateNewAgent();
    setAgent(fresh);
    setCallHistory([]);
    setLastResult(null);
    setActiveCallNumber(1);
    refreshBalances(fresh.publicKey);
  };

  // Fund with Friendbot
  const handleFundFriendbot = async () => {
    if (!agent) return;
    setIsFundingFriendbot(true);
    setActionError(null);
    try {
      await fundWithFriendbot(agent.publicKey);
      await new Promise((r) => setTimeout(r, 1200));
      await refreshBalances(agent.publicKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Friendbot funding failed";
      setActionError(msg);
    } finally {
      setIsFundingFriendbot(false);
    }
  };

  // Fund with USDC (Trustline + SDEX swap from XLM)
  const handleFundUSDC = async () => {
    if (!agent) return;
    setIsFundingUSDC(true);
    setActionError(null);
    try {
      await fundAgentWithUSDC(agent);
      await new Promise((r) => setTimeout(r, 1500));
      await refreshBalances(agent.publicKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "USDC funding failed";
      setActionError(msg);
    } finally {
      setIsFundingUSDC(false);
    }
  };

  // Copy address or secret to clipboard
  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Compute budget figures
  const budgetStroops = displayToStroops(budgetUsdc || "0");
  const priceStroopsPerCall = DEMO_PRICE_STROOPS_PER_CALL;
  const successfulCalls = callHistory.filter((c) => c.status === 200).length;
  const spentStroops = successfulCalls * priceStroopsPerCall;
  const remainingStroops = Math.max(0, budgetStroops - spentStroops);
  const remainingUsdc = stroopsToDisplay(remainingStroops);
  const spentUsdc = stroopsToDisplay(spentStroops);
  const percentSpent =
    budgetStroops > 0 ? Math.min(100, Math.round((spentStroops / budgetStroops) * 100)) : 0;
  const isBudgetExhausted = spentStroops >= budgetStroops && budgetStroops > 0;

  // Execute x402 payment call against /proxy/:slug
  const handleCallEndpoint = async () => {
    if (!agent || isCalling) return;
    setIsCalling(true);
    setActionError(null);

    const isFirstCall = callHistory.length === 0;

    try {
      const result = await executeX402Call({
        slug: proxySlug.trim() || "demo",
        agent,
        budgetStroops,
        isFirstCall,
        omitBudgetHeader,
      });

      startTransition(() => {
        setLastResult(result);
        setCallHistory((prev) => [...prev, result]);
        setActiveCallNumber((prev) => prev + 1);
      });

      // Refresh balances in background
      setTimeout(() => {
        refreshBalances(agent.publicKey);
      }, 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Network error during x402 request";
      setActionError(msg);
    } finally {
      setIsCalling(false);
    }
  };

  // Reset demo session
  const handleResetSession = () => {
    setCallHistory([]);
    setLastResult(null);
    setActiveCallNumber(1);
    setActionError(null);
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-16">
      {/* ------------------------------------------------------------------------------------- */}
      {/* Page Header & Protocol Banner                                                          */}
      {/* ------------------------------------------------------------------------------------- */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-neutral-200 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-extrabold text-neutral-900 tracking-tight">
              Agent Console
            </h1>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200">
              x402 v2 Client
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
              Stellar Testnet
            </span>
          </div>
          <p className="mt-1.5 text-base text-neutral-600">
            Autonomous agent micropayment simulator &amp; on-chain spend limit demonstration (Steps 2 &amp; 3).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="inline-flex items-center px-4 py-2 border border-neutral-300 rounded-lg text-sm font-medium text-neutral-700 bg-white hover:bg-neutral-50 shadow-xs transition-colors"
          >
            Go to Seller Dashboard &rarr;
          </Link>
        </div>
      </div>

      {/* Global Action Error Alert */}
      {actionError && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm flex items-start justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-red-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
            <span>{actionError}</span>
          </div>
          <button
            onClick={() => setActionError(null)}
            className="text-red-500 hover:text-red-700 font-bold ml-4"
          >
            &times;
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------------------------------- */}
      {/* 1. Agent Keypair & Balances (Large, High-Contrast Stat Cards)                          */}
      {/* ------------------------------------------------------------------------------------- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Agent Address Card */}
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                Agent Identity (Keypair)
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleGenerateNewAgent}
                  title="Generate a brand new random agent keypair"
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium px-2 py-0.5 rounded-md hover:bg-indigo-50 border border-indigo-200"
                >
                  New Agent
                </button>
              </div>
            </div>

            <div className="mt-3">
              <div className="flex items-center gap-2">
                <code className="text-base font-mono font-bold text-neutral-900 truncate">
                  {agent ? `${agent.publicKey.slice(0, 10)}...${agent.publicKey.slice(-8)}` : "Generating..."}
                </code>
                {agent && (
                  <button
                    onClick={() => copyToClipboard(agent.publicKey, "addr")}
                    title="Copy full Stellar address"
                    className="text-neutral-400 hover:text-neutral-700 p-1"
                  >
                    {copiedKey === "addr" ? (
                      <span className="text-xs text-emerald-600 font-semibold">Copied!</span>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                    )}
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {agent?.isSeeded ? "Seeded from environment variable" : "Stored locally in browser localStorage"}
              </p>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-neutral-100 flex items-center justify-between text-xs">
            <span className="text-neutral-500">Account status:</span>
            {balances.exists ? (
              <span className="inline-flex items-center text-emerald-700 font-semibold gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span> Active on-chain
              </span>
            ) : (
              <span className="inline-flex items-center text-amber-700 font-medium gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span> Unfunded on testnet
              </span>
            )}
          </div>
        </div>

        {/* XLM Balance Card */}
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                Native Balance (XLM)
              </span>
              <button
                onClick={() => agent && refreshBalances(agent.publicKey)}
                disabled={isRefreshingBalances}
                className="text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-50"
              >
                {isRefreshingBalances ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            <div className="mt-2">
              <div className="text-3xl font-black text-neutral-900 tracking-tight">
                {parseFloat(balances.xlm).toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 4,
                })}{" "}
                <span className="text-lg font-medium text-neutral-500">XLM</span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">Gas &amp; fee reserve from Friendbot</p>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-neutral-100">
            <button
              onClick={handleFundFriendbot}
              disabled={isFundingFriendbot}
              className="w-full py-1.5 px-3 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-50 text-neutral-800 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
            >
              {isFundingFriendbot ? (
                <>
                  <svg className="animate-spin w-3.5 h-3.5 text-neutral-700" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span>Requesting 10,000 XLM...</span>
                </>
              ) : (
                <span>Fund via Friendbot (10k XLM)</span>
              )}
            </button>
          </div>
        </div>

        {/* USDC Balance Card */}
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                Payment Asset (USDC)
              </span>
              <span className="text-xs font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">
                Testnet Token
              </span>
            </div>

            <div className="mt-2">
              <div className="text-3xl font-black text-indigo-600 tracking-tight">
                {parseFloat(balances.usdc).toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 4,
                })}{" "}
                <span className="text-lg font-medium text-neutral-500">USDC</span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">Available for autonomous x402 payments</p>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-neutral-100">
            <button
              onClick={handleFundUSDC}
              disabled={isFundingUSDC || isFundingFriendbot}
              className="w-full py-1.5 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center justify-center gap-1.5"
            >
              {isFundingUSDC ? (
                <>
                  <svg className="animate-spin w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span>Swapping 200 XLM &rarr; USDC...</span>
                </>
              ) : (
                <span>Add Trustline &amp; Swap USDC</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------------------------- */}
      {/* 2. Visual Budget Meter & Spend Progress (Legible from across room)                     */}
      {/* ------------------------------------------------------------------------------------- */}
      <div className="bg-neutral-900 text-white rounded-2xl p-6 sm:p-8 shadow-lg border border-neutral-800">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-xs font-extrabold uppercase tracking-widest text-indigo-400">
                On-Chain Budget Guard
              </span>
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                  isBudgetExhausted
                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                    : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                }`}
              >
                {isBudgetExhausted ? "Budget Exhausted" : "Active Budget"}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <div>
                <span className="text-xs text-neutral-400 block">Remaining Budget</span>
                <span className="text-4xl sm:text-5xl font-black font-mono tracking-tight text-white">
                  {remainingUsdc}{" "}
                  <span className="text-xl sm:text-2xl font-normal text-neutral-400">USDC</span>
                </span>
              </div>

              <div className="border-l border-neutral-700 pl-6 hidden sm:block">
                <span className="text-xs text-neutral-400 block">Allocated on First Call</span>
                <span className="text-2xl font-bold font-mono text-neutral-300">
                  {budgetUsdc} USDC
                </span>
                <span className="text-xs text-neutral-400 block font-mono">
                  ({budgetStroops.toLocaleString()} stroops)
                </span>
              </div>

              <div className="border-l border-neutral-700 pl-6 hidden sm:block">
                <span className="text-xs text-neutral-400 block">Settled to Date</span>
                <span className="text-2xl font-bold font-mono text-indigo-400">
                  {spentUsdc} USDC
                </span>
                <span className="text-xs text-neutral-400 block">
                  {successfulCalls} successful calls
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 shrink-0">
            <button
              onClick={handleResetSession}
              className="px-4 py-2 text-xs font-semibold text-neutral-300 hover:text-white bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors"
            >
              Reset Session
            </button>
          </div>
        </div>

        {/* Big Progress Bar */}
        <div className="mt-6 space-y-2">
          <div className="w-full bg-neutral-800 h-4 rounded-full overflow-hidden border border-neutral-700/60 p-0.5">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                isBudgetExhausted
                  ? "bg-rose-500"
                  : percentSpent > 70
                  ? "bg-amber-400"
                  : "bg-emerald-400"
              }`}
              style={{ width: `${percentSpent}%` }}
            ></div>
          </div>

          <div className="flex justify-between items-center text-xs text-neutral-400 font-mono">
            <span>0 USDC (0%)</span>
            <span>
              {spentStroops.toLocaleString()} / {budgetStroops.toLocaleString()} stroops spent
            </span>
            <span>{budgetUsdc} USDC (100%)</span>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------------------------- */}
      {/* 3. Inputs & "Call endpoint" Trigger (Steps 2 & 3)                                      */}
      {/* ------------------------------------------------------------------------------------- */}
      <div className="bg-white rounded-xl border border-neutral-200 p-6 sm:p-8 shadow-xs space-y-6">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 tracking-tight">
            Execute x402 Micropayment Request
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Sends an unauthenticated probe to <code className="font-mono text-xs font-bold text-neutral-800">GET /proxy/:slug</code>,
            receives the <code className="font-mono text-xs font-bold text-amber-700 bg-amber-50 px-1 rounded">402 Payment Required</code> challenge,
            assembles and signs the payment with the agent keypair (<code className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 px-1 rounded">PAYMENT-SIGNATURE</code>),
            and retries for the 200 payload.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* Slug input */}
          <div>
            <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider">
              Proxy Target Slug
            </label>
            <div className="mt-1.5 flex rounded-md shadow-xs">
              <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-300 bg-neutral-50 text-neutral-500 text-xs font-mono">
                /proxy/
              </span>
              <input
                type="text"
                value={proxySlug}
                onChange={(e) => setProxySlug(e.target.value)}
                placeholder="demo"
                className="flex-1 min-w-0 block w-full px-3 py-2.5 rounded-none rounded-r-md border border-neutral-300 text-sm font-mono text-neutral-900 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <p className="mt-1 text-xs text-neutral-400">
              The demo endpoint registered in SQLite &amp; Soroban contract.
            </p>
          </div>

          {/* Budget input */}
          <div>
            <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider">
              Agent Spending Budget (USDC)
            </label>
            <div className="mt-1.5 flex rounded-md shadow-xs">
              <input
                type="text"
                value={budgetUsdc}
                onChange={(e) => setBudgetUsdc(e.target.value)}
                placeholder="0.30"
                className="flex-1 min-w-0 block w-full px-3 py-2.5 rounded-l-md border border-neutral-300 text-sm font-mono text-neutral-900 focus:ring-indigo-500 focus:border-indigo-500"
              />
              <span className="inline-flex items-center px-3 rounded-r-md border border-l-0 border-neutral-300 bg-neutral-50 text-neutral-500 text-xs font-medium">
                USDC
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="text-neutral-500 font-mono">
                = {budgetStroops.toLocaleString()} stroops
              </span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setBudgetUsdc("0.30")}
                  className="px-1.5 py-0.5 rounded bg-neutral-100 hover:bg-neutral-200 text-neutral-600 font-mono"
                >
                  0.30 (3 calls)
                </button>
                <button
                  type="button"
                  onClick={() => setBudgetUsdc("0.50")}
                  className="px-1.5 py-0.5 rounded bg-neutral-100 hover:bg-neutral-200 text-neutral-600 font-mono"
                >
                  0.50
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Missing Header Simulation Checkbox */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-neutral-50 border border-neutral-200 text-xs">
          <label className="flex items-center gap-2.5 font-semibold text-neutral-800 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={omitBudgetHeader}
              onChange={(e) => setOmitBudgetHeader(e.target.checked)}
              className="rounded border-neutral-300 text-amber-600 focus:ring-amber-500 h-4 w-4 cursor-pointer"
            />
            <span>
              Simulate Failure: <strong className="text-amber-800">Omit X-Agent-Budget Header</strong> (Demonstrates 400 Refusal)
            </span>
          </label>
          <span className="text-[11px] text-neutral-500 font-mono">
            {omitBudgetHeader ? (
              <span className="text-amber-700 font-bold">⚠ Header will be omitted</span>
            ) : (
              <span className="text-neutral-500">✓ Header will be sent</span>
            )}
          </span>
        </div>

        {/* Action Trigger Banner */}
        <div className="pt-4 border-t border-neutral-100 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-sm">
            <span className="text-neutral-500">Prepared Call:</span>{" "}
            <span className="font-bold text-neutral-800">Call #{activeCallNumber}</span>
            {isBudgetExhausted && (
              <span className="ml-2 text-xs font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200">
                Limit reached! Contract will refuse call on-chain (403)
              </span>
            )}
            {omitBudgetHeader && (
              <span className="ml-2 text-xs font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                Omission active (expects 400 refusal)
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={handleCallEndpoint}
            disabled={isCalling || !agent}
            className={`w-full sm:w-auto inline-flex items-center justify-center px-8 py-3.5 border border-transparent text-base font-bold rounded-xl shadow-md transition-all ${
              omitBudgetHeader
                ? "bg-amber-600 hover:bg-amber-700 text-white focus:ring-amber-500"
                : isBudgetExhausted
                ? "bg-rose-600 hover:bg-rose-700 text-white focus:ring-rose-500"
                : "bg-indigo-600 hover:bg-indigo-700 text-white focus:ring-indigo-500"
            } disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer`}
          >
            {isCalling ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin w-5 h-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span>Processing x402 V2 Exchange...</span>
              </span>
            ) : (
              <span>
                {omitBudgetHeader
                  ? `Execute Call #${activeCallNumber} (Trigger 400 Refusal)`
                  : isBudgetExhausted
                  ? `Execute Call #${activeCallNumber} (Trigger On-Chain Refusal)`
                  : `Call Endpoint #${activeCallNumber} (x402 Flow)`}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------------------------- */}
      {/* 4. Prominent Outcome Alerts (200 OK / 400 Bad Request / 403 Refused / 502 Upstream)   */}
      {/* ------------------------------------------------------------------------------------- */}
      {lastResult && (
        <div className="space-y-4">
          {/* 400 Missing Budget Header: Agent Safety Constraint */}
          {lastResult.status === 400 && (
            <div className="bg-amber-950 text-white border-2 border-amber-500 rounded-2xl p-6 sm:p-8 shadow-xl">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-amber-600 flex items-center justify-center shrink-0 shadow-md">
                  <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2.5"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>

                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-amber-500 text-neutral-950 uppercase tracking-wider">
                      HTTP 400 Bad Request · missing_budget_header
                    </span>
                    <span className="text-xs text-amber-300 font-semibold">
                      Autonomous Guard Rail Active
                    </span>
                  </div>

                  <h3 className="text-2xl font-black tracking-tight text-white">
                    Mandatory Budget Ceiling Missing
                  </h3>

                  <p className="text-base text-amber-200 leading-relaxed">
                    {lastResult.missingBudgetHeaderMessage ||
                      "The gateway refused the request because the agent omitted the X-Agent-Budget header on its initial call."}
                  </p>

                  <div className="mt-4 pt-4 border-t border-amber-800/80 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                    <div className="bg-amber-900/60 p-3 rounded-lg border border-amber-700/50">
                      <span className="text-amber-400 block font-sans font-bold">Why This Rule Exists:</span>
                      <span className="text-amber-100 font-sans leading-relaxed">
                        To protect autonomous agents from unbounded financial exposure, Ramp402 enforces an explicit budget ceiling on the smart contract before any x402 payment signature is accepted.
                      </span>
                    </div>

                    <div className="bg-amber-900/60 p-3 rounded-lg border border-amber-700/50">
                      <span className="text-amber-400 block font-sans font-bold">Financial Guarantee:</span>
                      <span className="text-emerald-300 font-sans font-semibold">
                        &check; Zero USDC charged. The challenge was aborted before payment was signed or submitted.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 403 Budget Exceeded: The Core Hackathon Demo Climax */}
          {lastResult.status === 403 && (
            <div className="bg-rose-950 text-white border-2 border-rose-500 rounded-2xl p-6 sm:p-8 shadow-xl">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-rose-600 flex items-center justify-center shrink-0 shadow-md">
                  <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2.5"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>

                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-rose-500 text-white uppercase tracking-wider">
                      HTTP 403 Forbidden · budget_exceeded
                    </span>
                    <span className="text-xs text-rose-300 font-semibold">
                      Demo Step 3 Achieved
                    </span>
                  </div>

                  <h3 className="text-2xl font-black tracking-tight text-white">
                    Autonomous Spend Limit Enforced On-Chain
                  </h3>

                  <p className="text-base text-rose-200">
                    {lastResult.budgetExceededMessage}
                  </p>

                  <div className="mt-4 pt-4 border-t border-rose-800/80 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                    <div className="bg-rose-900/60 p-3 rounded-lg border border-rose-700/50">
                      <span className="text-rose-400 block font-sans font-bold">Smart Contract Rejection Tx Hash:</span>
                      {lastResult.rejectedTxHash ? (
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${lastResult.rejectedTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-rose-100 hover:text-white underline break-all font-bold mt-0.5 inline-block"
                        >
                          {lastResult.rejectedTxHash} &rarr;
                        </a>
                      ) : (
                        <span className="text-rose-300 italic font-sans">
                          (Rejected during contract simulation or record_call)
                        </span>
                      )}
                    </div>

                    <div className="bg-rose-900/60 p-3 rounded-lg border border-rose-700/50">
                      <span className="text-rose-400 block font-sans font-bold">Safety Guarantee:</span>
                      <span className="text-emerald-300 font-sans font-semibold">
                        &check; Zero USDC deducted. Verified payment cancelled before settlement.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 200 OK: Successful Paid Micropayment */}
          {lastResult.status === 200 && (
            <div className="bg-emerald-950 text-white border-2 border-emerald-500 rounded-2xl p-6 sm:p-8 shadow-xl">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0 shadow-md">
                  <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2.5"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>

                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-500 text-white uppercase tracking-wider">
                      HTTP 200 OK · Micropayment Settled
                    </span>
                    <span className="text-xs text-emerald-300 font-semibold font-mono">
                      Spent: {stroopsToDisplay(lastResult.priceStroops || DEMO_PRICE_STROOPS_PER_CALL)} USDC
                    </span>
                  </div>

                  <h3 className="text-2xl font-black tracking-tight text-white">
                    Payment Verified &amp; Upstream Payload Received
                  </h3>

                  <p className="text-sm text-emerald-200">
                    The agent signed the x402 payment, the facilitator settled the USDC to the platform pool,
                    the ledger credited the seller, and the upstream data was returned.
                  </p>

                  {lastResult.settlementTxHash && (
                    <div className="mt-3 pt-3 border-t border-emerald-800/80 text-xs font-mono">
                      <span className="text-emerald-400 font-sans font-bold">On-Chain Settlement Receipt: </span>
                      <a
                        href={`https://stellar.expert/explorer/testnet/tx/${lastResult.settlementTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-emerald-100 hover:text-white underline break-all font-bold"
                      >
                        {lastResult.settlementTxHash} &rarr;
                      </a>
                    </div>
                  )}

                  {/* Upstream Payload Display */}
                  {lastResult.upstreamBody !== undefined && (
                    <div className="mt-3 bg-neutral-900/80 p-3 rounded-lg border border-neutral-700 text-xs font-mono text-emerald-400 overflow-x-auto">
                      <span className="text-neutral-500 block font-sans font-bold mb-1">Upstream Response Body:</span>
                      <pre>{JSON.stringify(lastResult.upstreamBody, null, 2)}</pre>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 502 Upstream Failed */}
          {lastResult.status === 502 && (
            <div className="bg-amber-950 text-white border-2 border-amber-500 rounded-2xl p-6 shadow-xl">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-amber-600 flex items-center justify-center shrink-0">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div className="space-y-1">
                  <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-500 text-neutral-900 uppercase">
                    HTTP 502 Bad Gateway · upstream_failed
                  </span>
                  <h3 className="text-lg font-bold text-white">Upstream Seller Service Failed</h3>
                  <p className="text-sm text-amber-200">{lastResult.upstreamFailedMessage}</p>
                  <p className="text-xs text-amber-300">
                    Call logged as upstream_failed; seller is not credited on-chain.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------------------------- */}
      {/* 5. Visible Request Log & x402 Protocol Trace                                          */}
      {/* ------------------------------------------------------------------------------------- */}
      <div className="bg-white rounded-xl border border-neutral-200 shadow-xs overflow-hidden">
        <div className="px-6 py-5 border-b border-neutral-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-neutral-900">
              Live x402 v2 Protocol Trace &amp; HTTP Exchanges
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Inspecting the real wire protocol: <code className="font-bold text-neutral-700">PAYMENT-REQUIRED</code> (402) &rarr; <code className="font-bold text-neutral-700">PAYMENT-SIGNATURE</code> (retry) &rarr; <code className="font-bold text-neutral-700">PAYMENT-RESPONSE</code> (200).
            </p>
          </div>
          <span className="text-xs font-mono font-semibold px-2.5 py-1 bg-neutral-100 text-neutral-700 rounded-md">
            {callHistory.length} calls logged
          </span>
        </div>

        {callHistory.length === 0 ? (
          <div className="p-12 text-center text-neutral-400 space-y-3">
            <svg
              className="w-12 h-12 mx-auto text-neutral-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <p className="text-sm font-medium text-neutral-600">No requests made yet in this session</p>
            <p className="text-xs text-neutral-400 max-w-sm mx-auto">
              Click &quot;Call Endpoint (x402 Flow)&quot; above to watch the two-step x402 challenge-response handshake live.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-200">
            {callHistory.map((call, callIdx) => (
              <div key={`call-${callIdx}`} className="p-6 space-y-4 hover:bg-neutral-50/50 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="w-7 h-7 rounded-full bg-neutral-900 text-white flex items-center justify-center font-bold text-xs">
                      #{callIdx + 1}
                    </span>
                    <span className="text-base font-bold text-neutral-900">
                      GET /proxy/{proxySlug}
                    </span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider ${
                        call.status === 200
                          ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                          : call.status === 403
                          ? "bg-rose-100 text-rose-800 border border-rose-200"
                          : call.status === 400
                          ? "bg-amber-100 text-amber-900 border border-amber-300"
                          : "bg-amber-100 text-amber-800 border border-amber-200"
                      }`}
                    >
                      Status {call.status} {call.status === 400 ? "· missing_budget" : call.status === 403 ? "· budget_exceeded" : call.status === 200 ? "· settled" : ""}
                    </span>
                  </div>

                  <span className="text-xs font-mono text-neutral-400">
                    {call.exchanges.length} HTTP exchanges
                  </span>
                </div>

                {/* Sub-steps of this call */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {call.exchanges.map((exchange) => (
                    <div
                      key={exchange.id}
                      className="border border-neutral-200 rounded-xl p-4 bg-white shadow-xs space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full ${
                              exchange.status === 402
                                ? "bg-amber-500"
                                : exchange.status === 200
                                ? "bg-emerald-500"
                                : "bg-rose-500"
                            }`}
                          ></span>
                          <span className="text-xs font-bold uppercase tracking-wider text-neutral-600">
                            {exchange.phase === "probe_402"
                              ? "Step 1: Probe Challenge (402)"
                              : "Step 2: Payment Retry"}
                          </span>
                        </div>
                        <span className="text-xs font-mono font-semibold text-neutral-500">
                          {exchange.durationMs}ms
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-neutral-700 font-bold">
                          {exchange.method} {exchange.url}
                        </span>
                        <span
                          className={`font-bold px-2 py-0.5 rounded ${
                            exchange.status === 402
                              ? "bg-amber-100 text-amber-900"
                              : exchange.status === 200
                              ? "bg-emerald-100 text-emerald-900"
                              : "bg-rose-100 text-rose-900"
                          }`}
                        >
                          HTTP {exchange.status} {exchange.statusText}
                        </span>
                      </div>

                      {/* Header highlights */}
                      <div className="space-y-1.5 pt-2 border-t border-neutral-100 text-xs font-mono">
                        {exchange.headersSent["X-Agent-Budget"] && (
                          <div className="flex items-center justify-between text-neutral-600 bg-neutral-50 p-1.5 rounded">
                            <span className="font-semibold text-indigo-700">X-Agent-Budget:</span>
                            <span>{exchange.headersSent["X-Agent-Budget"]} stroops</span>
                          </div>
                        )}

                        {exchange.headersReceived["payment-required"] && (
                          <div className="bg-amber-50 border border-amber-200 p-2 rounded text-amber-900 space-y-1">
                            <span className="font-bold block text-amber-800">
                              Header: PAYMENT-REQUIRED
                            </span>
                            <div className="text-[11px] text-amber-800 break-all truncate font-mono opacity-80">
                              {exchange.headersReceived["payment-required"].slice(0, 50)}...
                            </div>
                          </div>
                        )}

                        {exchange.headersSent["PAYMENT-SIGNATURE"] && (
                          <div className="bg-indigo-50 border border-indigo-200 p-2 rounded text-indigo-900 space-y-1">
                            <span className="font-bold block text-indigo-800">
                              Header: PAYMENT-SIGNATURE
                            </span>
                            <div className="text-[11px] text-indigo-800 break-all truncate font-mono opacity-80">
                              {exchange.headersSent["PAYMENT-SIGNATURE"].slice(0, 50)}...
                            </div>
                          </div>
                        )}

                        {exchange.headersReceived["payment-response"] && (
                          <div className="bg-emerald-50 border border-emerald-200 p-2 rounded text-emerald-900 space-y-1">
                            <span className="font-bold block text-emerald-800">
                              Header: PAYMENT-RESPONSE
                            </span>
                            <div className="text-[11px] text-emerald-800 break-all truncate font-mono opacity-80">
                              {exchange.headersReceived["payment-response"].slice(0, 50)}...
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Expandable JSON details */}
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedExchangeId(
                              expandedExchangeId === exchange.id ? null : exchange.id
                            )
                          }
                          className="text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1"
                        >
                          <span>
                            {expandedExchangeId === exchange.id
                              ? "Hide Decoded Headers"
                              : "Inspect Decoded Headers & Payload"}
                          </span>
                          <span>{expandedExchangeId === exchange.id ? "\u25B2" : "\u25BC"}</span>
                        </button>

                        {expandedExchangeId === exchange.id && (
                          <div className="mt-2 p-3 bg-neutral-900 text-neutral-200 rounded-lg text-[11px] font-mono overflow-x-auto space-y-2">
                            {exchange.decodedPaymentRequired !== undefined && (
                              <div>
                                <span className="text-amber-400 font-bold block">
                                  Decoded PAYMENT-REQUIRED:
                                </span>
                                <pre>{JSON.stringify(exchange.decodedPaymentRequired, null, 2)}</pre>
                              </div>
                            )}

                            {exchange.decodedPaymentSignature !== undefined && (
                              <div>
                                <span className="text-indigo-400 font-bold block">
                                  Decoded PAYMENT-SIGNATURE:
                                </span>
                                <pre>{JSON.stringify(exchange.decodedPaymentSignature, null, 2)}</pre>
                              </div>
                            )}

                            {exchange.decodedPaymentResponse !== undefined && (
                              <div>
                                <span className="text-emerald-400 font-bold block">
                                  Decoded PAYMENT-RESPONSE:
                                </span>
                                <pre>{JSON.stringify(exchange.decodedPaymentResponse, null, 2)}</pre>
                              </div>
                            )}

                            {exchange.responseBody !== undefined && (
                              <div>
                                <span className="text-neutral-400 font-bold block">Response Body:</span>
                                <pre>{JSON.stringify(exchange.responseBody, null, 2)}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
