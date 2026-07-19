import { describe, expect, it } from "vitest";
import { validateLegalEntityIdentity } from "./legal-entity-identity.js";

// Sandbox-wrapped value, mirroring wrapUntrustedOcr's format. A forwarded
// attestation sourced from extracted/OCR document fields would carry these
// markers — it must never be accepted as an operator attestation.
const wrap = (s: string) => `<<UNTRUSTED_OCR_START:deadbeef>>\n${s}\n<<UNTRUSTED_OCR_END:deadbeef>>`;

describe("validateLegalEntityIdentity — Estonian registry (registrikood)", () => {
  it("passes a checksum-valid 8-digit Estonian registry code", () => {
    expect(validateLegalEntityIdentity({ reg_code: "17133416" })).toEqual({
      ok: true,
      kind: "estonian_registry",
    });
  });

  it("passes another known checksum-valid code (12345678)", () => {
    expect(validateLegalEntityIdentity({ reg_code: "12345678", country: "EST" })).toEqual({
      ok: true,
      kind: "estonian_registry",
    });
  });

  it("passes with surrounding whitespace on the reg code", () => {
    expect(validateLegalEntityIdentity({ reg_code: " 17133416 " }).ok).toBe(true);
  });

  it("fails when the reg code is missing (nothing supplied)", () => {
    const result = validateLegalEntityIdentity({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("legal_entity_identity_required");
  });

  it("fails when the reg code checksum is invalid (12345679)", () => {
    const result = validateLegalEntityIdentity({ reg_code: "12345679" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("legal_entity_identity_required");
  });

  it("fails a reg code with a bad first digit even if 8 digits (22345674)", () => {
    expect(validateLegalEntityIdentity({ reg_code: "22345674" }).ok).toBe(false);
  });

  it("fails when only a VAT number is present (VAT is not a legal-entity identity)", () => {
    const result = validateLegalEntityIdentity({ vat_no: "EE100731910" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("legal_entity_identity_required");
  });

  it("fails VAT-only even with a valid EE VAT checksum and explicit EST country", () => {
    expect(
      validateLegalEntityIdentity({ vat_no: "EE100731910", country: "EST" }).ok,
    ).toBe(false);
  });
});

describe("validateLegalEntityIdentity — explicit natural person", () => {
  it("passes when is_physical_entity is explicitly true, no reg code required", () => {
    expect(validateLegalEntityIdentity({ is_physical_entity: true })).toEqual({
      ok: true,
      kind: "natural_person",
    });
  });

  it("passes an explicit natural person regardless of country", () => {
    expect(
      validateLegalEntityIdentity({ is_physical_entity: true, country: "USA" }).kind,
    ).toBe("natural_person");
  });

  it("does NOT treat is_physical_entity false as a natural person", () => {
    expect(validateLegalEntityIdentity({ is_physical_entity: false }).ok).toBe(false);
  });
});

describe("validateLegalEntityIdentity — foreign registration attestation", () => {
  it("passes a foreign entity ONLY with an explicit boolean attestation", () => {
    expect(
      validateLegalEntityIdentity({ country: "USA", foreign_identity_attested: true }),
    ).toEqual({ ok: true, kind: "foreign_attested" });
  });

  it("fails a foreign entity with no attestation", () => {
    const result = validateLegalEntityIdentity({ country: "USA" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("legal_entity_identity_required");
  });

  it("fails a foreign entity when attestation is a non-boolean string ('true')", () => {
    expect(
      validateLegalEntityIdentity({ country: "USA", foreign_identity_attested: "true" as unknown }).ok,
    ).toBe(false);
  });

  it("rejects a forwarded attestation that carries OCR sandbox markers", () => {
    const result = validateLegalEntityIdentity({
      country: "USA",
      foreign_identity_attested: wrap("true") as unknown,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("legal_entity_identity_required");
      expect(result.reason).toMatch(/attestation/i);
    }
  });

  it("does not accept a valid-looking EE-checksum reg code as a foreign pass", () => {
    // A foreign entity supplying an 8-digit EE-checksum code is coincidental;
    // only an explicit attestation lets a non-EST registration through.
    expect(
      validateLegalEntityIdentity({ country: "USA", reg_code: "17133416" }).ok,
    ).toBe(false);
  });
});
