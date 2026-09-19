// Setup file for `npm test` (vitest.config.ts). The unit suite must run offline and must never touch
// the real ramp402.db; this enforces both instead of trusting every test file to remember.
//
// - Any socket to a non-loopback host fails with OFFLINE_GUARD. Loopback stays open because
//   supertest talks to the app on 127.0.0.1. This sits under fetch, http, https and the Stellar
//   SDK's axios alike, since all of them end in net.Socket#connect.
// - DB_PATH points into a throwaway directory, so a stray getDb() cannot open the demo database.
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OFFLINE_GUARD = "OFFLINE_GUARD: the unit suite may not open network connections";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Every host a test tried to reach and was refused — some clients (the Stellar SDK) drop the cause. */
export const blockedHosts: string[] = [];

/** The host a connect() call targets, across its (options), (port, host) and normalized-array forms. */
function targetHost(args: unknown[]): string | undefined {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "number") return typeof args[1] === "string" ? args[1] : "localhost";
  if (typeof first === "string") return undefined; // IPC path
  if (first && typeof first === "object") {
    const opts = first as { host?: string; path?: string };
    if (opts.path) return undefined;
    return opts.host ?? "localhost";
  }
  return "localhost";
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const host = targetHost(args);
  if (host !== undefined && !LOOPBACK.has(host)) {
    blockedHosts.push(host);
    process.nextTick(() => this.destroy(new Error(`${OFFLINE_GUARD} (tried ${host})`)));
    return this;
  }
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "ramp402-unit-")), "never-the-real.db");
