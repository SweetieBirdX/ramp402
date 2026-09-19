"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

export default function Header() {
  const { ready, authenticated, email, stellarAddress, login, logout } = useAuth();

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="text-xl font-bold tracking-tight text-neutral-900 hover:text-neutral-700"
          >
            Ramp402
          </Link>
          <nav className="flex items-center gap-4 text-sm font-medium text-neutral-600">
            <Link href="/" className="hover:text-neutral-900">
              Home
            </Link>
            <Link href="/dashboard" className="hover:text-neutral-900">
              Seller Dashboard
            </Link>
            <Link href="/agent-console" className="hover:text-neutral-900">
              Agent Console
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {!ready ? (
            <div className="h-8 w-24 bg-neutral-100 animate-pulse rounded-md" />
          ) : authenticated ? (
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-xs font-medium text-neutral-800">
                  {email || "Seller Account"}
                </p>
                {stellarAddress && (
                  <p className="text-[10px] text-neutral-400 font-mono">
                    {stellarAddress.slice(0, 4)}...{stellarAddress.slice(-4)}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => logout()}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-neutral-300 text-neutral-700 hover:bg-neutral-50 transition-colors"
              >
                Logout
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => login()}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-white bg-neutral-900 hover:bg-neutral-800 transition-colors"
            >
              Login
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
