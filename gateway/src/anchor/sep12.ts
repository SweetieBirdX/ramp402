// SEP-12: satisfy whatever KYC the anchor asks for.
//
// The field list is NEVER hardcoded (checklist §C). We ask the anchor what it wants, and answer
// exactly that. Anchors differ, the same anchor changes its mind between environments, and a
// hardcoded list produces a withdrawal that is stuck on a field nobody can see.
import { anchorFetch } from "./http.js";
import type { AnchorEndpoints } from "./toml.js";

export interface Sep12Field {
  type?: string;
  description?: string;
  optional?: boolean;
  choices?: string[];
}

export interface Sep12Customer {
  id?: string;
  /** NEEDS_INFO | ACCEPTED | PROCESSING | REJECTED */
  status: string;
  message?: string;
  /** What the anchor still wants, keyed by field name. */
  fields: Record<string, Sep12Field>;
  /** What it already has. */
  providedFields: Record<string, Sep12Field & { status?: string }>;
}

interface CustomerResponse {
  id?: string;
  status?: string;
  message?: string;
  fields?: Record<string, Sep12Field>;
  provided_fields?: Record<string, Sep12Field & { status?: string }>;
}

export async function getCustomer(
  anchor: AnchorEndpoints,
  token: string,
  account: string,
): Promise<Sep12Customer> {
  if (!anchor.kyc) throw new Error(`${anchor.homeDomain} has no KYC_SERVER`);
  const response = await anchorFetch<CustomerResponse>(`${anchor.kyc}/customer`, {
    token,
    query: { account },
  });
  return {
    id: response.id,
    status: response.status ?? "NEEDS_INFO",
    message: response.message,
    fields: response.fields ?? {},
    providedFields: response.provided_fields ?? {},
  };
}

/**
 * Send the fields the anchor asked for.
 *
 * `values` supplies what we know; anything else REQUIRED is refused loudly rather than guessed —
 * inventing a customer's identity data would be worse than failing. Optional fields we cannot fill
 * are simply left out.
 */
export async function putCustomer(
  anchor: AnchorEndpoints,
  token: string,
  account: string,
  required: Record<string, Sep12Field>,
  values: Record<string, string>,
): Promise<{ id?: string }> {
  if (!anchor.kyc) throw new Error(`${anchor.homeDomain} has no KYC_SERVER`);

  const missing = Object.entries(required)
    .filter(([name, field]) => field.optional !== true && values[name] === undefined)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `${anchor.homeDomain} requires KYC fields this gateway cannot supply: ${missing.join(", ")}. ` +
        `Collect them from the seller before withdrawing.`,
    );
  }

  const payload: Record<string, string> = { account };
  for (const name of Object.keys(required)) {
    const value = values[name];
    if (value !== undefined) payload[name] = value;
  }

  return await anchorFetch<{ id?: string }>(`${anchor.kyc}/customer`, {
    method: "PUT",
    token,
    body: payload,
  });
}

/**
 * Bring the customer to a state the anchor will accept, and report what it says.
 *
 * Returns the final status rather than throwing on NEEDS_INFO: a withdrawal blocked on KYC is a
 * thing to surface to the seller, not a crash.
 */
export async function ensureCustomerAccepted(
  anchor: AnchorEndpoints,
  token: string,
  account: string,
  values: Record<string, string>,
): Promise<Sep12Customer> {
  const customer = await getCustomer(anchor, token, account);
  if (customer.status === "ACCEPTED" || Object.keys(customer.fields).length === 0) return customer;

  await putCustomer(anchor, token, account, customer.fields, values);
  return await getCustomer(anchor, token, account);
}
