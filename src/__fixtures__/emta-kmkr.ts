// EMTA public KMKR query fixtures (row shapes live-verified 2026-11-04; names anonymised).
import { EMTA_KMKR_FORM_URL, EMTA_KMKR_QUERY_URL } from "../emta-kmkr.js";

export const EMTA_HEADER_ROW =
  "<tr><th>Jrk</th><th>Isikukood/registrikood</th><th>Nimi</th><th>Registreerimise kuupäev</th><th>Kustutamise kuupäev</th><th>Otsuse kuupäev</th><th>Käibemaksukohustuslasena registreerimise number</th></tr>";

export interface EmtaFixtureRow {
  code?: string;
  limited?: boolean;
  name?: string;
  registered: string;
  deleted?: string;
  decision?: string;
  vatNumber: string;
}

export function emtaRow(row: EmtaFixtureRow, index = 1): string {
  const code = `${row.code ?? "14417608"}${row.limited ? "<br/><span class=\"boldblock\">Piiratud käibemaksukohustuslane</span>" : ""}`;
  return `<tr><td>${index}</td><td>${code}</td><td>${row.name ?? "Näidis OÜ"}</td><td>${row.registered}</td><td>${row.deleted ?? ""}</td><td>${row.decision ?? row.registered}</td><td>${row.vatNumber}</td></tr>`;
}

export function emtaAnswerHtml(rows: readonly EmtaFixtureRow[]): string {
  return `<html><body><h1>KMKR numbri päring</h1><table class="grid">${EMTA_HEADER_ROW}${rows.map((row, index) => emtaRow(row, index + 1)).join("")}</table></body></html>`;
}

/** The limited taxpayer row shape (Seppo OÜ, live 2026-11-04). */
export const LIMITED_ROW: EmtaFixtureRow = { code: "14417608", limited: true, registered: "04.11.2026", decision: "04.11.2026", vatNumber: "EE103050067" };
/** The full VAT payer row shape (Seppo AI OÜ, live 2026-11-04). */
export const FULL_ROW: EmtaFixtureRow = { code: "17133416", registered: "16.12.2024", decision: "14.12.2024", vatNumber: "EE102809963" };

export const EMTA_FORM_HTML = "<form method=\"post\" action=\"/saqu/public/kmkrnr/query\"><input type=\"text\" name=\"personCode\"><input type=\"hidden\" name=\"CSRFToken\" value=\"abc123-csrf-token\"><input type=\"submit\" name=\"p_submit\" value=\"Otsi\"></form>";

export interface EmtaFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A fetch that plays EMTA: the form, then `answer` for the query (HTML, or
 * "network" / an HTTP status to fail). Records every call; any other URL throws.
 */
export function fakeEmtaFetch(answer: string | "network" | number | ((vatNumber: string) => string)) {
  const calls: EmtaFetchCall[] = [];
  const impl = async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers ?? {}) }, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url === EMTA_KMKR_FORM_URL) {
      return new Response(EMTA_FORM_HTML, { headers: { "content-type": "text/html;charset=UTF-8", "set-cookie": "JSESSIONID=s1; Path=/saqu; Secure; HttpOnly" } });
    }
    if (url !== EMTA_KMKR_QUERY_URL) throw new TypeError(`unexpected fetch ${url}`);
    if (answer === "network") throw new TypeError("fetch failed");
    if (typeof answer === "number") return new Response("error", { status: answer });
    const vatNumber = new URLSearchParams(String(init?.body ?? "")).get("personCode") ?? "";
    return new Response(typeof answer === "function" ? answer(vatNumber) : answer, { headers: { "content-type": "text/html;charset=UTF-8" } });
  };
  return { impl, calls, queries: () => calls.filter(call => call.url === EMTA_KMKR_QUERY_URL) };
}
