export default function AgentConsolePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">Agent Console</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Autonomous agent simulator and live demonstration runner for the x402 payment flow.
        </p>
      </div>

      <div className="border border-neutral-200 bg-white rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold text-neutral-900">Request Configuration</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Proxy Target / Slug
            </label>
            <input
              type="text"
              disabled
              placeholder="e.g. weather-api-xyz"
              className="mt-1 block w-full px-3 py-2 border border-neutral-300 rounded-md shadow-xs text-sm bg-neutral-50 text-neutral-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Agent Budget (stroops)
            </label>
            <input
              type="text"
              disabled
              placeholder="e.g. 17500000 (1.75 USDC)"
              className="mt-1 block w-full px-3 py-2 border border-neutral-300 rounded-md shadow-xs text-sm bg-neutral-50 text-neutral-500"
            />
          </div>
        </div>

        <div className="pt-2">
          <button
            type="button"
            disabled
            className="inline-flex items-center px-4 py-2 border border-neutral-300 text-sm font-medium rounded-md text-neutral-400 bg-neutral-100 cursor-not-allowed"
          >
            Send x402 Request
          </button>
        </div>
      </div>

      <div className="border border-neutral-200 bg-white rounded-lg p-6">
        <h2 className="text-lg font-semibold text-neutral-900">Console Output &amp; Payment Trace</h2>
        <div className="mt-4 bg-neutral-900 text-neutral-100 rounded-md p-4 font-mono text-xs overflow-x-auto min-h-[160px]">
          <p className="text-neutral-500">{"// Agent console output will stream here..."}</p>
          <p className="text-neutral-500">{"// Step 1: Initial GET -> 402 Payment Required"}</p>
          <p className="text-neutral-500">{"// Step 2: Sign X-PAYMENT -> 200 OK + payload"}</p>
          <p className="text-neutral-500">{"// Step 3: On-chain budget enforcement & settle"}</p>
        </div>
      </div>
    </div>
  );
}
