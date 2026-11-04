#!/usr/bin/env tsx
/**
 * Read-only Lightyear rebuild comparison (plan Q5).
 *
 * Computes every journal the Lightyear tools would book for a period from one
 * account statement + one capital-gains file, starting from an in-memory pool
 * opening, and compares it with the current books per account and month.
 * It NEVER writes: the API client refuses every non-GET request before it is
 * sent, the pool store and plan store are not touched, nothing is audited.
 * Replacing journals is a separate owner decision.
 *
 *     npm run lightyear:rebuild-compare -- --statement AccountStatement-LY-<ACCOUNT>-….csv \
 *       --gains CapitalGainsStatement-….csv --from 2026-01-01 --to 2026-10-30 \
 *       --opening-as-of 2025-12-31 --start-usd-holding 0.37 --broker-dimension <id> --out report.md
 *
 * `--no-books` runs the statement simulation only (no credentials, no API call).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadAllConfigs, loadDotenvFiles } from "../src/config.js";
import { JournalsApi } from "../src/api/journals.api.js";
import { ReferenceDataApi } from "../src/api/readonly.api.js";
import { resolveEcbRate } from "../src/fx/ecb-rates.js";
import { usdCentsToEurCents, lightyearAccountFromFileName, statementPeriodFromFileName } from "../src/lightyear/usd-pool.js";
import {
  GetOnlyHttpClient,
  REBUILD_USAGE,
  compareWithBooks,
  parseRebuildArgs,
  renderRebuildReport,
  simulateLightyearYear,
  type RebuildAccounts,
} from "../src/lightyear/rebuild.js";

/** The owner's chart (CLAUDE.md "Lightyear defaults"). */
const ACCOUNTS: Omit<RebuildAccounts, "broker_dimension_id" | "investment_dimension_id"> = {
  broker_account: 1020, investment_account: 1100, income_account: 8330, interest_account: 8400, fund_distribution_account: 8320,
  reward_account: 8600, tax_account: 8610, trade_fee_account: 8335, distribution_fee_account: 8610, gain_account: 8330, loss_account: 8335, fx_account: 8500,
};
const COMPARED_ACCOUNTS = [1020, 1040, 1100, 8320, 8330, 8335, 8400, 8500, 8600, 8610];

async function main(): Promise<void> {
  let args;
  try {
    args = parseRebuildArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const lightyearAccount = args.lightyearAccount ?? lightyearAccountFromFileName(basename(args.statement));
  if (!lightyearAccount) {
    console.error(`The statement file name does not name the Lightyear account; pass --lightyear-account. ${REBUILD_USAGE}`);
    process.exit(2);
  }
  const ecb = {};
  const rate = await resolveEcbRate("USD", args.openingAsOf, ecb);
  if (!rate.ok) {
    console.error(`No ECB rate for the opening ${args.openingAsOf}: ${rate.code}.`);
    process.exit(1);
  }
  const usdCents = Math.round(args.startUsdHolding * 100);
  const eurCents = usdCentsToEurCents(usdCents, rate.rate.rate);
  if (eurCents === null) throw new Error("opening value out of range");
  const opening = { as_of: args.openingAsOf, usd_cents: usdCents, eur_cents: eurCents, rate: rate.rate.rate };
  const accounts: RebuildAccounts = {
    ...ACCOUNTS,
    ...(args.brokerDimension !== undefined ? { broker_dimension_id: args.brokerDimension } : {}),
    ...(args.investmentDimension !== undefined ? { investment_dimension_id: args.investmentDimension } : {}),
  };
  // Books mode: read the live chart first, so the simulation auto-fills an
  // account's only dimension the way the booking tools do (GET only).
  let selected = null;
  let chart: { accounts: Awaited<ReturnType<ReferenceDataApi["getAccounts"]>>; dimensions: Awaited<ReturnType<ReferenceDataApi["getAccountDimensions"]>> } | undefined;
  if (!args.noBooks) {
    loadDotenvFiles();
    const configs = loadAllConfigs();
    selected = configs[args.connection ?? 0] ?? null;
    if (!selected) {
      console.error(`No connection at index ${args.connection ?? 0} (${configs.length} configured).`);
      process.exit(1);
    }
    const readonly = new ReferenceDataApi(new GetOnlyHttpClient(selected.config));
    chart = { accounts: await readonly.getAccounts(), dimensions: await readonly.getAccountDimensions() };
  }
  const sim = await simulateLightyearYear({
    statementCsv: readFileSync(args.statement, "utf8"), gainsCsv: args.gains === null ? null : readFileSync(args.gains, "utf8"),
    from: args.from, to: args.to, lightyearAccount, opening, accounts, ecb,
    // The export's own coverage from its file name; without one the rows must prove it.
    statementPeriod: statementPeriodFromFileName(basename(args.statement)),
    ...(chart ? { chart } : {}),
  });

  let compare = null;
  if (selected) {
    const journals = await new JournalsApi(new GetOnlyHttpClient(selected.config)).listAllWithPostings();
    compare = compareWithBooks(sim.journals, journals, {
      from: args.from, to: args.to, accounts: COMPARED_ACCOUNTS,
      broker_account: accounts.broker_account, investment_account: accounts.investment_account,
      ...(accounts.broker_dimension_id !== undefined ? { broker_dimension_id: accounts.broker_dimension_id } : {}),
      ...(accounts.investment_dimension_id !== undefined ? { investment_dimension_id: accounts.investment_dimension_id } : {}),
    }, sim.statementTransfers);
  }

  const report = renderRebuildReport({ args, opening }, sim, compare);
  if (args.out === null) {
    process.stdout.write(report.markdown);
    process.stdout.write(`\n\`\`\`json\n${JSON.stringify(report.json, null, 2)}\n\`\`\`\n`);
  } else {
    writeFileSync(args.out, report.markdown);
    writeFileSync(`${args.out}.json`, JSON.stringify(report.json, null, 2));
    console.error(`Report written to ${args.out} and ${args.out}.json`);
  }
}

main().catch(error => {
  console.error(`lightyear:rebuild-compare failed: ${(error as Error).message}`);
  process.exit(1);
});
