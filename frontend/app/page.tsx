import Link from "next/link";

export default function HomePage() {
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

        <div className="mt-6 flex flex-wrap gap-4">
          <Link
            href="/dashboard"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-neutral-900 hover:bg-neutral-800"
          >
            Go to Seller Dashboard
          </Link>
          <Link
            href="/agent-console"
            className="inline-flex items-center px-4 py-2 border border-neutral-300 text-sm font-medium rounded-md text-neutral-700 bg-white hover:bg-neutral-50"
          >
            Open Agent Console
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="border border-neutral-200 bg-white rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-900">For Developers &amp; Sellers</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Log in with Privy, register your API endpoint, set a per-call stroop price, and track live earnings.
          </p>
          <div className="mt-4 p-3 bg-neutral-50 rounded-md text-xs text-neutral-500 font-mono">
            [ Placeholder: Privy Login / Signup CTA ]
          </div>
        </div>

        <div className="border border-neutral-200 bg-white rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-900">For Autonomous Agents</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Simulate x402 requests, monitor budget limits on-chain, and verify micropayment responses.
          </p>
          <div className="mt-4 p-3 bg-neutral-50 rounded-md text-xs text-neutral-500 font-mono">
            [ Placeholder: Demo Flow &amp; Quickstart ]
          </div>
        </div>
      </div>
    </div>
  );
}
