import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ramp402 — Pay-per-call Payment Gateway",
  description: "Pay-per-call micropayment gateway for APIs with instant local off-ramp",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900 font-sans">
        <header className="border-b border-neutral-200 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <div className="flex items-center gap-8">
              <Link href="/" className="text-xl font-bold tracking-tight text-neutral-900 hover:text-neutral-700">
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
              <div
                id="auth-placeholder"
                className="px-3 py-1.5 rounded-md border border-dashed border-neutral-300 bg-neutral-50 text-xs text-neutral-500 font-mono"
              >
                [ Auth Placeholder ]
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
