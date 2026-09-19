// `npm test`: the offline unit suite. Every test here runs against a temporary database with the
// contract, x402 facilitator, Privy, Friendbot and upstreams faked; src/testing/offline.ts makes any
// real network connection fail. Tests that need testnet or the anchor are *.integration.test.ts
// and run only through `npm run test:integration` (vitest.integration.config.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    setupFiles: ["src/testing/offline.ts"],
  },
});
