/**
 * Recorded response of the public e-Business Register autocomplete endpoint
 * (`GET https://ariregister.rik.ee/est/api/autocomplete?q=10234957`, recorded
 * 2026-09-25). Shape: `{ status, data: [{ reg_code (number), name,
 * legal_address, status: "R"|"L"|"N"|"K", ... }] }`. Tests stub `fetch` with
 * this body — never hit the network.
 */
export const ARIREGISTER_AUTOCOMPLETE_TELIA = {
  status: "OK",
  data: [{
    company_id: 2000039910,
    reg_code: 10234957,
    name: "Telia Eesti AS",
    historical_names: ["AS Eesti Telekom", "Aktsiaselts Eesti Telekom"],
    status: "R",
    legal_address: "Harju maakond, Tallinn, Kristiine linnaosa, Mustamäe tee 3",
    zip_code: "15033",
    legal_form: "1",
    url: "https://ariregister.rik.ee/est/company/10234957/Telia-Eesti-AS",
  }],
} as const;

/** The recorded entry re-shaped as a deleted ("K" = kustutatud) company, preceded by a non-matching prefix hit. */
export const ARIREGISTER_AUTOCOMPLETE_DELETED = {
  status: "OK",
  data: [
    { ...ARIREGISTER_AUTOCOMPLETE_TELIA.data[0], reg_code: 102349571, name: "Other Prefix OÜ" },
    { ...ARIREGISTER_AUTOCOMPLETE_TELIA.data[0], status: "K" },
  ],
} as const;
