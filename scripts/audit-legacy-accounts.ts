#!/usr/bin/env tsx
/**
 * One-off audit — find current-year ledger entries booked to the OLD default
 * accounts that commit 4e62810 ("fix(account-audit)") corrected.
 *
 * Before that fix the MCP's hardcoded defaults were written for a non-standard
 * template and pointed at the wrong accounts on the real e-arveldaja RTJ chart.
 * Anything the pre-fix server booked earlier this year (dividends, Lightyear
 * activity, FX-rounding differences) may therefore sit on the wrong account.
 * This script is READ-ONLY: it only lists GET/list data so you can review and
 * re-book by hand — it never mutates the ledger.
 *
 * Run from the project directory (where apikey*.txt / .env live):
 *     npx tsx scripts/audit-legacy-accounts.ts            # every connection, 2026
 *     npx tsx scripts/audit-legacy-accounts.ts --connection 0
 *     npx tsx scripts/audit-legacy-accounts.ts --since 2026-01-01 --json
 *     EARVELDAJA_SERVER=demo npx tsx scripts/audit-legacy-accounts.ts
 *
 * NOTE: in this API an account's `id` IS its account number (e.g. 2960), and a
 * posting's `accounts_id` references it — so matching on the number is direct.
 */
import { loadAllConfigs, loadDotenvFiles } from "../src/config.js";
import { HttpClient } from "../src/http-client.js";
import { JournalsApi } from "../src/api/journals.api.js";
import { ReferenceDataApi } from "../src/api/readonly.api.js";
import type { Account, Journal, Posting } from "../src/types/api.js";

/**
 * Old default account -> corrected account, with the concept and the source tool.
 * `realAccountWarning` marks numbers that are ALSO legitimate real accounts in the
 * standard chart, so a hit there is not automatically a mis-booking — it needs a
 * human look (e.g. genuine pension payments legitimately land on 2540).
 */
interface Correction {
  old: number;
  corrected: number;
  concept: string;
  tool: string;
  realAccountWarning?: string;
}

const CORRECTIONS: Correction[] = [
  { old: 3020, corrected: 2960, concept: "Retained earnings (dividend debit)", tool: "prepare_dividend_package" },
  { old: 2370, corrected: 2650, concept: "Dividend payable", tool: "prepare_dividend_package" },
  {
    old: 2540, corrected: 2656, concept: "Dividend income-tax payable", tool: "prepare_dividend_package",
    realAccountWarning: "2540 is 'Kogumispensioni maksed' (mandatory-pension payments) in the standard chart — genuine pension postings also land here.",
  },
  {
    old: 3000, corrected: 2900, concept: "Share capital (read by the ÄS §157 check)", tool: "rarely booked directly",
    realAccountWarning: "3000 is 'Põhivara müügi vahekonto' (fixed-asset-sale clearing) — a real account.",
  },
  { old: 3010, corrected: 2940, concept: "Reserve capital (read by the ÄS §157 check)", tool: "rarely booked directly" },
  { old: 3800, corrected: 8600, concept: "Lightyear platform reward", tool: "book_lightyear_distributions (LY:*)" },
];

/**
 * 8600 is dual-purpose: post-fix it is the CORRECT account for Lightyear rewards,
 * but pre-fix it was the (wrong) FX-loss account. So an 8600 posting is only
 * suspect when it represents an FX loss — detected via FX:* fingerprinted
 * journals in method B, never via the blanket method-A scan (which would flood
 * with legitimate reward postings).
 */
const OLD_FX_LOSS_ACCOUNT = 8600;
const CORRECT_FX_ACCOUNT = 8500;

const OLD_ACCOUNT_SET = new Set(CORRECTIONS.map(c => c.old));

interface Args {
  connection?: number;
  since: string;
  until: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    since: `${new Date().getFullYear()}-01-01`,
    until: new Date().toISOString().slice(0, 10),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--connection") args.connection = Number(argv[++i]);
    else if (a === "--since") args.since = argv[++i]!;
    else if (a === "--until") args.until = argv[++i]!;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: npx tsx scripts/audit-legacy-accounts.ts [--connection <i>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]");
      process.exit(0);
    }
  }
  return args;
}

