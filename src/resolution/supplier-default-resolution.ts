/**
 * Pure supplier MATCH-DECISION core (plan Step 4). Extracted verbatim from
 * `src/tools/supplier-resolution.ts` (`resolveSupplierInternal`, the read-only
 * matching half, lines ~156-311): write-boundary `desandboxText`
 * canonicalization, the self-match block (#14/#22), the H13 strong-identifier
 * conflict gate, the normalized-name-unique tier with its tied-name fall-through,
 * and the fuzzy tier with its inclusion checks.
 *
 * This is a behavior-preserving EXTRACTION, NOT a new gate — every gate is
 * reproduced exactly. The create/persist path (`api.clients.create` + audit +
 * `fetchRegistryData` network I/O) and the P17 legal-entity gate STAY in
 * `supplier-resolution.ts`; `resolveSupplierInternal` now delegates its match
 * half to `matchSupplier` here.
 *
 * House style: NO MCP / HTTP / fs types — plain `Client[]` + identity fields in,
 * a typed match outcome (or the `Resolution<SupplierRef>` view) out.
 */
import { closest, distance } from "fastest-levenshtein";
import type { Client } from "../types/api.js";
import { normalizeCompanyName } from "../company-name.js";
import { normalizeVatValue } from "../document-identifiers.js";
import { desandboxText } from "../external-text-renderer.js";
import { ambiguous, notFound, resolved, type Resolution } from "./types.js";

export interface SupplierMatchFields {
  supplier_name?: string;
  supplier_reg_code?: string;
  supplier_vat_no?: string;
  supplier_iban?: string;
  raw_text?: string;
}

export interface SupplierMatchOptions {
  /** VAT number of the active company — matches against it are refused (#14). */
  ownCompanyVat?: string;
  /** Registry code of the active company — matches against it are refused (#22). */
  ownCompanyRegistryCode?: string;
}

export type SupplierMatchType = "registry_code" | "vat_no" | "name_normalized" | "name_fuzzy";

export type SupplierMatchOutcome =
  | { kind: "matched"; match_type: SupplierMatchType; client: Client }
  | { kind: "conflict"; reason: string }
  | {
      kind: "no_match";
      selfMatchBlocked: boolean;
      /** The desandboxed identity fields — safe to persist / feed the create path. */
      canonicalFields: SupplierMatchFields;
      ownVat?: string;
      ownCode?: string;
    };

/** Match a supplier from identity fields against existing clients, applying the
 * self-match, strong-identifier-conflict, and tied-name gates. A tie or a miss
 * NEVER silently picks — it returns `no_match` (or `conflict`). */
