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
}

export interface SupplierResolutionOptions {
  classification_category?: TransactionClassificationCategory;
  _resolveSupplierOverrides?: {
    country?: string;
    is_physical_entity?: boolean;
  };
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
    const data = JSON.parse(text) as Array<Record<string, unknown>>;
    const entry = data[0];
    if (!entry) return null;

    return {
      name: String(entry.company_name ?? entry.nimi ?? fallbackName ?? ""),
      reg_code: regCode,
      address: String(entry.address ?? entry.aadress ?? ""),
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
  if (fields.supplier_reg_code) {
    const byCode = clients.find(client => client.code === fields.supplier_reg_code && !client.is_deleted);
    if (byCode) {
      return { found: true, created: false, match_type: "registry_code", client: byCode };
    }
  }

  if (fields.supplier_vat_no) {
    const normalizedVat = fields.supplier_vat_no.replace(/\s+/g, "").toUpperCase();
    const byVat = clients.find(client =>
      !client.is_deleted &&
      client.invoice_vat_no?.replace(/\s+/g, "").toUpperCase() === normalizedVat,
    );
    if (byVat) {
      return { found: true, created: false, match_type: "vat_no", client: byVat };
    }
  }

  if (fields.supplier_name) {
    const activeClients = clients.filter(client => !client.is_deleted);
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
        return { found: true, created: false, match_type: "name_fuzzy", client: matchedClient };
      }
    }
  }

  const overrides = options?._resolveSupplierOverrides;
  const supplierCountry = overrides?.country ?? inferSupplierCountry(fields);
  const registryData = await fetchRegistryData(fields.supplier_reg_code, supplierCountry, fields.supplier_name);
  const clientName = registryData?.name ?? fields.supplier_name;
  if (!clientName) {
    return { found: false, created: false, registry_data: registryData };
  }

  const isPhysicalEntity = overrides?.is_physical_entity ??
    (options?.classification_category !== "salary_payroll" &&
    !fields.supplier_reg_code &&
    !fields.supplier_vat_no &&
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
    invoice_vat_no: fields.supplier_vat_no,
    bank_account_no: fields.supplier_iban,
    address_text: registryData?.address,
  };

  if (!execute) {
    return {
      found: false,
      created: false,
      preview_client: previewClient,
      registry_data: registryData,
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
  };
}
