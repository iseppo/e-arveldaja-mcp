import { describe, expect, it, vi } from "vitest";
import {
  ecbObservationsUrl,
  fetchEcbObservations,
  readFrozenFxOutcomes,
  replayFrozenFx,
  resolveEcbRate,
  resolveFrozenFxOutcomes,
  type EcbFetch,
  type EcbFetchResponse,
} from "./ecb-rates.js";

const HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS";

function csv(rows: Array<[string, string]>, key = "EXR.D.USD.EUR.SP00.A"): string {
  return [HEADER, ...rows.map(([date, value]) => `${key},D,USD,EUR,SP00,A,${date},${value},A`)].join("\n") + "\n";
}

function response(body: string, init: { status?: number; contentLength?: string } = {}): EcbFetchResponse {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === "content-length" ? init.contentLength ?? null : null) },
    text: async () => body,
  };
}

function fakeFetch(...bodies: Array<EcbFetchResponse | Error>): ReturnType<typeof vi.fn> & EcbFetch {
  const fn = vi.fn();
  for (const body of bodies) {
    if (body instanceof Error) fn.mockRejectedValueOnce(body);
    else fn.mockResolvedValueOnce(body);
  }
  return fn as ReturnType<typeof vi.fn> & EcbFetch;
}

const deps = (fetch: EcbFetch, today = "2026-10-31") => ({ fetch, today: () => today, now: () => new Date("2026-10-31T08:00:00Z"), cache: new Map() });

