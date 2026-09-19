export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">Seller Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Manage your monetized endpoints, view on-chain balance, and withdraw to TRY.
          </p>
        </div>
        <button
          type="button"
          disabled
          className="inline-flex items-center px-4 py-2 border border-neutral-300 text-sm font-medium rounded-md text-neutral-400 bg-neutral-100 cursor-not-allowed"
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
          <p className="text-xs text-neutral-400 mt-1">Connect your wallet to register an upstream API.</p>
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
