import type { Client } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { logAudit } from "../audit-log.js";
import { normalizeVatValue } from "../document-identifiers.js";
import { validateLegalEntityIdentity } from "../legal-entity-identity.js";
import { desandboxText } from "../external-text-renderer.js";
import { matchSupplier } from "../resolution/supplier-default-resolution.js";
import {
  type ExtractedReceiptFields,
  type TransactionClassificationCategory,
  inferSupplierCountry,
  looksLikePersonCounterparty,
  normalizeCounterpartyName,
} from "./receipt-extraction.js";

// The pure match-decision core (self-match #14/#22, H13 strong-identifier
// conflict, normalized/fuzzy name tiers, and the desandboxText write-boundary
// canonicalization) lives in `../resolution/supplier-default-resolution.ts`.
// Re-exported here so callers importing from this module keep resolving; the
// create/persist path + fetchRegistryData network I/O stay below.
export {
  matchSupplier,
  resolveSupplierDefault,
  type SupplierMatchFields,
  type SupplierMatchOptions,
  type SupplierMatchOutcome,
  type SupplierMatchType,
  type SupplierRef,
} from "../resolution/supplier-default-resolution.js";

export type SupplierIdentityFields = Pick<ExtractedReceiptFields, "supplier_name" | "supplier_reg_code" | "supplier_vat_no" | "supplier_iban" | "raw_text">;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupplierResolution {
  found: boolean;
  created: boolean;
  match_type?: "registry_code" | "vat_no" | "name_normalized" | "name_fuzzy" | "created" | "client_id" | "strong_identifier_conflict";
  client?: Client;
  preview_client?: Partial<Client>;
  registry_data?: Record<string, string> | null;
  /**
   * Set when a registry-code, VAT, or fuzzy-name match would have returned
   * the active company itself. Resolution refuses to return such matches —
   * see issue #14 — but signals the block here so callers can surface a
   * "needs manual supplier resolution" hint.
   */
  self_match_blocked?: boolean;
  /**
   * Set (with match_type "strong_identifier_conflict") when a name match was
   * vetoed because the invoice carried a strong identifier — registry code or
   * VAT number — that CONTRADICTS the name-matched client's own strong
   * identifier (H13). Booking against a name twin of a different legal entity
   * is a silent miscoding; the caller must route to manual review instead.
   */
  requires_manual_review?: boolean;
  /** Human-readable explanation for requires_manual_review or the identity gate. */
  reason?: string;
  /**
   * Set (P17) when the legal-entity identity gate refused an auto-create: no
   * verified Estonian registry code, no explicit natural person, and no
   * operator attestation for a foreign registration. When present the caller
   * must create NEITHER the supplier NOR the invoice.
   */
  code?: "legal_entity_identity_required";
}

export interface SupplierResolutionOptions {
  classification_category?: TransactionClassificationCategory;
  /**
   * VAT number of the active company. Resolution will refuse to return any
   * client whose VAT matches this value, defending against the case where the
   * extractor accepted the buyer's own VAT as the supplier (issue #14).
   */
  ownCompanyVat?: string;
  /**
   * Registry code of the active company. Resolution will refuse to return any
   * client whose `code` matches this value. Complements `ownCompanyVat` for
   * clients that lack a VAT number — common when a young Estonian OÜ has
   * their own client record from before VAT registration (issue #22).
   */
  ownCompanyRegistryCode?: string;
  _resolveSupplierOverrides?: {
    country?: string;
    is_physical_entity?: boolean;
    /**
     * Operator accountant-attestation that a FOREIGN (country != EST) legal
     * entity's identity is verified. Passed through to the P17 identity gate;
     * required to auto-create a foreign legal entity. Must be an explicit
     * operator input — never sourced from the extracted/OCR fields. Typed as
     * boolean at the call boundary; the gate additionally rejects any value
     * bearing OCR sandbox markers.
     */
    foreign_identity_attested?: boolean;
  };
}

function normalizeVatForCompare(value?: string | null): string | undefined {
  return normalizeVatValue(value);
}