describe("ECB reference rates", () => {
  it("builds the documented data-API URL", () => {
    expect(ecbObservationsUrl("USD", "2026-09-25", "2026-10-05")).toBe(
      "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2026-09-25&endPeriod=2026-10-05&format=csvdata",
    );
  });

  it("parses the verified CSV shape and returns the rate of the requested day", async () => {
    const fetch = fakeFetch(response(csv([["2026-10-01", "1.1298"], ["2026-10-02", "1.1225"], ["2026-10-05", "1.1180"]])));
    const outcome = await resolveEcbRate("USD", "2026-10-02", deps(fetch));
    expect(outcome).toEqual({
      ok: true,
      rate: expect.objectContaining({ source: "ecb", rate: "1.1225", rate_date: "2026-10-02", requested_date: "2026-10-02", orientation: "foreign_per_eur", series: "EXR.D.USD.EUR.SP00.A" }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(ecbObservationsUrl("USD", "2026-09-25", "2026-10-09"));
  });

  it("takes Friday's rate for a weekend day", async () => {
    const fetch = fakeFetch(response(csv([["2026-10-02", "1.1225"], ["2026-10-05", "1.1180"]])));
    const outcome = await resolveEcbRate("USD", "2026-10-04", deps(fetch));
    expect(outcome.ok && outcome.rate).toMatchObject({ rate: "1.1225", rate_date: "2026-10-02", requested_date: "2026-10-04" });
  });

  it("looks back over a holiday gap within seven days", async () => {
    const fetch = fakeFetch(response(csv([["2026-12-23", "1.0900"], ["2026-12-29", "1.0950"]])));
    const outcome = await resolveEcbRate("USD", "2026-12-28", deps(fetch, "2027-01-10"));
    expect(outcome.ok && outcome.rate.rate_date).toBe("2026-12-23");
  });

  it("an eight-day gap is unavailable", async () => {
    const fetch = fakeFetch(response(csv([["2026-10-12", "1.1000"]])));
    expect(await resolveEcbRate("USD", "2026-10-11", deps(fetch))).toEqual({ ok: false, code: "ecb_rate_unavailable" });
  });

  it("today and later are not final and fetch nothing", async () => {
    const fetch = fakeFetch();
    expect(await resolveEcbRate("USD", "2026-10-31", deps(fetch))).toEqual({ ok: false, code: "ecb_rate_not_final" });
    expect(await resolveEcbRate("USD", "2026-11-02", deps(fetch))).toEqual({ ok: false, code: "ecb_rate_not_final" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong KEY", csv([["2026-10-02", "1.1225"]], "EXR.D.GBP.EUR.SP00.A")],
    ["negative value", csv([["2026-10-02", "-1.1225"]])],
    ["non-decimal value", csv([["2026-10-02", "1.1e2"]])],
    ["date outside the window", csv([["2026-11-30", "1.1225"]])],
    ["missing column", "KEY,TIME_PERIOD\nEXR.D.USD.EUR.SP00.A,2026-10-02\n"],
  ])("%s is ecb_response_invalid", async (_label, body) => {
    const fetch = fakeFetch(response(body));
    expect(await resolveEcbRate("USD", "2026-10-02", deps(fetch))).toEqual({ ok: false, code: "ecb_response_invalid" });
  });

  it("an oversized body is invalid (declared or actual)", async () => {
    const big = csv([["2026-10-02", "1.1225"]]) + "x".repeat(70 * 1024);
    expect(await resolveEcbRate("USD", "2026-10-02", deps(fakeFetch(response("", { contentLength: String(70 * 1024) })))))
      .toEqual({ ok: false, code: "ecb_response_invalid" });
    expect(await resolveEcbRate("USD", "2026-10-02", deps(fakeFetch(response(big))))).toEqual({ ok: false, code: "ecb_response_invalid" });
  });

  it("timeout, network error and HTTP errors are unavailable; 404 is an empty window", async () => {
    expect(await resolveEcbRate("USD", "2026-10-02", deps(fakeFetch(new Error("aborted"))))).toEqual({ ok: false, code: "ecb_rate_unavailable" });
    expect(await resolveEcbRate("USD", "2026-10-02", deps(fakeFetch(response("err", { status: 503 }))))).toEqual({ ok: false, code: "ecb_rate_unavailable" });
    expect(await resolveEcbRate("USD", "2026-10-02", deps(fakeFetch(response("No results found", { status: 404 }))))).toEqual({ ok: false, code: "ecb_rate_unavailable" });
  });

  it("aborts a hanging request after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch: EcbFetch = (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      const pending = fetchEcbObservations("USD", "2026-09-25", "2026-10-02", { fetch });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toEqual({ ok: false, code: "ecb_rate_unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses EUR and malformed currencies without a request", async () => {
    const fetch = fakeFetch();
    expect(await resolveEcbRate("EUR", "2026-10-02", deps(fetch))).toEqual({ ok: false, code: "ecb_response_invalid" });
    expect(await fetchEcbObservations("US/D", "2026-09-25", "2026-10-02", { fetch })).toEqual({ ok: false, code: "ecb_response_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a final rate (a later day exists) is served from cache with no second request", async () => {
    const fetch = fakeFetch(response(csv([["2026-10-02", "1.1225"], ["2026-10-05", "1.1180"]])));
    const shared = deps(fetch);
    await resolveEcbRate("USD", "2026-10-02", shared);
    const again = await resolveEcbRate("USD", "2026-10-02", shared);
    expect(again.ok && again.rate.rate).toBe("1.1225");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a corrected previous-day observation replaces the provisional one and is then cached final", async () => {
    const fetch = fakeFetch(
      response(csv([["2026-10-29", "1.1172"]])),
      response(csv([["2026-10-29", "1.1175"], ["2026-10-30", "1.1180"]])),
    );
    const shared = deps(fetch, "2026-10-30");
    const first = await resolveEcbRate("USD", "2026-10-29", shared);
    expect(first.ok && first.rate.rate).toBe("1.1172");
    const laterDeps = { ...shared, today: () => "2026-10-31" };
    const second = await resolveEcbRate("USD", "2026-10-29", laterDeps);
    expect(second.ok && second.rate.rate).toBe("1.1175");
    const third = await resolveEcbRate("USD", "2026-10-29", laterDeps);
    expect(third.ok && third.rate.rate).toBe("1.1175");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("freezes successes and failures; replay never fetches and an absent key is fx_rate_unbound", async () => {
    // Keys resolve in sorted order: GBP first (times out), then USD.
    const fetch = fakeFetch(new Error("timeout"), response(csv([["2026-10-01", "1.1298"], ["2026-10-02", "1.1225"]])));
    const frozen = await resolveFrozenFxOutcomes(["USD:2026-10-01", "USD:2026-10-31", "GBP:2026-10-01"], deps(fetch));
    expect(frozen["USD:2026-10-01"]).toMatchObject({ ok: true, rate: { rate: "1.1298" } });
    expect(frozen["USD:2026-10-31"]).toEqual({ ok: false, code: "ecb_rate_not_final" });
    expect(frozen["GBP:2026-10-01"]).toEqual({ ok: false, code: "ecb_rate_unavailable" });
    const roundTripped = readFrozenFxOutcomes(JSON.parse(JSON.stringify({ fx_outcomes: frozen })));
    expect(replayFrozenFx(roundTripped, "GBP", "2026-10-01")).toEqual({ ok: false, code: "ecb_rate_unavailable" });
    expect(replayFrozenFx(roundTripped, "USD", "2026-10-01")).toMatchObject({ ok: true, rate: { rate: "1.1298" } });
    expect(replayFrozenFx(roundTripped, "USD", "2026-10-02")).toEqual({ ok: false, code: "fx_rate_unbound" });
    expect(replayFrozenFx(roundTripped, "USD", "__proto__")).toEqual({ ok: false, code: "fx_rate_unbound" });
  });
});