export function matchSupplier(
  clients: Client[],
  rawFields: SupplierMatchFields,
  options?: SupplierMatchOptions,
): SupplierMatchOutcome {
  // Canonicalize the external-origin identity fields at this shared boundary:
  // supplier_name/reg_code/vat_no/iban can arrive sandbox-wrapped from a
  // round-tripped extract response; strip every marker so none is used as a
  // match key. raw_text is left untouched (detection input, never a key).
  const fields: SupplierMatchFields = {
    ...rawFields,
    supplier_name: rawFields.supplier_name !== undefined ? desandboxText(rawFields.supplier_name) : undefined,
    supplier_reg_code: rawFields.supplier_reg_code !== undefined ? desandboxText(rawFields.supplier_reg_code) : undefined,
    supplier_vat_no: rawFields.supplier_vat_no !== undefined ? desandboxText(rawFields.supplier_vat_no) : undefined,
    supplier_iban: rawFields.supplier_iban !== undefined ? desandboxText(rawFields.supplier_iban) : undefined,
  };
  const ownVat = normalizeVatValue(options?.ownCompanyVat);
  const ownCode = options?.ownCompanyRegistryCode?.trim() || undefined;
  const isSelfClient = (client: Client): boolean => {
    if (ownVat && normalizeVatValue(client.invoice_vat_no) === ownVat) return true;
    if (ownCode && client.code?.trim() === ownCode) return true;
    return false;
  };
  let selfMatchBlocked = false;

  // H13: a strong identifier (registry code / VAT) that CONTRADICTS a
  // name-matched client's own strong identifier vetoes the name match.
  const suppliedRegCode = fields.supplier_reg_code?.trim() || undefined;
  const suppliedVat = normalizeVatValue(fields.supplier_vat_no);
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
      const candidateVat = normalizeVatValue(candidate.invoice_vat_no);
      if (candidateVat && candidateVat !== foreignVat) {
        return `Invoice VAT number conflicts with matched client's VAT number — resolve the supplier manually.`;
      }
    }
    return undefined;
  };

  const noMatch = (): SupplierMatchOutcome => ({
    kind: "no_match",
    selfMatchBlocked,
    canonicalFields: fields,
    ownVat,
    ownCode,
  });

  if (fields.supplier_reg_code) {
    if (ownCode && fields.supplier_reg_code.trim() === ownCode) {
      selfMatchBlocked = true;
    } else {
      const byCode = clients.find(client => client.code === fields.supplier_reg_code && !client.is_deleted);
      if (byCode) {
        if (isSelfClient(byCode)) {
          selfMatchBlocked = true;
        } else {
          return { kind: "matched", match_type: "registry_code", client: byCode };
        }
      }
    }
  }

  if (fields.supplier_vat_no) {
    const normalizedVat = normalizeVatValue(fields.supplier_vat_no);
    if (normalizedVat && ownVat && normalizedVat === ownVat) {
      selfMatchBlocked = true;
    } else if (normalizedVat) {
      const byVat = clients.find(client =>
        !client.is_deleted &&
        normalizeVatValue(client.invoice_vat_no) === normalizedVat,
      );
      if (byVat) {
        if (isSelfClient(byVat)) {
          selfMatchBlocked = true;
        } else {
          return { kind: "matched", match_type: "vat_no", client: byVat };
        }
      }
    }
  }

  if (fields.supplier_name) {
    const activeClients = clients.filter(client => !client.is_deleted && !isSelfClient(client));

    const normalizedSupplierName = normalizeCompanyName(fields.supplier_name);
    if (normalizedSupplierName && normalizedSupplierName.length >= 4) {
      const normalizedExactMatches = activeClients.filter(
        client => normalizeCompanyName(client.name) === normalizedSupplierName,
      );
      if (normalizedExactMatches.length === 1) {
        const candidate = normalizedExactMatches[0]!;
        const conflict = strongIdentifierConflict(candidate);
        if (conflict) return { kind: "conflict", reason: conflict };
        return { kind: "matched", match_type: "name_normalized", client: candidate };
      }
      // length === 0 → no match, length > 1 → ambiguous, both fall through
      // to the fuzzy tier which has stricter inclusion checks.
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
        if (conflict) return { kind: "conflict", reason: conflict };
        return { kind: "matched", match_type: "name_fuzzy", client: matchedClient };
      }
    }
  }

  return noMatch();
}

export interface SupplierRef {
  readonly client: Client;
  readonly match_type: SupplierMatchType;
}

/** `Resolution<SupplierRef>` view of the pure matcher (plan Step 1/4). A
 * conflict or a self-match-blocked outcome surfaces as `ambiguous` ("resolve
 * manually"); a clean miss as `not_found`. This is the typed three-way surface
 * for the guided façades (Tasks 12-14); the create/persist path is unaffected. */
export function resolveSupplierDefault(
  clients: Client[],
  fields: SupplierMatchFields,
  options?: SupplierMatchOptions,
): Resolution<SupplierRef> {
  const outcome = matchSupplier(clients, fields, options);
  if (outcome.kind === "matched") {
    return resolved(
      { client: outcome.client, match_type: outcome.match_type },
      [{ tag: outcome.match_type, note: `Matched supplier by ${outcome.match_type}.` }],
    );
  }
  if (outcome.kind === "conflict") {
    return ambiguous([], outcome.reason);
  }
  if (outcome.selfMatchBlocked) {
    return ambiguous(
      [],
      "The invoice identity matched the active company itself — resolve the supplier manually.",
    );
  }
  return notFound("No existing supplier matched; create the supplier or resolve manually.");
}