// ---------------------------------------------------------------------------
// Registry lookup
// ---------------------------------------------------------------------------

export async function fetchRegistryData(regCode?: string, country = "EST", fallbackName?: string): Promise<Record<string, string> | null> {
  if (!regCode || country !== "EST" || !/^\d{8}$/.test(regCode)) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(
      `https://ariregister.rik.ee/est/api/autocomplete?q=${encodeURIComponent(regCode)}`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > 64 * 1024) return null;
    const text = await response.text();
    if (text.length > 64 * 1024) return null;
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) return null;
    const entry = data[0] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") return null;

    const name = entry.company_name ?? entry.nimi ?? fallbackName ?? "";
    const address = entry.address ?? entry.aadress ?? "";
    return {
      name: typeof name === "string" ? name : String(name),
      reg_code: regCode,
      address: typeof address === "string" ? address : String(address),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Supplier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a supplier from extracted receipt fields. Searches by registry code,
 * VAT number, then fuzzy name match. Optionally creates a new client.
 * NOTE: When execute=true and a client is created, the `clients` array is
 * mutated (new client pushed) so subsequent calls in the same batch see it.
 */
export async function resolveSupplierInternal(
  api: ApiContext,
  clients: Client[],
  fields: SupplierIdentityFields,
  execute: boolean,
  options?: SupplierResolutionOptions,
): Promise<SupplierResolution> {
  // Match half — delegated to the pure, extracted match-decision core
  // (self-match #14/#22, H13 strong-identifier conflict, normalized/fuzzy name
  // tiers, and the desandboxText write-boundary canonicalization). Behavior is
  // preserved exactly; only the create/persist path below stays here.
  const matchOutcome = matchSupplier(clients, fields, options);
  if (matchOutcome.kind === "matched") {
    return { found: true, created: false, match_type: matchOutcome.match_type, client: matchOutcome.client };
  }
  if (matchOutcome.kind === "conflict") {
    return {
      found: false,
      created: false,
      match_type: "strong_identifier_conflict",
      requires_manual_review: true,
      reason: matchOutcome.reason,
    };
  }
  // no_match — proceed to the create/persist path with the desandboxed fields.
  // self_match_blocked flags a suspect result (none found, or only the
  // previewed-new path is left); it is never propagated onto a found:true
  // return. The own-VAT-on-page note is surfaced separately in receipt-inbox
  // via detectSelfVatOnly.
  fields = matchOutcome.canonicalFields;
  const ownVat = matchOutcome.ownVat;
  const ownCode = matchOutcome.ownCode;
  const selfMatchBlocked = matchOutcome.selfMatchBlocked;

  const overrides = options?._resolveSupplierOverrides;
  // The caller-supplied country override reaches previewClient.cl_code_country and
  // api.clients.create, so strip markers here too (a wrapped value must never be
  // forwarded to the API). Empty/invalid codes fall back to inference.
  const overrideCountry = overrides?.country !== undefined ? desandboxText(overrides.country) : undefined;
  const supplierCountry = (overrideCountry || undefined) ?? inferSupplierCountry(fields);
  const registryData = supplierCountry
    ? await fetchRegistryData(fields.supplier_reg_code, supplierCountry, fields.supplier_name)
    : null;
  // registryData comes from an external network lookup (fetchRegistryData) and
  // is incorporated AFTER the top-of-function field canonicalization, so strip
  // markers from it too before it becomes a persisted client name. supplier_name
  // is already marker-free from the entry canonicalization (no-op here).
  const rawClientName = registryData?.name ?? fields.supplier_name;
  const clientName = rawClientName !== undefined ? desandboxText(rawClientName) : undefined;
  if (!clientName) {
    return {
      found: false,
      created: false,
      registry_data: registryData,
      ...(selfMatchBlocked ? { self_match_blocked: true } : {}),
    };
  }

  // Even after the matching steps refused a self-match, the previewed *new*
  // client must not be seeded with our own VAT — otherwise creating the
  // preview would persist a duplicate client with our own VAT (#14).
  const previewVatNo = fields.supplier_vat_no &&
    ownVat &&
    normalizeVatForCompare(fields.supplier_vat_no) === ownVat
      ? undefined
      : fields.supplier_vat_no;
  // Same defense for the registry code (#22): if OCR mis-attributed the
  // buyer's own code as the supplier's, do not persist it on the preview.
  const previewRegCode = fields.supplier_reg_code &&
    ownCode &&
    fields.supplier_reg_code.trim() === ownCode
      ? undefined
      : fields.supplier_reg_code;

  const isPhysicalEntity = overrides?.is_physical_entity ??
    (options?.classification_category !== "salary_payroll" &&
    !previewRegCode &&
    !previewVatNo &&
    looksLikePersonCounterparty(normalizeCounterpartyName(clientName), clientName));

  const previewClient: Partial<Client> = {
    name: clientName,
    code: previewRegCode,
    is_client: false,
    is_supplier: true,
    cl_code_country: supplierCountry,
    is_juridical_entity: !isPhysicalEntity,
    is_physical_entity: isPhysicalEntity,
    is_member: false,
    send_invoice_to_email: false,
    send_invoice_to_accounting_email: false,
    invoice_vat_no: previewVatNo,
    bank_account_no: fields.supplier_iban,
    address_text: registryData?.address !== undefined ? desandboxText(registryData.address) : undefined,
  };

  if (!execute) {
    return {
      found: false,
      created: false,
      preview_client: previewClient,
      registry_data: registryData,
      ...(selfMatchBlocked ? { self_match_blocked: true } : {}),
    };
  }

  if (!supplierCountry) {
    return {
      found: false,
      created: false,
      preview_client: previewClient,
      registry_data: registryData,
      ...(selfMatchBlocked ? { self_match_blocked: true } : {}),
    };
  }

  // A reg-code/VAT self-match reached the create path because a name was also
  // present (clientName is truthy). Even though the preview has our own VAT and
  // registry code stripped, persisting a client named after the active company
  // itself would let a later step book a purchase against self. Refuse to
  // create; return the stripped preview so the operator can review instead.
  if (selfMatchBlocked) {
    return {
      found: false,
      created: false,
      preview_client: previewClient,
      registry_data: registryData,
      self_match_blocked: true,
    };
  }

  // P17: gate auto-creation on a VERIFIED legal-entity identity BEFORE the
  // api.clients.create call and its audit-log write. The natural-person flag
  // here is the EXPLICIT operator override only (`overrides?.is_physical_entity`)
  // — never the document-inferred `isPhysicalEntity`, since a legal identity
  // must not be inferred from OCR. Self-attributed reg-code/VAT are already
  // stripped (previewRegCode/previewVatNo). On failure, create NOTHING and
  // return the stripped preview so the operator can review.
  const identity = validateLegalEntityIdentity({
    reg_code: previewRegCode,
    vat_no: previewVatNo,
    country: supplierCountry,
    is_physical_entity: overrides?.is_physical_entity,
    foreign_identity_attested: overrides?.foreign_identity_attested,
  });
  if (!identity.ok) {
    return {
      found: false,
      created: false,
      code: identity.code,
      reason: identity.reason,
      preview_client: previewClient,
      registry_data: registryData,
      ...(selfMatchBlocked ? { self_match_blocked: true } : {}),
    };
  }

  const created = await api.clients.create(previewClient as Client);
  const createdId = created.created_object_id;
  const client = createdId ? await api.clients.get(createdId) : undefined;
  if (client) {
    clients.push(client);
  }
  logAudit({
    tool: "resolve_supplier", action: "CREATED", entity_type: "client",
    entity_id: createdId,
    summary: `Created client "${previewClient.name}" (reg: ${fields.supplier_reg_code ?? ""})`,
    details: { name: previewClient.name, reg_code: fields.supplier_reg_code },
  });

  return {
    found: false,
    created: true,
    match_type: "created",
    client,
    preview_client: previewClient,
    registry_data: registryData,
    ...(selfMatchBlocked ? { self_match_blocked: true } : {}),
  };
}
