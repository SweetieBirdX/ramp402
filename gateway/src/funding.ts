// Silent account funding for new sellers. A Privy embedded wallet is only a keypair; it is not a
// ledger account until it holds the base reserve, and require_auth() fails against it until then.
// The seller never sees this step (CLAUDE.md "Known traps").

/** Friendbot per network. Pubnet has none: there, an unfunded seller is an error, not something we fix. */
export const FRIENDBOT_URLS: Record<string, string | undefined> = {
  "Test SDF Network ; September 2015": "https://friendbot.stellar.org",
};

export class FundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingError";
  }
}

export interface FunderDeps {
  accountExists: (address: string) => Promise<boolean>;
  /** Base URL, e.g. https://friendbot.stellar.org. Undefined disables funding (pubnet). */
  friendbotUrl: string | undefined;
  fetch?: typeof fetch;
  friendbotTimeoutMs?: number;
  /** After Friendbot answers, how often and how long to wait for the account to be visible via RPC. */
  confirmAttempts?: number;
  confirmIntervalMs?: number;
  log?: (line: string) => void;
}

export type FundingOutcome = "cached" | "already_funded" | "funded";

export function createFunder(deps: FunderDeps) {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.friendbotTimeoutMs ?? 30_000;
  const attempts = deps.confirmAttempts ?? 10;
  const intervalMs = deps.confirmIntervalMs ?? 1_000;
  const log = deps.log ?? (() => {});

  // Addresses verified on-chain in this process: repeat logins skip the network entirely.
  const funded = new Set<string>();
  // Concurrent bootstraps for one address share one Friendbot call.
  const inFlight = new Map<string, Promise<FundingOutcome>>();

  async function confirm(address: string): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (await deps.accountExists(address)) return true;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  async function fund(address: string): Promise<FundingOutcome> {
    if (await deps.accountExists(address)) {
      funded.add(address);
      return "already_funded";
    }
    if (!deps.friendbotUrl) {
      throw new FundingError(`Account ${address} is not funded and this network has no Friendbot`);
    }

    const started = Date.now();
    let friendbot: string;
    try {
      const res = await doFetch(`${deps.friendbotUrl}?addr=${encodeURIComponent(address)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A 400 "account already funded to starting balance" is success for us. So is any other answer
      // if the account turns out to exist: the on-chain check below is the only thing we trust.
      friendbot = `${res.status}`;
      await res.body?.cancel();
    } catch (err) {
      friendbot = err instanceof Error ? err.name : "error";
    }

    const exists = await confirm(address);
    log(`friendbot ${address} -> ${friendbot}, on-chain=${exists}, ${Date.now() - started}ms`);
    if (!exists) {
      throw new FundingError(`Friendbot did not fund ${address} (friendbot: ${friendbot})`);
    }
    funded.add(address);
    return "funded";
  }

  return {
    /** Resolves once `address` exists on the ledger; funds it through Friendbot if needed. */
    async ensureFunded(address: string): Promise<FundingOutcome> {
      if (funded.has(address)) return "cached";
      let pending = inFlight.get(address);
      if (!pending) {
        pending = fund(address).finally(() => inFlight.delete(address));
        inFlight.set(address, pending);
      }
      return pending;
    },
  };
}

export type Funder = ReturnType<typeof createFunder>;
