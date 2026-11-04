// Vitest setup (vitest.config.ts setupFiles): every test gets its own, not yet
// existing global config dir, so code paths that persist to the default
// accounting-rules bundle (statement balances, receipt attachment digests)
// never write to the developer's real ~/.config and never leak records from
// one test into the next. A test that sets EARVELDAJA_CONFIG_DIR or
// EARVELDAJA_RULES_DIR itself still wins (its own hooks run later).
//
// Unit tests never reach the network: a test that needs fetch stubs it itself
// (vi.stubGlobal). Without a stub, a code path that calls a live service (the
// business registry lookup, ECB rates) gets an immediate network failure
// instead of waiting on the real host — a slow host used to turn such tests
// into timeouts.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach } from "vitest";
import { clearRegistryNameCache } from "../receipts/registry-name-cache.js";
import { EMTA_KMKR_FORM_URL, EMTA_KMKR_QUERY_URL, resetEmtaKmkrCache } from "../emta-kmkr.js";

const root = mkdtempSync(join(tmpdir(), "earveldaja-test-config-"));
let counter = 0;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? "";
  const emta = fakeEmtaKmkr(url, init);
  if (emta) return emta;
  throw new TypeError(`fetch failed: network is disabled in unit tests (${url})`);
}) as typeof fetch;

/**
 * EMTA's public KMKR query, faked in-process: every Estonian VAT number is an
 * active full registration (the status a VAT number had before the lookup
 * existed), so tests of VAT-registered companies need no per-test stub. Tests
 * of the lookup itself (limited, deleted, failures) inject their own fetch.
 */
function fakeEmtaKmkr(url: string, init: RequestInit | undefined): Response | undefined {
  if (url === EMTA_KMKR_FORM_URL) {
    return new Response('<form><input type="hidden" name="CSRFToken" value="test-csrf-token"></form>', {
      headers: { "content-type": "text/html;charset=UTF-8", "set-cookie": "JSESSIONID=test; Path=/; Secure" },
    });
  }
  if (url !== EMTA_KMKR_QUERY_URL) return undefined;
  const vatNumber = new URLSearchParams(String(init?.body ?? "")).get("personCode") ?? "";
  return new Response(
    "<table class=\"grid\"><tr><th>Jrk</th><th>Isikukood/registrikood</th><th>Nimi</th><th>Registreerimise kuupäev</th><th>Kustutamise kuupäev</th><th>Otsuse kuupäev</th><th>Käibemaksukohustuslasena registreerimise number</th></tr>" +
      `<tr><td>1</td><td>10000000</td><td>Test OÜ</td><td>01.01.2020</td><td></td><td>01.01.2020</td><td>${vatNumber}</td></tr></table>`,
    { headers: { "content-type": "text/html;charset=UTF-8" } },
  );
}
process.env.EARVELDAJA_CONFIG_DIR = join(root, "module");

beforeEach(() => {
  process.env.EARVELDAJA_CONFIG_DIR = join(root, `t${counter++}`);
  // Business-register names cached by the extraction cross-check never carry
  // from one test's fetch stub into the next.
  clearRegistryNameCache();
  resetEmtaKmkrCache();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
