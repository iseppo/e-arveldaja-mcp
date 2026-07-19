// ---------------------------------------------------------------------------
// Legal-entity identity gate (P17)
// ---------------------------------------------------------------------------
// Pure, side-effect-free validator that decides whether a client/supplier may
// be auto-created. It must run BEFORE any `clients.create` / API call / audit
// log on every auto-create path (client CRUD create, supplier resolution
// auto-create, receipt auto-create). It performs no I/O and no audit logging.
//
// A VERIFIED legal-entity identity is one of:
//   - estonian_registry: an Estonian company registry code (registrikood) with
//     a valid weighted mod-11 checksum (EST / default country).
//   - natural_person: the caller EXPLICITLY flagged the counterparty as a
//     physical person (never inferred from the document).
//   - foreign_attested: a non-EST registration for which the operator supplied
//     an explicit accountant-attestation flag. The attestation must be a strict
//     boolean `true` and must NOT originate from the untrusted extracted/OCR
//     fields — a value bearing OCR sandbox markers is rejected as forwarded.
//
// Everything else fails with `legal_entity_identity_required`, and the caller
// must create NEITHER the supplier NOR the invoice.

import { isValidEeRegistryCode } from "./document-identifiers.js";

/** OCR sandbox markers (see wrapUntrustedOcr in mcp-json.ts). A forwarded
 * attestation sourced from extracted document text would carry these. */
const SANDBOX_MARKER_RE = /<<UNTRUSTED_OCR_(?:START|END):[0-9a-f]*>>/;

const ESTONIA_COUNTRY_CODES = new Set(["EST", "EE", "EESTI", "ESTONIA"]);

export interface LegalEntityIdentityInput {
  /** Business registry code (registrikood). Checked for the EE mod-11 checksum. */
  reg_code?: string | null;
  /** VAT number (KMKR). A VAT number is NOT a legal-entity identity on its own. */
  vat_no?: string | null;
  /** Country code. Empty/undefined defaults to Estonia (EST). */
  country?: string | null;
  /**
   * Explicit operator flag that the counterparty is a physical person. Only a
   * strict `true` passes. Never inferred from the document — the caller must
   * set it from an explicit tool parameter.
   */
  is_physical_entity?: boolean;
  /**
   * Explicit operator accountant-attestation for a foreign (non-EST)
   * registration. Typed `unknown` deliberately: only the strict boolean `true`
   * is accepted, and a value carrying OCR sandbox markers (i.e. forwarded from
   * extracted document fields) is rejected. This is the "never forward
   * attestation" guard.
   */
  foreign_identity_attested?: unknown;
}

export type LegalEntityIdentityKind = "estonian_registry" | "natural_person" | "foreign_attested";

export type LegalEntityIdentityResult =
  | { ok: true; kind: LegalEntityIdentityKind }
  | { ok: false; code: "legal_entity_identity_required"; reason: string };

function fail(reason: string): LegalEntityIdentityResult {
  return { ok: false, code: "legal_entity_identity_required", reason };
}

function normalizeCountry(country: string | null | undefined): string {
  const trimmed = country?.trim().toUpperCase();
  return trimmed || "EST";
}

/**
 * Validate that an auto-create has a VERIFIED legal-entity identity. Pure: no
 * side effects, no API, no audit. Returns a discriminated result the caller
 * inspects before creating anything.
 */
export function validateLegalEntityIdentity(input: LegalEntityIdentityInput): LegalEntityIdentityResult {
  // 1. Explicit natural person passes with no reg code required. Must be the
  //    caller's explicit boolean flag, never inferred from the document. This
  //    is checked first so an explicit natural person passes regardless of
  //    country (a foreign physical person has no registry code).
  if (input.is_physical_entity === true) {
    return { ok: true, kind: "natural_person" };
  }

  const country = normalizeCountry(input.country);
  const isEstonia = ESTONIA_COUNTRY_CODES.has(country);
  const regCode = input.reg_code?.trim() || undefined;

  if (isEstonia) {
    // 2. Estonian registry code with a valid mod-11 checksum passes. A missing
    //    reg code, an invalid checksum, or a VAT-only record (vat_no present,
    //    no valid reg code) all fail — a VAT number is not a legal-entity
    //    identity.
    if (regCode && isValidEeRegistryCode(regCode)) {
      return { ok: true, kind: "estonian_registry" };
    }
    if (regCode) {
      return fail(
        `Estonian registry code "${regCode.slice(0, 12)}" fails the registrikood checksum — a verified legal-entity identity is required before creating a client/supplier or invoice.`,
      );
    }
    if (input.vat_no?.trim()) {
      return fail(
        "A VAT number alone is not a legal-entity identity — supply a checksum-valid Estonian registry code, or mark an explicit natural person, before creating a client/supplier or invoice.",
      );
    }
    return fail(
      "No legal-entity identity supplied — a checksum-valid Estonian registry code (or an explicit natural person) is required before creating a client/supplier or invoice.",
    );
  }

  // 3. Foreign registration (country != EST) passes ONLY with an explicit
  //    operator accountant-attestation. The attestation must be a strict
  //    boolean true and must not be forwarded from untrusted extracted fields.
  const attested = input.foreign_identity_attested;
  if (typeof attested === "string" && SANDBOX_MARKER_RE.test(attested)) {
    return fail(
      "Foreign-identity attestation appears to originate from extracted document fields (it carries OCR sandbox markers) — attestation must be an explicit operator input, not forwarded from the document.",
    );
  }
  if (attested === true) {
    return { ok: true, kind: "foreign_attested" };
  }
  return fail(
    `Foreign registration (country ${country}) requires an explicit operator accountant-attestation (foreign_identity_attested) before a client/supplier or invoice can be created; a foreign registry code or VAT number is not sufficient on its own.`,
  );
}
