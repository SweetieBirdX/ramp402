"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Header() {
  const pathname = usePathname();
  const { ready, authenticated, email, stellarAddress, login, logout } = useAuth();

  const navLinks = [
    { href: "/", label: "Home" },
    { href: "/dashboard", label: "Seller Dashboard" },
    { href: "/agent-console", label: "Agent Console" },
  ];

  return (
    <header className="border-b border-neutral-200 bg-white sticky top-0 z-30 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          {/* Deliberate Ramp402 Brand Treatment */}
          <Link
            href="/"
            className="flex items-center gap-2.5 group transition-opacity hover:opacity-95"
            title="Ramp402 · Pay-per-call API monetization & anchor off-ramp"
          >
            <div className="h-8 w-8 rounded-lg bg-neutral-900 text-white flex items-center justify-center font-mono font-black text-xs shadow-xs border border-neutral-800 tracking-tighter group-hover:bg-indigo-900 transition-colors">
              402
            </div>
            <div className="flex flex-col">
              <span className="text-xl font-black tracking-tight text-neutral-900 leading-none">
                Ramp<span className="text-indigo-600">402</span>
              </span>
              <span className="text-[10px] font-semibold text-neutral-400 uppercase tracking-widest leading-tight mt-0.5">
                Stellar Protocol
              </span>
            </div>
          </Link>

          {/* Navigation with active state indicators */}
          <nav className="hidden sm:flex items-center gap-1 text-sm font-medium">
            {navLinks.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname?.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    isActive
                      ? "bg-neutral-900 text-white shadow-xs"
                      : "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right side status & auth */}
        <div className="flex items-center gap-4">
          <div className="hidden lg:flex items-center gap-2 text-xs font-mono bg-neutral-50 px-2.5 py-1 rounded-md border border-neutral-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-neutral-600 font-semibold">Testnet</span>
            <span className="text-neutral-300">|</span>
            <span className="text-indigo-600 font-semibold">x402 v2</span>
          </div>

          {!ready ? (
            <div className="h-8 w-24 bg-neutral-100 animate-pulse rounded-md" />
          ) : authenticated ? (
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-xs font-semibold text-neutral-800">
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
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-neutral-300 text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900 transition-colors shadow-xs"
              >
                Logout
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => login()}
              className="px-4 py-2 text-xs font-bold rounded-lg text-white bg-neutral-900 hover:bg-neutral-800 transition-colors shadow-xs"
            >
              Seller Login
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
