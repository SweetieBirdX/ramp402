// zod validators for the §1.3 request shapes. Each is annotated with its interface from types.ts,
// so a field renamed on one side and not the other is a compile error, not an integration bug.
// Objects are strict: an unknown field (a typo like `price` for `price_stroops`) is rejected.
import { z } from "zod";
import type {
  BootstrapSellerRequest,
  GetWithdrawalParams,
  ListCallsQuery,
  PrepareEndpointRequest,
  PrepareWithdrawRequest,
  ProxyParams,
  SubmitEndpointRequest,
  SubmitWithdrawRequest,
} from "./types.js";

const U64_MAX = (1n << 64n) - 1n;

/** Integer stroops (§1.1). Must be a JSON number, never a decimal and never a string. */
export const stroops = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const DECIMAL = /^(0|[1-9]\d*)$/;

/** endpoint_id on the wire: the decimal string of a u64. */
export const endpointIdString = z
  .string()
  .regex(DECIMAL, "must be the decimal string form of a u64")
  // zod v4 runs every check even after one fails, so this must not assume the regex passed.
  .refine((s) => !DECIMAL.test(s) || BigInt(s) <= U64_MAX, "exceeds u64");

const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048);

const draftId = z.string().min(1).max(64);
const xdr = z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64 XDR");

/** No body: accepts a missing body or `{}` and nothing else. */
const empty = z.object({}).strict();

export const bootstrapSellerRequest: z.ZodType<BootstrapSellerRequest> = empty;

export const prepareEndpointRequest: z.ZodType<PrepareEndpointRequest> = z
  .object({
    upstream_url: httpUrl,
    price_stroops: stroops.positive(),
  })
  .strict();

export const submitEndpointRequest: z.ZodType<SubmitEndpointRequest> = z
  .object({ draft_id: draftId, signed_xdr: xdr })
  .strict();

export const prepareWithdrawRequest: z.ZodType<PrepareWithdrawRequest> = empty;

export const submitWithdrawRequest: z.ZodType<SubmitWithdrawRequest> = z
  .object({ draft_id: draftId, signed_xdr: xdr })
  .strict();

export const getWithdrawalParams: z.ZodType<GetWithdrawalParams> = z.object({
  id: z.string().min(1).max(64),
});

export const listCallsQuery: z.ZodType<ListCallsQuery> = z.object({
  endpoint_id: endpointIdString,
});

export const proxyParams: z.ZodType<ProxyParams> = z.object({
  proxy_slug: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be a URL-safe slug"),
});

/** X-Agent-Budget, when present: integer stroops as a decimal string. Whether it is required is decided per call. */
export const agentBudgetHeader = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a positive integer number of stroops")
  .refine((s) => Number.isSafeInteger(Number(s)), "too large")
  .optional();
