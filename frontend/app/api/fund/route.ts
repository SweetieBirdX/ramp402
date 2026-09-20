import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Server-side Friendbot funding for the agent console's throwaway account.
 *
 * The browser does not call Friendbot. Not because Friendbot refuses it — it sends
 * `access-control-allow-origin: *` and answers a preflight with 204 — but because a faucet call is
 * infrastructure, and infrastructure belongs behind our own origin where the outcome can be
 * classified once, consistently, instead of in a component's catch.
 *
 * Seller onboarding is unaffected: the gateway has always funded sellers itself in
 * `POST /api/sellers/bootstrap` (gateway/src/funding.ts), and it verifies the account on chain
 * before reporting success.
 *
 * WHAT FRIENDBOT ACTUALLY RETURNS, captured rather than inferred:
 *
 *   fresh account  200  {"successful":true,"hash":"c5885b74…", …}
 *   funded already 400  {"type":"https://stellar.org/friendbot-errors/bad_request",
 *                        "title":"Bad Request","status":400,
 *                        "detail":"account already funded to starting balance"}
 *
 * So a 400 is not a failure; it is the faucet saying the job is already done. Anything else is a
 * real failure and is reported as one — never swallowed, because a silently skipped funding step
 * surfaces three actions later as an incomprehensible "account not found".
 */
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

export async function POST(req: Request) {
  let address: string;
  try {
    const body = (await req.json()) as { address?: unknown };
    if (typeof body.address !== "string" || !G_ADDRESS.test(body.address)) {
      return NextResponse.json(
        { error: "invalid_request", message: "address must be a classic G… public key" },
        { status: 400 },
      );
    }
    address = body.address;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "body must be JSON" }, { status: 400 });
  }

  // Already funded? Then there is nothing to ask the faucet for.
  if (await accountExists(address)) {
    return NextResponse.json({ funded: true, outcome: "already_funded" });
  }

  let status: number;
  let text: string;
  try {
    const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    return NextResponse.json(
      {
        error: "friendbot_unreachable",
        message: `Friendbot could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  const alreadyFunded = text.includes("already funded") || text.includes("op_already_exists");
  if (!(status === 200 || alreadyFunded)) {
    // A real refusal — rate limiting, a faucet outage, a malformed address. Say so, with the
    // faucet's own words, rather than pretending the account is ready.
    return NextResponse.json(
      {
        error: "friendbot_refused",
        message: `Friendbot refused to fund ${address}`,
        friendbot_status: status,
        friendbot_body: text.slice(0, 400),
      },
      { status: 502 },
    );
  }

  // Friendbot answering is not the same as the account existing. Confirm before claiming success,
  // so the caller never proceeds against an account Horizon has not seen yet.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await accountExists(address)) {
      return NextResponse.json({ funded: true, outcome: alreadyFunded ? "already_funded" : "funded" });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return NextResponse.json(
    {
      error: "funding_unconfirmed",
      message: `Friendbot answered ${status} for ${address} but Horizon still does not show the account.`,
      friendbot_status: status,
      friendbot_body: text.slice(0, 400),
    },
    { status: 502 },
  );
}

async function accountExists(address: string): Promise<boolean> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`, { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}
