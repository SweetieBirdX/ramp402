// `npm run test:integration`: tests that talk to the real Soroban RPC, the deployed contract and the
// anchor. They read gateway/.env and skip themselves when the variables they need are missing.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
  },
});
