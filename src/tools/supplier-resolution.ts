import { closest, distance } from "fastest-levenshtein";
import type { Client } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { logAudit } from "../audit-log.js";
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
  match_type?: "registry_code" | "vat_no" | "name_fuzzy" | "created";
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
}

export interface SupplierResolutionOptions {
  classification_category?: TransactionClassificationCategory;
  /**
   * VAT number of the active company. Resolution will refuse to return any
   * client whose VAT matches this value, defending against the case where the
   * extractor accepted the buyer's own VAT as the supplier (issue #14).
   */
  ownCompanyVat?: string;
  _resolveSupplierOverrides?: {
    country?: string;
    is_physical_entity?: boolean;
  };
}

function normalizeVatForCompare(value?: string | null): string | undefined {
  const normalized = value?.replace(/\s+/g, "").toUpperCase();
  return normalized || undefined;
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
  const ownVat = normalizeVatForCompare(options?.ownCompanyVat);
  const isSelfClient = (client: Client): boolean =>
    !!ownVat && normalizeVatForCompare(client.invoice_vat_no) === ownVat;
  let selfMatchBlocked = false;

  const annotateSelfMatch = <T extends SupplierResolution>(value: T): T =>
    selfMatchBlocked ? { ...value, self_match_blocked: true } : value;

  if (fields.supplier_reg_code) {
    const byCode = clients.find(client => client.code === fields.supplier_reg_code && !client.is_deleted);
    if (byCode) {
      if (isSelfClient(byCode)) {
        selfMatchBlocked = true;
      } else {
        return annotateSelfMatch({ found: true, created: false, match_type: "registry_code", client: byCode });
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
          return annotateSelfMatch({ found: true, created: false, match_type: "vat_no", client: byVat });
        }
      }
    }
  }

  if (fields.supplier_name) {
    const activeClients = clients.filter(client => !client.is_deleted && !isSelfClient(client));
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
        return annotateSelfMatch({ found: true, created: false, match_type: "name_fuzzy", client: matchedClient });
      }
    }
  }

  const overrides = options?._resolveSupplierOverrides;
  const supplierCountry = overrides?.country ?? inferSupplierCountry(fields);
  const registryData = await fetchRegistryData(fields.supplier_reg_code, supplierCountry, fields.supplier_name);
  const clientName = registryData?.name ?? fields.supplier_name;
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

  const isPhysicalEntity = overrides?.is_physical_entity ??
    (options?.classification_category !== "salary_payroll" &&
    !fields.supplier_reg_code &&
    !previewVatNo &&
    looksLikePersonCounterparty(normalizeCounterpartyName(clientName), clientName));

  const previewClient: Partial<Client> = {
    name: clientName,
    code: fields.supplier_reg_code,
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
    address_text: registryData?.address,
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
