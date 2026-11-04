import { describe, expect, it } from "vitest";
import {
  EMTA_KMKR_FORM_URL,
  EMTA_THROTTLE_COOLDOWN_MS,
  EMTA_KMKR_QUERY_URL,
  lookupEmtaKmkr,
  lookupEmtaKmkrCached,
  parseEmtaKmkrTable,
  resetEmtaKmkrCache,
} from "./emta-kmkr.js";
import { EMTA_FORM_HTML, EMTA_HEADER_ROW, FULL_ROW, LIMITED_ROW, emtaAnswerHtml, emtaRow, fakeEmtaFetch } from "./__fixtures__/emta-kmkr.js";

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

  it("walks the table structurally: tbody, attributes, comments and markup inside cells are fine", () => {
    const html = `<table class='data grid' id=result><!-- result --><tbody>\n${EMTA_HEADER_ROW}\n${emtaRow({ ...LIMITED_ROW, name: "<b>Näidis</b> OÜ" })}</tbody></table>`;
    expect(parseEmtaKmkrTable(html)).toEqual([
      { limited: true, registered_on: "2026-11-04", deleted_on: null, decision_on: "2026-11-04", vat_number: "EE103050067" },
    ]);
    const singleQuotedSpan = emtaAnswerHtml([LIMITED_ROW]).replace('class="boldblock"', "class='boldblock'");
    expect(parseEmtaKmkrTable(singleQuotedSpan)).toMatchObject([{ limited: true }]);
  });

  // A full row of the number next to a limited one (or a limited marker
  // anywhere unexpected) must never read as one full registration.
  const sameNumberLimited = { ...LIMITED_ROW, vatNumber: FULL_ROW.vatNumber };
  it.each([
    ["a limited row whose </tr> is omitted after a full row",
      `<table class="grid">${EMTA_HEADER_ROW}${emtaRow(FULL_ROW)}${emtaRow(sameNumberLimited, 2).replace(/<\/tr>$/, "")}</table>`],
    ["a second result table with single-quoted class",
      emtaAnswerHtml([FULL_ROW]) + emtaAnswerHtml([sameNumberLimited]).replace('class="grid"', "class='grid'")],
    ["a second result table with an unquoted class", emtaAnswerHtml([FULL_ROW]) + emtaAnswerHtml([sameNumberLimited]).replace('class="grid"', "class=grid")],
    ["the limited marker in the name cell", emtaAnswerHtml([{ ...FULL_ROW, name: "Piiratud käibemaksukohustuslane" }])],
    ["the limited marker in the name cell as entities", emtaAnswerHtml([{ ...FULL_ROW, name: "PIIRATUD K&auml;ibemaksukohustuslane" }])],
    ["the limited marker outside the table", emtaAnswerHtml([FULL_ROW]).replace("</table>", "</table><p>Piiratud käibemaksukohustuslane</p>")],
    ["the limited marker without a result table", "<html><body><p>Piiratud käibemaksukohustuslane</p></body></html>"],
    ["text between rows", `<table class="grid">${EMTA_HEADER_ROW}${emtaRow(FULL_ROW)}Piiratud${emtaRow(FULL_ROW, 2)}</table>`],
    ["a table nested in a cell", emtaAnswerHtml([{ ...FULL_ROW, name: "<table><tr><td>x</td></tr></table>" }])],
    ["a row opened inside a cell", emtaAnswerHtml([{ ...FULL_ROW, name: `x<tr>${emtaRow(sameNumberLimited)}` }])],
  ])("refuses %s", (_label, html) => {
    expect(parseEmtaKmkrTable(html)).toBeNull();
  });

  it.each([
    ["a limited row whose </tr> is omitted after a full row", `<table class="grid">${EMTA_HEADER_ROW}${emtaRow(FULL_ROW)}${emtaRow(sameNumberLimited, 2).replace(/<\/tr>$/, "")}</table>`],
    ["the limited marker outside the table", emtaAnswerHtml([FULL_ROW]).replace("</table>", "</table><p>Piiratud käibemaksukohustuslane</p>")],
    ["two full rows with text between them", `<table class="grid">${EMTA_HEADER_ROW}${emtaRow(FULL_ROW)}x${emtaRow(FULL_ROW, 2)}</table>`],
  ])("a refused page with registration content (%s) is contradictory evidence, never full", async (_label, html) => {
    expect(await lookupEmtaKmkr(FULL_ROW.vatNumber, { fetch: fakeEmtaFetch(html).impl })).toMatchObject({ ok: false, code: "emta_response_contradictory" });
  });

  it.each([
    ["a changed header around one row", `<table class="grid">${EMTA_HEADER_ROW.replace("Nimi", "Name")}${emtaRow(FULL_ROW)}</table>`],
    ["an unclosed table without rows", `<table class="grid">${EMTA_HEADER_ROW}`],
  ])("a refused page without registration content (%s) is an invalid answer (unavailable)", async (_label, html) => {
    expect(await lookupEmtaKmkr(FULL_ROW.vatNumber, { fetch: fakeEmtaFetch(html).impl })).toMatchObject({ ok: false, code: "emta_response_invalid" });
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

  const formThen = (answer: () => Response) => async (url: string) =>
    url === EMTA_KMKR_FORM_URL ? new Response(EMTA_FORM_HTML, { headers: { "content-type": "text/html" } }) : answer();

  it("an undeclared oversized body is cut off at the cap while streaming", async () => {
    let pulled = 0;
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    }));
    expect(await lookupEmtaKmkr("EE103050067", { fetch: formThen(endless) })).toMatchObject({ ok: false, code: "emta_response_invalid" });
    expect(pulled).toBeLessThanOrEqual(12);
  });

  it("the deadline covers the body: headers then a stalled body is unavailable (and throttling), not a hang", async () => {
    const stalled = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "content-type": "text/html" } });
    const started = Date.now();
    const outcome = await lookupEmtaKmkr("EE103050067", { fetch: formThen(stalled), timeoutMs: 20 });
    expect(outcome).toMatchObject({ ok: false, code: "emta_lookup_unavailable", throttled: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("HTTP 403 is reported as throttling", async () => {
    expect(await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch(403).impl })).toMatchObject({ ok: false, code: "emta_lookup_unavailable", throttled: true });
    const failed = await lookupEmtaKmkr("EE103050067", { fetch: fakeEmtaFetch(503).impl });
    expect(failed).toMatchObject({ ok: false, code: "emta_lookup_unavailable" });
    expect(failed).not.toHaveProperty("throttled");
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

  it("a cached answer older than the caller's stored evidence is not reused", async () => {
    resetEmtaKmkrCache();
    const fake = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    await lookupEmtaKmkrCached("EE102809963", 1_000, { fetch: fake.impl });
    await lookupEmtaKmkrCached("EE102809963", 3_000, { fetch: fake.impl }, 1_000);
    expect(fake.queries()).toHaveLength(1);
    expect(await lookupEmtaKmkrCached("EE102809963", 3_000, { fetch: fake.impl }, 2_000)).toMatchObject({ at: 3_000 });
    expect(fake.queries()).toHaveLength(2);
  });

  it("concurrent cold calls for one number share one request", async () => {
    resetEmtaKmkrCache();
    const fake = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    const results = await Promise.all(Array.from({ length: 5 }, () => lookupEmtaKmkrCached("EE102809963", 1_000, { fetch: fake.impl })));
    expect(fake.queries()).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
    expect(new Set(results).size).toBe(1);
  });

  it("older evidence never replaces a newer cached answer", async () => {
    resetEmtaKmkrCache();
    await lookupEmtaKmkrCached("EE102809963", 5_000, { fetch: fakeEmtaFetch(emtaAnswerHtml([FULL_ROW])).impl });
    const older = await lookupEmtaKmkrCached("EE102809963", 1_000, { fetch: fakeEmtaFetch(emtaAnswerHtml([{ ...FULL_ROW, limited: true }])).impl });
    expect(older).toMatchObject({ at: 5_000, outcome: { ok: true, registration: { limited: false } } });
  });

  it.each([
    ["a 403", () => fakeEmtaFetch(403).impl, {}],
    ["a timeout", () => formThenStalled, { timeoutMs: 20 }],
  ])("after %s nobody asks EMTA for a minute, for any number", async (_label, failing, extra) => {
    resetEmtaKmkrCache();
    await lookupEmtaKmkrCached("EE103050067", 1_000, { fetch: failing(), ...extra });
    const other = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    expect(await lookupEmtaKmkrCached("EE102809963", 30_000, { fetch: other.impl })).toMatchObject({ outcome: { ok: false, code: "emta_lookup_unavailable" } });
    expect(other.calls).toEqual([]);
    expect(await lookupEmtaKmkrCached("EE102809963", 1_000 + EMTA_THROTTLE_COOLDOWN_MS, { fetch: other.impl })).toMatchObject({ outcome: { ok: true } });
    expect(other.queries()).toHaveLength(1);
  });

  it("an ordinary network failure starts no cooldown for other numbers", async () => {
    resetEmtaKmkrCache();
    await lookupEmtaKmkrCached("EE103050067", 1_000, { fetch: fakeEmtaFetch("network").impl });
    const other = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    expect(await lookupEmtaKmkrCached("EE102809963", 2_000, { fetch: other.impl })).toMatchObject({ outcome: { ok: true } });
  });
});

const formThenStalled = async (url: string) =>
  url === EMTA_KMKR_FORM_URL
    ? new Response(EMTA_FORM_HTML, { headers: { "content-type": "text/html" } })
    : new Response(new ReadableStream<Uint8Array>({ start() {} }));
