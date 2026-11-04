import { describe, expect, it } from "vitest";
import {
  EMTA_KMKR_FORM_URL,
  EMTA_KMKR_QUERY_URL,
  lookupEmtaKmkr,
  lookupEmtaKmkrCached,
  parseEmtaKmkrTable,
  resetEmtaKmkrCache,
} from "./emta-kmkr.js";
import { EMTA_HEADER_ROW, FULL_ROW, LIMITED_ROW, emtaAnswerHtml, emtaRow, fakeEmtaFetch } from "./__fixtures__/emta-kmkr.js";

describe("EMTA KMKR answer parsing", () => {
  it("reads a limited taxpayer row (the span after the registry code)", () => {
    expect(parseEmtaKmkrTable(emtaAnswerHtml([LIMITED_ROW]))).toEqual([
      { limited: true, registered_on: "2026-11-04", deleted_on: null, decision_on: "2026-11-04", vat_number: "EE103050067" },
    ]);
  });

  it("reads a full VAT payer row (no span)", () => {
    expect(parseEmtaKmkrTable(emtaAnswerHtml([FULL_ROW]))).toEqual([
      { limited: false, registered_on: "2024-12-16", deleted_on: null, decision_on: "2024-12-14", vat_number: "EE102809963" },
    ]);
  });

  it("a page without a result table has no rows", () => {
    expect(parseEmtaKmkrTable("<html><body>Andmeid ei leitud</body></html>")).toEqual([]);
  });

  it.each([
    ["a changed header", `<table class="grid">${EMTA_HEADER_ROW.replace("Nimi", "Name")}${emtaRow(FULL_ROW)}</table>`],
    ["a missing cell", `<table class="grid">${EMTA_HEADER_ROW}${emtaRow(FULL_ROW).replace(/<td>EE102809963<\/td>/, "")}</table>`],
    ["an unknown span", `<table class="grid">${EMTA_HEADER_ROW}${emtaRow(FULL_ROW).replace("17133416", "17133416<span class=\"boldblock\">Muu</span>")}</table>`],
    ["an invalid date", emtaAnswerHtml([{ ...FULL_ROW, registered: "31.02.2024" }])],
    ["a malformed VAT number", emtaAnswerHtml([{ ...FULL_ROW, vatNumber: "102809963" }])],
    ["two result tables", emtaAnswerHtml([FULL_ROW]) + emtaAnswerHtml([FULL_ROW])],
    ["an unclosed result table", `<table class="grid">${EMTA_HEADER_ROW}`],
  ])("refuses %s", (_label, html) => {
    expect(parseEmtaKmkrTable(html)).toBeNull();
  });
});

describe("lookupEmtaKmkr", () => {
  it("sends only the VAT number, with the form's CSRF token and session cookie, to the fixed EMTA URLs", async () => {
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    const outcome = await lookupEmtaKmkr(" ee103050067 ", { fetch: fake.impl });
    expect(outcome).toEqual({ ok: true, registration: { limited: true, registered_on: "2026-11-04", decision_on: "2026-11-04", vat_number: "EE103050067" } });
    expect(fake.calls.map(call => [call.method, call.url])).toEqual([["GET", EMTA_KMKR_FORM_URL], ["POST", EMTA_KMKR_QUERY_URL]]);
    const query = fake.calls[1]!;
    expect(Object.fromEntries(new URLSearchParams(query.body))).toEqual({ personCode: "EE103050067", p_submit: "Otsi", CSRFToken: "abc123-csrf-token" });
    expect(query.headers.Cookie).toBe("JSESSIONID=s1");
  });

  it("a full registration", async () => {
    const outcome = await lookupEmtaKmkr("EE102809963", { fetch: fakeEmtaFetch(emtaAnswerHtml([FULL_ROW])).impl });
    expect(outcome).toMatchObject({ ok: true, registration: { limited: false, registered_on: "2024-12-16" } });
  });

  it("picks the active row of the number; a deleted-only registration, two active rows or no row are not settled", async () => {
    const earlier = { ...LIMITED_ROW, registered: "01.01.2025", deleted: "03.11.2026" };
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch(emtaAnswerHtml([earlier, LIMITED_ROW])).impl }))
      .toMatchObject({ ok: true, registration: { registered_on: "2026-11-04" } });
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch(emtaAnswerHtml([earlier])).impl }))
      .toMatchObject({ ok: false, code: "emta_registration_deleted" });
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW, { ...LIMITED_ROW, limited: false }])).impl }))
      .toMatchObject({ ok: false, code: "emta_registration_ambiguous" });
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch(emtaAnswerHtml([FULL_ROW])).impl }))
      .toMatchObject({ ok: false, code: "emta_registration_not_found" });
  });

  it("network failure, HTTP error, malformed HTML and a missing CSRF token fail without a guess", async () => {
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch("network").impl })).toMatchObject({ ok: false, code: "emta_lookup_unavailable" });
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch(503).impl })).toMatchObject({ ok: false, code: "emta_lookup_unavailable" });
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch("<table class=\"grid\"><tr><td>x</td></tr></table>").impl }))
      .toMatchObject({ ok: false, code: "emta_response_invalid" });
    const noToken = async () => new Response("<form></form>");
    expect(await lookupEmtaKmkr("EE103050067", { fetch: noToken })).toMatchObject({ ok: false, code: "emta_response_invalid" });
  });

  it("an oversized answer is refused", async () => {
    const fake = fakeEmtaFetch("x".repeat(600 * 1024));
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fake.impl })).toMatchObject({ ok: false, code: "emta_response_invalid" });
  });

  it("never sends a value that is not an Estonian VAT number", async () => {
    const fake = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    expect(await lookupEmtaKmkr("14417608", { fetch: fake.impl })).toMatchObject({ ok: false, code: "emta_registration_not_found" });
    expect(fake.calls).toEqual([]);
  });
});

describe("lookupEmtaKmkrCached", () => {
  it("reuses a success, and retries a failure only after a minute", async () => {
    resetEmtaKmkrCache();
    const ok = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    await lookupEmtaKmkrCached("EE102809963", 1_000, { fetch: ok.impl });
    await lookupEmtaKmkrCached("EE102809963", 2_000_000, { fetch: ok.impl });
    expect(ok.queries()).toHaveLength(1);

    const failing = fakeEmtaFetch("network");
    await lookupEmtaKmkrCached("EE103050067", 1_000, { fetch: failing.impl });
    await lookupEmtaKmkrCached("EE103050067", 30_000, { fetch: failing.impl });
    expect(failing.queries()).toHaveLength(1);
    await lookupEmtaKmkrCached("EE103050067", 62_000, { fetch: failing.impl });
    expect(failing.queries()).toHaveLength(2);
  });
});
