import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Same-origin bridge to Gateway GET /proxy/:proxy_slug for browser clients.
 * Forwards all headers (including PAYMENT-SIGNATURE and X-Agent-Budget)
 * and exposes all response headers (PAYMENT-REQUIRED, PAYMENT-RESPONSE) to the browser.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;
  const gatewayUrl = (
    process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:3001"
  ).replace(/\/+$/, "");
  const targetUrl = `${gatewayUrl}/proxy/${encodeURIComponent(slug)}${req.nextUrl.search}`;

  const forwardHeaders = new Headers();
  req.headers.forEach((val, key) => {
    const lower = key.toLowerCase();
    if (lower !== "host" && lower !== "connection") {
      forwardHeaders.set(key, val);
    }
  });

  try {
    const res = await fetch(targetUrl, {
      method: "GET",
      headers: forwardHeaders,
      cache: "no-store",
    });

    const responseHeaders = new Headers();
    res.headers.forEach((val, key) => {
      responseHeaders.set(key, val);
    });

    // Expose x402 headers to browser JavaScript
    responseHeaders.set(
      "Access-Control-Expose-Headers",
      "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Agent-Budget, Content-Type"
    );

    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to connect to gateway";
    return NextResponse.json(
      { error: "internal_error", message },
      { status: 500 }
    );
  }
}