const money = (n: number): string => n.toFixed(2);

function acctLabel(accounts: Map<number, Account>, id: number): string {
  const a = accounts.get(id);
  return a ? `${id} — ${a.name_est}${a.is_valid === false ? " (inactive)" : ""}` : `${id} — (not in chart)`;
}

interface Finding {
  method: "A" | "B";
  journal_id: number | undefined;
  date: string;
  title: string;
  document_number: string | null | undefined;
  account: number;
  account_name: string;
  type: string;
  amount: number;
  concept: string;
  reason: string;
}

function inWindow(date: string | undefined, since: string, until: string): boolean {
  if (!date) return false;
  const d = date.slice(0, 10); // ISO dates compare lexicographically
  return d >= since && d <= until;
}

interface ConnectionResult {
  name: string;
  server: string;
  findings: Finding[];
  journalsInWindow: number;
  chartIds: Set<number>;
}

async function auditConnection(
  name: string,
  server: string,
  httpClient: HttpClient,
  args: Args,
): Promise<ConnectionResult> {
  const readonly = new ReferenceDataApi(httpClient);
  const journalsApi = new JournalsApi(httpClient);

  const accountList = await readonly.getAccounts();
  const accounts = new Map<number, Account>(accountList.map(a => [a.id, a]));
  const chartIds = new Set<number>(accountList.map(a => a.id));

  const allJournals = await journalsApi.listAllWithPostings();
  const journals = allJournals.filter(
    (j: Journal) => j.is_deleted !== true && inWindow(j.effective_date, args.since, args.until),
  );

  const findings: Finding[] = [];
  const push = (j: Journal, p: Posting, method: "A" | "B", concept: string, reason: string) => {
    findings.push({
      method,
      journal_id: j.id,
      date: (j.effective_date ?? "").slice(0, 10),
      title: j.title ?? "",
      document_number: j.document_number,
      account: p.accounts_id,
      account_name: acctLabel(accounts, p.accounts_id),
      type: p.type ?? "?",
      amount: p.base_amount ?? p.amount,
      concept,
      reason,
    });
  };

  for (const j of journals) {
    const postings = (j.postings ?? []).filter(p => p.is_deleted !== true);
    const docNo = (j.document_number ?? "").trim();
    const isLightyear = /^LY:/i.test(docNo);
    const isFxRounding = /^FX:/i.test(docNo);
    const looksLikeDividend = /dividend/i.test(j.title ?? "");

    for (const p of postings) {
      // --- Method A: any posting landing on an unambiguous old default account ---
      if (OLD_ACCOUNT_SET.has(p.accounts_id)) {
        const c = CORRECTIONS.find(x => x.old === p.accounts_id)!;
        const reason = `Old default for "${c.concept}" (${c.tool}); corrected to ${c.corrected}.` +
          (c.realAccountWarning ? ` NOTE: ${c.realAccountWarning}` : "");
        push(j, p, "A", c.concept, reason);
      }

      // --- Method B: MCP-fingerprinted journals using an old / dual-purpose account ---
      if (isFxRounding && p.accounts_id === OLD_FX_LOSS_ACCOUNT) {
        push(j, p, "B", "FX loss (currency rounding)",
          `FX:* rounding journal posts to ${OLD_FX_LOSS_ACCOUNT} 'Muud finantstulud' (an income account) — an FX loss should now use the combined ${CORRECT_FX_ACCOUNT}.`);
      }
      if (isLightyear && p.accounts_id === 3800) {
        push(j, p, "B", "Lightyear platform reward",
          `LY:* journal posts to old reward account 3800; corrected to 8600.`);
      }
      if (looksLikeDividend && (p.accounts_id === 3020 || p.accounts_id === 2370 || p.accounts_id === 2540)) {
        // Already captured by method A, but flag with the dividend-journal context.
        push(j, p, "B", "Dividend journal",
          `Dividend-titled journal posts to old account ${p.accounts_id} — verify against corrected ${CORRECTIONS.find(c => c.old === p.accounts_id)?.corrected}.`);
      }
    }
  }

  return { name, server, findings, journalsInWindow: journals.length, chartIds };
}

