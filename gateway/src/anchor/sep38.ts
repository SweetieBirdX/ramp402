// SEP-38: lock an exchange rate before withdrawing, so the seller is told what they will actually
// receive rather than finding out afterwards.
//
// Quotes are SINGLE USE and expire (15 minutes on most anchors). Both facts matter here: a quote
// reused on a retry is rejected, and one that lapses between being taken and the payment landing
// has to be replaced rather than sent anyway.
import { anchorFetch } from "./http.js";
import { sep38Asset, type AnchorEndpoints } from "./toml.js";

export interface Sep38Quote {
  id: string;
  /** ISO timestamp from the anchor. */
  expiresAt: string;
  /** What the seller receives, as the anchor wrote it, e.g. "485.41". */
  buyAmount: string;
  /** e.g. `iso4217:TRY`. */
  buyAsset: string;
  sellAmount: string;
  /** Rate including fees, for display. */
  totalPrice?: string;
}

interface QuoteResponse {
  id: string;
  expires_at: string;
  price?: string;
  total_price?: string;
  sell_amount: string;
  buy_amount: string;
  buy_asset: string;
}

interface Sep38InfoResponse {
  assets?: { asset: string }[];
}

/**
 * The fiat asset this anchor pays out in, discovered from its own /info.
 *
 * Never hardcoded: tr-mock-anchor sells `iso4217:TRY`, testanchor.stellar.org sells `iso4217:USD`
 * and `iso4217:CAD`, and the whole point of reading SEP-38 is to work with whichever we are given.
 * `preferred` lets the caller ask for TRY and still get a working withdrawal elsewhere.
 */
export async function resolvePayoutAsset(
  anchor: AnchorEndpoints,
  preferred = "TRY",
): Promise<string> {
  if (!anchor.quote) {
    throw new Error(`${anchor.homeDomain} has no ANCHOR_QUOTE_SERVER, so it cannot quote a payout currency`);
  }
  const info = await anchorFetch<Sep38InfoResponse>(`${anchor.quote}/info`);
  const fiat = (info.assets ?? []).map((a) => a.asset).filter((a) => a.startsWith("iso4217:"));
  if (fiat.length === 0) {
    throw new Error(`${anchor.homeDomain} quotes no fiat asset at all`);
  }

  const wanted = sep38Asset.fiat(preferred);
  return fiat.includes(wanted) ? wanted : (fiat[0] as string);
}

/**
 * Ask for a firm quote selling `sellAmount` of the asset for fiat.
 *
 * `context: "sep6"` matters — an anchor prices differently per flow, and a sep24 quote is not
 * accepted by a sep6 withdrawal.
 */
export async function requestQuote(
  anchor: AnchorEndpoints,
  token: string,
  params: {
    assetCode: string;
    sellAmount: string;
    buyAsset: string;
  },
): Promise<Sep38Quote> {
  if (!anchor.quote) throw new Error(`${anchor.homeDomain} has no ANCHOR_QUOTE_SERVER`);

  const sellAsset = sep38Asset.stellar(params.assetCode, anchor.assetIssuer(params.assetCode));
  const quote = await anchorFetch<QuoteResponse>(`${anchor.quote}/quote`, {
    method: "POST",
    token,
    body: {
      context: "sep6",
      sell_asset: sellAsset,
      buy_asset: params.buyAsset,
      sell_amount: params.sellAmount,
    },
  });

  return {
    id: quote.id,
    expiresAt: quote.expires_at,
    buyAmount: quote.buy_amount,
    buyAsset: quote.buy_asset,
    sellAmount: quote.sell_amount,
    totalPrice: quote.total_price ?? quote.price,
  };
}

/** Would this quote still be valid `marginMs` from now? Used before spending it on a payment. */
export function quoteIsUsable(quote: Sep38Quote, marginMs = 60_000): boolean {
  const expiry = Date.parse(quote.expiresAt);
  if (Number.isNaN(expiry)) return true; // no parseable expiry: let the anchor be the judge
  return expiry - marginMs > Date.now();
}
