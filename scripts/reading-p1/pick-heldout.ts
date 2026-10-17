// Held-out pick (OQ-P1-4, owner 2026-10-17: "you choose"). Scans the candidate folders for PDFs not in the
// corpus manifest, parses each once, and keeps documents in the real-today window (invoice date on or
// after {year(today)-1}-01-01), at most PER_SUPPLIER per supplier. Writes heldout/{files.txt, sha256.txt,
// own.json, pick.json}. Only pick metadata is printed (counts, folders, dates); no reader or checker
// result is computed here.
//
// Usage: npx tsx scripts/reading-p1/pick-heldout.ts --root <dir> --folders a,b,c [--topup d,e] [--min 30]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeVatValue } from "../../src/document-identifiers.js";
import { buildPacketFile, type OwnIds } from "./build-packets.js";
import { argValue, dataPath, readJson, readLines, sha256Hex, todayIso, writeJson, writePrivate } from "./common.js";

const PER_SUPPLIER = 3;

function pdfsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...pdfsUnder(path));
    else if (/\.pdf$/i.test(name)) out.push(path);
  }
  return out.sort();
}

interface CompanyRule { prefix: string; own: OwnIds }

interface Candidate {
  path: string;
  folder: string;
  sha256: string;
  own: OwnIds;
  supplier: string | null;
  date: string | null;
  date_source: "booked" | "heuristic" | null;
}

function supplierKey(fields: { supplier_reg: string | null; supplier_vat: string | null; supplier_name: string | null }): string | null {
  if (fields.supplier_vat) return normalizeVatValue(fields.supplier_vat) ?? fields.supplier_vat;
  if (fields.supplier_reg) return fields.supplier_reg.replace(/\s+/g, "");
  return fields.supplier_name ? fields.supplier_name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : null;
}

