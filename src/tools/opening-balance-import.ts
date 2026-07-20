import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiContext } from "./crud-tools.js";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { parseOpeningBalances, OpeningBalanceParseError } from "../opening-balance-parse.js";
import { writeOpeningBalances } from "../opening-balance-store.js";
import { mutate } from "../annotations.js";

export function registerOpeningBalanceTools(server: McpServer, _api: ApiContext): void {
  registerTool(server, "import_opening_balances",
    "Capture the e-arveldaja 'Algbilansi kanded' (opening-balance) register — which the RIK API omits — so account balances, trial balance, P&L, annual report, and the dividend §157 checks fold it in. Paste the copied register text. dry_run (default true) previews the parsed per-account balances and the debit=credit check without saving; set dry_run=false to persist. Re-import replaces the stored set.",
    {
      pasted_text: z.string().describe("The copied 'Algbilansi kanded' register text (Nr / Kuupäev / Konto / Deebet / Kreedit columns)."),
      dry_run: z.boolean().optional().describe("Preview only, do not persist (default true)."),
    },
    { ...mutate, title: "Import Opening Balances (Algbilanss)" },
    async ({ pasted_text, dry_run }) => {
      const persist = dry_run === false;
      let parsed;
      try {
        parsed = parseOpeningBalances(pasted_text);
      } catch (error) {
        const msg = error instanceof OpeningBalanceParseError ? error.message : (error as Error).message;
        return { content: [{ type: "text", text: toMcpJson({ ok: false, error: msg }) }] };
      }

      // Structural post-parse invariant: parseOpeningBalances() already throws on any
      // imbalance > 0.01 (see the parse-error path above), so `balanced` is always true
      // by the time we get here. Imbalance is reported via that parse-error path, not
      // this field — kept for informativeness to callers, not as a live branch.
      const balanced = Math.abs(parsed.totals.debit - parsed.totals.credit) <= 0.01;
      const preview = {
        ok: true,
        persisted: false as boolean,
        opening_date: parsed.openingDate,
        balanced,
        totals: parsed.totals,
        account_count: parsed.accounts.length,
        accounts: parsed.accounts.map(a => ({
          code: a.code,                                 // code stays clean (matching key)
          name: wrapUntrustedOcr(a.name) ?? a.name,     // name is pasted content → sandbox
          debit: a.debit,
          credit: a.credit,
          dimension: a.dimension.map(d => wrapUntrustedOcr(d) ?? d), // dimension labels are pasted content → sandbox
        })),
        next_step: persist ? undefined
          : "Review the accounts above. To save, call again with dry_run=false.",
      };

      if (!persist) {
        return { content: [{ type: "text", text: toMcpJson(preview) }] };
      }

      // Use a caller-supplied-free timestamp source consistent with the codebase.
      try {
        const stored = writeOpeningBalances(parsed, new Date().toISOString());
        return { content: [{ type: "text", text: toMcpJson({ ...preview, persisted: true, parsed_at: stored.parsedAt }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: toMcpJson({ ok: false, error: (error as Error).message }) }] };
      }
    },
  );
}
