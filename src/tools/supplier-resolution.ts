import { closest, distance } from "fastest-levenshtein";
import type { Client } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { logAudit } from "../audit-log.js";
import { normalizeCompanyName } from "../company-name.js";
import { normalizeVatValue } from "../document-identifiers.js";
import { desandboxText } from "../external-text-renderer.js";
import {
  type ExtractedReceiptFields,
  type TransactionClassificationCategory,
  inferSupplierCountry,
  looksLikePersonCounterparty,
  normalizeCounterpartyName,
} from "./receipt-extraction.js";

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
  /** Human-readable explanation for requires_manual_review. */
  reason?: string;
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
  // Canonicalize the external-origin identity fields at this shared resolution/
  // creation boundary: supplier_name/reg_code/vat_no/iban can arrive sandbox-
  // wrapped from a round-tripped extract response, and this function both MATCHES
  // on them and (with execute=true) CREATES a client from them via
  // api.clients.create — a path that bypasses the create_client tool's own strip.
  // Removing every marker here guarantees none is used as a match key or persisted
  // onto a new client, for all callers (pdf-workflow + receipt-inbox). raw_text is
  // left untouched (detection input, never persisted or matched as a key).
  fields = {
    ...fields,
    supplier_name: fields.supplier_name !== undefined ? desandboxText(fields.supplier_name) : undefined,
    supplier_reg_code: fields.supplier_reg_code !== undefined ? desandboxText(fields.supplier_reg_code) : undefined,
    supplier_vat_no: fields.supplier_vat_no !== undefined ? desandboxText(fields.supplier_vat_no) : undefined,
    supplier_iban: fields.supplier_iban !== undefined ? desandboxText(fields.supplier_iban) : undefined,
  };
  const ownVat = normalizeVatForCompare(options?.ownCompanyVat);
  const ownCode = options?.ownCompanyRegistryCode?.trim() || undefined;
  const isSelfClient = (client: Client): boolean => {
    if (ownVat && normalizeVatForCompare(client.invoice_vat_no) === ownVat) return true;
    if (ownCode && client.code?.trim() === ownCode) return true;
    return false;
  };
  let selfMatchBlocked = false;

  // H13: a strong identifier (registry code / VAT) that CONTRADICTS a
  // name-matched client's own strong identifier vetoes the name match. Two
  // deliberate scoping rules keep this from refusing legitimate suppliers:
  //  - Own-company IDs are excluded. A supplier_reg_code/vat that equals the
  //    active company's identity is a header mis-scan of the buyer (issues
  //    #14/#22), not a supplier signal, so it must not veto a real name match.
  //  - Only a genuine contradiction counts. If the candidate client has no
  //    strong identifier of that kind on file, absence is not conflict — the
  //    name match resolves and the invoice's identifier can enrich the record.
  const suppliedRegCode = fields.supplier_reg_code?.trim() || undefined;
  const suppliedVat = normalizeVatForCompare(fields.supplier_vat_no);
  const foreignRegCode = suppliedRegCode && suppliedRegCode !== ownCode ? suppliedRegCode : undefined;
  const foreignVat = suppliedVat && suppliedVat !== ownVat ? suppliedVat : undefined;
  const strongIdentifierConflict = (candidate: Client): string | undefined => {
    if (foreignRegCode) {
      const candidateCode = candidate.code?.trim();
      if (candidateCode && candidateCode !== foreignRegCode) {
        return `Invoice registry code ${foreignRegCode} conflicts with matched client's registry code ${candidateCode} — resolve the supplier manually.`;
      }
    }
    if (foreignVat) {
      const candidateVat = normalizeVatForCompare(candidate.invoice_vat_no);
      if (candidateVat && candidateVat !== foreignVat) {
        return `Invoice VAT number conflicts with matched client's VAT number — resolve the supplier manually.`;
      }
    }
    return undefined;
  };
  const conflictResult = (reason: string): SupplierResolution => ({
    found: false,
    created: false,
    match_type: "strong_identifier_conflict",
    requires_manual_review: true,
    reason,
  });

  // self_match_blocked is meant to flag results where the returned client is
  // suspect (none was found, or only the previewed-new path is left). When
  // we successfully resolve to a different real supplier via a later step
  // (e.g. fuzzy name match), the returned result is not suspect — earlier
  // self-match attempts are bookkeeping only — so we DO NOT propagate the
  // flag onto found:true returns. The own-VAT-on-page note is surfaced
  // separately in receipt-inbox via detectSelfVatOnly.

  if (fields.supplier_reg_code) {
    if (ownCode && fields.supplier_reg_code.trim() === ownCode) {
      // Mirrors the VAT-on-page guard below (#22): the OCR may have read
      // the buyer's own registry code as the supplier code. Block before
      // client lookup so we never create a supplier with our own code.
      selfMatchBlocked = true;
    } else {
      const byCode = clients.find(client => client.code === fields.supplier_reg_code && !client.is_deleted);
      if (byCode) {
        if (isSelfClient(byCode)) {
          selfMatchBlocked = true;
        } else {
          return { found: true, created: false, match_type: "registry_code", client: byCode };
        }
      }
    }
  }

  if (fields.supplier_vat_no) {
    const normalizedVat = normalizeVatForCompare(fields.supplier_vat_no);
    if (normalizedVat && ownVat && normalizedVat === ownVat) {
      selfMatchBlocked = true;
    } else if (normalizedVat) {
      const byVat = clients.find(client =>
        !client.is_deleted &&
        normalizeVatForCompare(client.invoice_vat_no) === normalizedVat,
      );
      if (byVat) {
        if (isSelfClient(byVat)) {
          selfMatchBlocked = true;
        } else {
          return { found: true, created: false, match_type: "vat_no", client: byVat };
        }
      }
    }
  }

  if (fields.supplier_name) {
    const activeClients = clients.filter(client => !client.is_deleted && !isSelfClient(client));

    // First try a normalized-name exact match. Strips legal-form suffixes
    // (LLC, Inc, PBC, AG, …) and punctuation, so an invoice supplier like
    // "Anthropic, PBC" finds an existing "Anthropic" client. Without this
    // tier, the fuzzy fallback's 0.7 similarity threshold rejects the
    // pair (≈0.6 in our measurements) and the supplier_history lookup
    // that drives reuse of prior bookings never fires.
    //
    // Two guards prevent the new tier from silently miscoding:
    //  - Minimum-length floor (≥ 4 chars after normalization) mirrors the
    //    fuzzy tier's `shorterLen >= 4` check, so a single common word
    //    like "solutions" can't bridge two unrelated suppliers.
    //  - Ambiguity bail-out: if multiple clients share the same
    //    normalized key, we fall through to the fuzzy tier rather than
    //    picking one arbitrarily.
    const normalizedSupplierName = normalizeCompanyName(fields.supplier_name);
    if (normalizedSupplierName && normalizedSupplierName.length >= 4) {
      const normalizedExactMatches = activeClients.filter(
        client => normalizeCompanyName(client.name) === normalizedSupplierName,
      );
      if (normalizedExactMatches.length === 1) {
        const candidate = normalizedExactMatches[0]!;
        const conflict = strongIdentifierConflict(candidate);
        if (conflict) return conflictResult(conflict);
        return {
          found: true,
          created: false,
          match_type: "name_normalized",
          client: candidate,
        };
      }
      // length === 0 → no match, length > 1 → ambiguous, both fall
      // through to the fuzzy tier which has stricter inclusion checks.
    }

    const names = activeClients.map(client => client.name);
    if (names.length > 0) {
      const bestMatch = closest(fields.supplier_name, names);
      const matchedClient = activeClients.find(client => client.name === bestMatch);
      const maxLen = Math.max(fields.supplier_name.length, bestMatch.length);
      const similarity = maxLen > 0 ? 1 - distance(fields.supplier_name, bestMatch) / maxLen : 0;
      const shorterLen = Math.min(fields.supplier_name.length, bestMatch.length);
      if (
        matchedClient &&
        similarity >= 0.7 &&
        shorterLen >= 4 &&
        (
          bestMatch.toLowerCase().includes(fields.supplier_name.toLowerCase()) ||
          fields.supplier_name.toLowerCase().includes(bestMatch.toLowerCase())
        )
      ) {
        const conflict = strongIdentifierConflict(matchedClient);
        if (conflict) return conflictResult(conflict);
        return { found: true, created: false, match_type: "name_fuzzy", client: matchedClient };
      }
    }
  }

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