/** The booked invoice date when an attached document has this sha256 (the snapshot), else undefined. */
function bookedDate(company: string, sha: string): string | undefined {
  try {
    const documents = readJson<Array<{ invoice_id: number; sha256: string | null }>>(dataPath("snapshots", company, "documents.json"));
    const invoices = readJson<Array<{ id: number; create_date: string }>>(dataPath("snapshots", company, "purchase_invoices.json"));
    const ids = documents.filter((row) => row.sha256 === sha).map((row) => row.invoice_id);
    const dates = [...new Set(invoices.filter((invoice) => ids.includes(invoice.id)).map((invoice) => invoice.create_date))];
    return dates.length === 1 ? dates[0] : undefined;
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<void> {
  const root = argValue(argv, "--root");
  const folders = argValue(argv, "--folders")?.split(",") ?? [];
  const topup = argValue(argv, "--topup")?.split(",") ?? [];
  const min = Number(argValue(argv, "--min") ?? "30");
  const rules = readJson<CompanyRule[]>(argValue(argv, "--company-rules") ?? dataPath("heldout", "company-rules.json"));
  if (!root || folders.length === 0) throw new Error("--root and --folders required");
  const corpus = new Set(readLines(dataPath("corpus", "files.txt")));
  const corpusSha = new Set(readLines(dataPath("corpus", "sha256.txt")).map((line) => line.split("  ")[0]));
  const windowStart = `${Number(todayIso().slice(0, 4)) - 1}-01-01`;

  const scan = async (folder: string): Promise<{ kept: Candidate[]; out_of_window: Candidate[]; no_date: Candidate[] }> => {
    const kept: Candidate[] = [];
    const outOfWindow: Candidate[] = [];
    const noDate: Candidate[] = [];
    for (const path of pdfsUnder(join(root, folder))) {
      if (corpus.has(path)) continue;
      const sha = sha256Hex(readFileSync(path));
      if (corpusSha.has(sha)) continue;
      const rule = rules.find((entry) => relative(root, path).startsWith(entry.prefix));
      if (!rule) continue;
      const file = await buildPacketFile("candidate", path, rule.own);
      const booked = bookedDate(rule.own.reg ?? rule.own.vat ?? "", sha);
      const date = booked ?? file.heuristic_fields.invoice_date;
      const candidate: Candidate = {
        path, folder, sha256: sha, own: rule.own,
        supplier: supplierKey(file.heuristic_fields),
        date: date ?? null,
        date_source: booked ? "booked" : date ? "heuristic" : null,
      };
      if (!date) noDate.push(candidate);
      else if (date < windowStart) outOfWindow.push(candidate);
      else kept.push(candidate);
    }
    return { kept, out_of_window: outOfWindow, no_date: noDate };
  };

  const perSupplier = new Map<string, number>();
  const picks: Candidate[] = [];
  const excluded: Array<{ folder: string; reason: string }> = [];
  const take = (candidates: Candidate[]) => {
    for (const candidate of candidates) {
      const key = candidate.supplier ?? `unknown:${candidate.sha256.slice(0, 8)}`;
      const count = perSupplier.get(key) ?? 0;
      if (count >= PER_SUPPLIER) {
        excluded.push({ folder: candidate.folder, reason: "supplier_cap" });
        continue;
      }
      perSupplier.set(key, count + 1);
      picks.push(candidate);
    }
  };
  for (const folder of folders) {
    const result = await scan(folder);
    take(result.kept);
    for (const candidate of result.out_of_window) excluded.push({ folder: candidate.folder, reason: "out_of_window" });
    for (const candidate of result.no_date) excluded.push({ folder: candidate.folder, reason: "no_invoice_date" });
  }
  const primary = picks.length;
  for (const folder of topup) {
    if (picks.length >= min) break;
    const result = await scan(folder);
    take(result.kept);
    for (const candidate of result.out_of_window) excluded.push({ folder: candidate.folder, reason: "out_of_window" });
    for (const candidate of result.no_date) excluded.push({ folder: candidate.folder, reason: "no_invoice_date" });
  }

  writePrivate(dataPath("heldout", "files.txt"), `${picks.map((pick) => pick.path).join("\n")}\n`);
  writePrivate(dataPath("heldout", "sha256.txt"), `${picks.map((pick) => `${pick.sha256}  ${pick.path}`).join("\n")}\n`);
  const own: Record<string, OwnIds> = {};
  picks.forEach((pick, index) => { own[`h${String(index + 1).padStart(2, "0")}`] = pick.own; });
  writeJson(dataPath("heldout", "own.json"), own);
  const dates = picks.map((pick) => pick.date!).sort();
  const summary = {
    picked: picks.length,
    from_named_folders: primary,
    from_topup: picks.length - primary,
    by_folder: picks.reduce<Record<string, number>>((acc, pick) => ({ ...acc, [pick.folder]: (acc[pick.folder] ?? 0) + 1 }), {}),
    date_range: [dates[0], dates[dates.length - 1]],
    date_sources: picks.reduce<Record<string, number>>((acc, pick) => ({ ...acc, [pick.date_source ?? "none"]: (acc[pick.date_source ?? "none"] ?? 0) + 1 }), {}),
    distinct_suppliers: new Set(picks.map((pick) => pick.supplier ?? pick.sha256)).size,
    foreign_supplier_ids: picks.filter((pick) => pick.supplier !== null && /^[A-Z]{2}/.test(pick.supplier) && !pick.supplier.startsWith("EE")).length,
    excluded: excluded.reduce<Record<string, number>>((acc, row) => ({ ...acc, [`${row.folder}:${row.reason}`]: (acc[`${row.folder}:${row.reason}`] ?? 0) + 1 }), {}),
    window_start: windowStart,
  };
  writeJson(dataPath("heldout", "pick.json"), { summary, picks: picks.map(({ path, folder, sha256, supplier, date, date_source }) => ({ path, folder, sha256, supplier, date, date_source })) });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
