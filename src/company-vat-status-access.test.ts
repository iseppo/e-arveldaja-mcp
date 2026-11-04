import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// statSync of the status file can be made to fail like an inaccessible directory (EACCES).
const denied = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const deny = (path: unknown) => {
    if (denied.path !== undefined && String(path) === denied.path) {
      throw Object.assign(new Error(`EACCES: permission denied, stat '${denied.path}'`), { code: "EACCES" });
    }
  };
  return {
    ...actual,
    statSync: ((path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      deny(path);
      return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.statSync,
    existsSync: ((path: Parameters<typeof actual.existsSync>[0]) => {
      if (denied.path !== undefined && String(path) === denied.path) return false; // existsSync hides EACCES
      return actual.existsSync(path);
    }) as typeof actual.existsSync,
  };
});

import { LIMITED_VAT_STORE_FILE, companyVatStatusFromInfo, limitedVatStore } from "./company-vat-status.js";
import { resolveBundleStorePath } from "./accounting-rules.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limited-vat-access-"));
  process.env.EARVELDAJA_RULES_DIR = join(dir, "rules");
  limitedVatStore.reset();
});
afterEach(() => {
  denied.path = undefined;
  delete process.env.EARVELDAJA_RULES_DIR;
  limitedVatStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe("company VAT status store access", () => {
  it("keeps the default resolution when the store file (and its directory) genuinely does not exist", async () => {
    expect(await companyVatStatusFromInfo({ vat_number: "EE102345678" })).toMatchObject({ status: "full", source: "emta_lookup" });
    expect(await companyVatStatusFromInfo({})).toMatchObject({ status: "none", source: "derived" });
  });

  it("an inaccessible store (EACCES) is status unknown, never a derived full", async () => {
    denied.path = resolveBundleStorePath(LIMITED_VAT_STORE_FILE)!;
    const resolved = await companyVatStatusFromInfo({ vat_number: "EE102345678" });
    expect(resolved.status).toBe("unknown");
    expect(resolved.store_error).toContain("EACCES");
  });
});
