import { HttpError } from "../http-client.js";
import { unwrapUntrustedOcr } from "../mcp-json.js";

export interface AccountBindingRefusal {
  code: "account_not_bank_bindable";
  account_number: string;
  next_action: string;
  upstream_detail: string;
}

/** Only the register endpoint's specific refusal is interpreted; no chart flags are guessed. */
export function accountBindingRefusal(error: unknown): AccountBindingRefusal | undefined {
  if (!(error instanceof HttpError) || error.status !== 409 || error.method !== "PATCH"
    || !/^\/transactions\/\d+\/register$/.test(error.path) || !error.upstream_detail) return undefined;
  const match = /^The account (\d+) has not been allowed to be reconciled \(\[[\d,\s]*\]\)!$/.exec(
    unwrapUntrustedOcr(error.upstream_detail).trim(),
  );
  if (!match) return undefined;
  return {
    code: "account_not_bank_bindable",
    account_number: match[1]!,
    next_action: `Account ${match[1]} cannot be used on a bank row in e-arveldaja — enable it in the chart settings, choose an allowed account, or book a separate journal.`,
    upstream_detail: error.upstream_detail,
  };
}

export class AccountNotBankBindableError extends HttpError implements AccountBindingRefusal {
  readonly code = "account_not_bank_bindable";
  readonly account_number: string;
  readonly next_action: string;
  declare readonly upstream_detail: string;

  constructor(error: HttpError, refusal: AccountBindingRefusal) {
    super(refusal.next_action, error.status, error.method, error.path, { upstream_detail: refusal.upstream_detail });
    this.name = "AccountNotBankBindableError";
    this.account_number = refusal.account_number;
    this.next_action = refusal.next_action;
  }
}