function printReport(result: ConnectionResult, args: Args): void {
  const accountsPresent = (n: number): boolean => result.chartIds.has(n);
  const { name, findings, journalsInWindow } = result;
  console.log("");
  console.log("=".repeat(78));
  console.log(`Connection: ${name}   (${result.server})`);
  console.log(`Window:     ${args.since} .. ${args.until}`);
  console.log(`Journals in window (non-deleted): ${journalsInWindow}`);
  console.log("=".repeat(78));

  if (findings.length === 0) {
    console.log("✓ No postings to any corrected old default account in the window.");
    return;
  }

  // Group method-A findings (the exhaustive old-account scan) by account.
  const byAccount = new Map<number, Finding[]>();
  for (const f of findings) {
    if (f.method !== "A") continue;
    const list = byAccount.get(f.account) ?? [];
    list.push(f);
    byAccount.set(f.account, list);
  }

  console.log("\n--- Method A: postings landing on OLD default account numbers ---");
  for (const c of CORRECTIONS) {
    const hits = byAccount.get(c.old) ?? [];
    const flag = hits.length === 0 ? "✓" : "⚠";
    const correctedExists = accountsPresent(c.corrected) ? "" : `  [corrected ${c.corrected} NOT in this chart!]`;
    console.log(`\n[${c.old} → ${c.corrected}] ${c.concept} — ${hits.length} posting(s) ${flag}${correctedExists}`);
    if (c.realAccountWarning) console.log(`    ${c.realAccountWarning}`);
    for (const f of hits) {
      console.log(`    • ${f.date}  J#${f.journal_id}  ${f.type} ${money(f.amount)}  "${f.title}"  doc:${f.document_number ?? "—"}`);
    }
  }

  const methodB = findings.filter(f => f.method === "B");
  console.log("\n--- Method B: MCP-fingerprinted journals (LY:* / FX:* / dividend) ---");
  if (methodB.length === 0) {
    console.log("✓ No fingerprinted journal posts to a wrong/dual-purpose account.");
  } else {
    for (const f of methodB) {
      console.log(`    ⚠ ${f.date}  J#${f.journal_id}  doc:${f.document_number ?? "—"}  "${f.title}"`);
      console.log(`        ${f.account_name}  ${f.type} ${money(f.amount)}  — ${f.reason}`);
    }
  }

  const suspectJournals = new Set(findings.map(f => f.journal_id));
  console.log(`\nSUMMARY: ${findings.length} suspect posting(s) across ${suspectJournals.size} journal(s).`);
  console.log("Review each and, if mis-booked, invalidate + re-book to the corrected account.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotenvFiles();

  const configs = loadAllConfigs();
  if (configs.length === 0) {
    console.error("No API credentials found. Run this from the project directory where apikey*.txt / .env live,");
    console.error("or set EARVELDAJA_API_KEY_ID / _PUBLIC_VALUE / _PASSWORD.");
    process.exit(1);
  }

  const selected = args.connection !== undefined
    ? configs.filter((_, i) => i === args.connection)
    : configs;
  if (selected.length === 0) {
    console.error(`No connection at index ${args.connection}. Available: 0..${configs.length - 1}.`);
    process.exit(1);
  }

  const results: ConnectionResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const nc = selected[i]!;
    const httpClient = new HttpClient(nc.config, `audit:${i}`);
    try {
      const result = await auditConnection(nc.name, nc.config.baseUrl, httpClient, args);
      results.push(result);
    } catch (err) {
      console.error(`\n✗ ${nc.name}: audit failed — ${(err as Error).message}`);
    }
  }

  if (args.json) {
    // chartIds is a Set — serialize it as a plain array count so JSON stays useful.
    console.log(JSON.stringify(
      results.map(r => ({ ...r, chartIds: undefined, chart_account_count: r.chartIds.size })),
      null,
      2,
    ));
    return;
  }

  for (const result of results) {
    printReport(result, args);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
