import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, stat, realpath } from "fs/promises";
import { resolve, extname } from "path";
import pdf from "pdf-parse";
import { closest } from "fastest-levenshtein";
import type { ApiContext } from "./crud-tools.js";
import type { PurchaseInvoice, PurchaseInvoiceItem } from "../types/api.js";

const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50 MB

const MAX_JSON_INPUT_SIZE = 1024 * 1024; // 1 MB

function safeJsonParse(input: string, label: string): unknown {
  if (input.length > MAX_JSON_INPUT_SIZE) {
    throw new Error(`JSON input for "${label}" exceeds maximum size of ${MAX_JSON_INPUT_SIZE} bytes`);
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
}

async function validatePdfPath(filePath: string): Promise<string> {
  const resolved = resolve(filePath);
  const ext = extname(resolved).toLowerCase();
  if (ext !== ".pdf") {
    throw new Error(`Only PDF files are allowed, got: ${ext}`);
  }
  // Resolve symlinks to get the real path and prevent symlink traversal
  const real = await realpath(resolved);
  const realExt = extname(real).toLowerCase();
  if (realExt !== ".pdf") {
    throw new Error(`Symlink target is not a PDF file`);
  }
  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`Not a file`);
  }
  if (info.size > MAX_PDF_SIZE) {
    throw new Error(`File too large: ${(info.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_PDF_SIZE / 1024 / 1024} MB)`);
  }
  return real;
}

interface ExtractedInvoice {
  supplier_name?: string;
  supplier_reg_code?: string;
  supplier_vat_no?: string;
  supplier_iban?: string;
  invoice_number?: string;
  invoice_date?: string;
  due_date?: string;
  total_net?: number;
  total_vat?: number;
  total_gross?: number;
  ref_number?: string;
  items: Array<{
    description: string;
    amount?: number;
    unit_price?: number;
    total?: number;
    vat_rate?: number;
  }>;
  raw_text: string;
}

function extractInvoiceData(text: string): ExtractedInvoice {
  const result: ExtractedInvoice = { items: [], raw_text: text };

  // Registry code patterns
  const regCodeMatch = text.match(/(?:Reg\.?\s*(?:nr|kood|code)|Registrikood|Registry code)[:\s]*(\d{8})/i);
  if (regCodeMatch) result.supplier_reg_code = regCodeMatch[1];

  // VAT number
  const vatMatch = text.match(/(?:KMKR|VAT|KM\s*nr)[:\s]*(EE\d+)/i);
  if (vatMatch) result.supplier_vat_no = vatMatch[1];

  // IBAN — digits-only BBAN pattern (covers Estonian and most European IBANs).
  // Minimum 15 chars (country + 13 digits) excludes VAT numbers (EE + 9 digits).
  // Negative lookahead prevents matching into concatenated bank names (e.g. "EE91...8531Swedbank").
  const ibanMatch = text.match(/\b([A-Z]{2}\d{13,30})(?!\d)/);
  if (ibanMatch) result.supplier_iban = ibanMatch[1];

  // Invoice number — Estonian and English patterns
  const invMatch = text.match(
    /(?:Arve|Invoice|müügipakkumine|meeldetuletus|pakkumine|kreeditarve|ettemaksuarve)\s*(?:nr|no|number|#)[.:\s]*([A-Z0-9-]+)/i
  ) ?? text.match(/\bnr\.?\s+(\d{5,})\b/i); // fallback: standalone "nr." + 5+ digit number
  if (invMatch) result.invoice_number = invMatch[1];

  // Dates (DD.MM.YYYY)
  const datePattern = /(\d{2}[./-]\d{2}[./-]\d{4})/g;
  const dates = text.match(datePattern) ?? [];
  if (dates.length > 0) {
    result.invoice_date = convertDate(dates[0]!);
    if (dates.length > 1) result.due_date = convertDate(dates[1]!);
  }

  // Reference number
  const refMatch = text.match(/(?:Viitenumber|Viitenr|Ref\.?\s*(?:nr|number)|viitenumbrit)[:\s]*(\d+)/i);
  if (refMatch) result.ref_number = refMatch[1];

  // Totals — PDF table layouts often render as "amount + label" (amount before keyword)
  // or "label: amount" (amount after keyword). Try both directions.
  const grossAfter = text.match(/(?:Kokku|Total|Summa|Tasuda|Tasumiseks)[:\s]*(\d[\d\s]*[.,]\d{2})\s*(?:€|EUR)?/i);
  const grossBefore = text.match(/(\d[\d\s]*[.,]\d{2})\s*(?:Kokku|Total|Summa|Tasuda|Tasumiseks)\b/i);
  if (grossAfter) result.total_gross = parseAmount(grossAfter[1]);
  else if (grossBefore) result.total_gross = parseAmount(grossBefore[1]);

  const netAfter = text.match(/(?:Summa ilma KM|Käibemaksuta|Net|Neto|Maksumuseta)[:\s]*(\d[\d\s]*[.,]\d{2})/i);
  const netBefore = text.match(/(\d[\d\s]*[.,]\d{2})\s*(?:Käibemaksuta|Summa ilma KM|Maksumuseta)\b/i);
  if (netAfter) result.total_net = parseAmount(netAfter[1]);
  else if (netBefore) result.total_net = parseAmount(netBefore[1]);

  // Negative lookahead prevents matching "Käibemaksuta" (without VAT) as "Käibemaks"
  const vatAfter = text.match(/(?:Käibemaks(?!uta|eta)|KMS|VAT)\s*(?:\(\d+%\)\s*)?[:\s]*(\d[\d\s]*[.,]\d{2})/i);
  const vatBefore = text.match(/(\d[\d\s]*[.,]\d{2})\s*(?:Käibemaks(?!uta|eta)|KMS|VAT)\s*(?:\(\d+%\))?/i);
  if (vatBefore) result.total_vat = parseAmount(vatBefore[1]);
  else if (vatAfter) result.total_vat = parseAmount(vatAfter[1]);

  // Supplier name detection (multi-strategy):
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 2);

  // Strategy 1: Line immediately before the registry code (most reliable)
  if (result.supplier_reg_code) {
    const regCodeIdx = lines.findIndex(l => l.includes(result.supplier_reg_code!));
    if (regCodeIdx > 0) {
      result.supplier_name = lines[regCodeIdx - 1];
    }
  }

  // Strategy 2: Line with Estonian company prefix/suffix
  if (!result.supplier_name) {
    const companyLine = lines.find(l =>
      /\b(?:AS|OÜ|MTÜ|SA|TÜ|FIE|aktsiaselts|osaühing)\b/i.test(l)
    );
    if (companyLine) result.supplier_name = companyLine;
  }

  // Strategy 3: Fallback to first non-empty line
  if (!result.supplier_name && lines.length > 0) {
    result.supplier_name = lines[0];
  }

  return result;
}

function parseAmount(s: string): number {
  return parseFloat(s.replace(/\s/g, "").replace(",", "."));
}

function convertDate(d: string): string {
  const parts = d.split(/[./-]/);
  if (parts.length === 3 && parts[2].length === 4) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`; // DD.MM.YYYY -> YYYY-MM-DD
  }
  return d;
}

export function registerPdfWorkflowTools(server: McpServer, api: ApiContext): void {

  server.tool("extract_pdf_invoice",
    "Extract invoice data from a PDF file. Returns structured data (supplier, amounts, items) " +
    "and the raw text for AI to review and correct.",
    {
      file_path: z.string().describe("Absolute path to the PDF file"),
    },
    async ({ file_path }) => {
      const resolved = await validatePdfPath(file_path);
      const buffer = await readFile(resolved);
      const pdfData = await pdf(buffer);
      const extracted = extractInvoiceData(pdfData.text);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            extracted,
            page_count: pdfData.numpages,
            note: "Review the extracted data and raw_text. Use resolve_supplier to match or create the supplier, then suggest_booking to find similar past invoices.",
          }, null, 2),
        }],
      };
    }
  );

  server.tool("resolve_supplier",
    "Find or create a supplier in e-arveldaja. First searches by registry code, " +
    "then by name (fuzzy). If not found, optionally creates a new client. " +
    "Also looks up business registry (äriregister) data if available.",
    {
      name: z.string().optional().describe("Supplier name from invoice"),
      reg_code: z.string().optional().describe("Registry code (registrikood)"),
      vat_no: z.string().optional().describe("VAT number (KMKR)"),
      iban: z.string().optional().describe("Bank account (IBAN)"),
      auto_create: z.boolean().optional().describe("Create client if not found (default false)"),
      country: z.string().optional().describe("Country code for auto-create (default EST)"),
      is_physical_entity: z.boolean().optional().describe("Natural person (default false = legal entity)"),
    },
    async ({ name, reg_code, vat_no, iban, auto_create, country, is_physical_entity }) => {
      // 1. Search by registry code
      if (reg_code) {
        const byCode = await api.clients.findByCode(reg_code);
        if (byCode) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ found: true, match_type: "registry_code", client: byCode }, null, 2),
            }],
          };
        }
      }

      // 2. Search by name (fuzzy)
      if (name) {
        const allClients = await api.clients.listAll();
        const clientNames = allClients.filter(c => !c.is_deleted).map(c => c.name);

        if (clientNames.length > 0) {
          const bestMatch = closest(name, clientNames);
          const matchedClient = allClients.find(c => !c.is_deleted && c.name === bestMatch);

          // Check similarity - simple contains check
          if (matchedClient && (
            bestMatch.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(bestMatch.toLowerCase())
          )) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ found: true, match_type: "name_fuzzy", client: matchedClient }, null, 2),
              }],
            };
          }
        }
      }

      // 3. Try business registry lookup
      let registryData: Record<string, string> | null = null;
      if (reg_code && !/^\d{8}$/.test(reg_code)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: "Registry code must be exactly 8 digits" }, null, 2),
          }],
        };
      }
      if (reg_code) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const response = await fetch(
            `https://ariregister.rik.ee/est/api/autocomplete?q=${encodeURIComponent(reg_code)}`,
            { signal: controller.signal }
          );
          clearTimeout(timeout);
          if (response.ok) {
            const data = await response.json() as Array<Record<string, unknown>>;
            if (data.length > 0) {
              const entry = data[0];
              registryData = {
                name: String(entry.company_name ?? entry.nimi ?? name ?? ""),
                reg_code: reg_code,
                address: String(entry.address ?? entry.aadress ?? ""),
              };
            }
          }
        } catch {
          // Registry lookup failed, continue
        }
      }

      // 4. Create new client if requested
      if (auto_create) {
        const clientName = registryData?.name ?? name ?? "Unknown";
        const isPhysical = is_physical_entity ?? false;
        const result = await api.clients.create({
          name: clientName,
          code: reg_code ?? undefined,
          is_client: false,
          is_supplier: true,
          cl_code_country: country ?? "EST",
          is_juridical_entity: !isPhysical,
          is_physical_entity: isPhysical,
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          invoice_vat_no: vat_no ?? undefined,
          bank_account_no: iban ?? undefined,
          address_text: registryData?.address ?? undefined,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              found: false,
              created: true,
              api_response: result,
              registry_data: registryData,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            found: false,
            created: false,
            registry_data: registryData,
            suggestion: "Client not found. Set auto_create=true to create, or provide more details.",
          }, null, 2),
        }],
      };
    }
  );

  server.tool("suggest_booking",
    "Find similar past purchase invoices from the same supplier to suggest " +
    "how to book a new invoice (which accounts, articles, etc).",
    {
      clients_id: z.number().describe("Supplier client ID"),
      description: z.string().optional().describe("Invoice item description to match"),
      limit: z.number().optional().describe("Max past invoices to return (default 3)"),
    },
    async ({ clients_id, description, limit }) => {
      const maxResults = limit ?? 3;
      const allInvoices = await api.purchaseInvoices.listAll();

      // Filter by supplier
      let supplierInvoices = allInvoices
        .filter((inv: PurchaseInvoice) => inv.clients_id === clients_id && inv.status === "CONFIRMED")
        .sort((a: PurchaseInvoice, b: PurchaseInvoice) =>
          (b.create_date ?? "").localeCompare(a.create_date ?? "")
        );

      // Get detailed invoices with items
      const detailed = [];
      for (const inv of supplierInvoices.slice(0, maxResults + 5)) {
        const full = await api.purchaseInvoices.get(inv.id!);
        detailed.push({
          id: full.id,
          number: full.number,
          date: full.create_date,
          gross_price: full.gross_price,
          liability_accounts_id: full.liability_accounts_id,
          items: full.items?.map(item => ({
            custom_title: item.custom_title,
            cl_purchase_articles_id: item.cl_purchase_articles_id,
            total_net_price: item.total_net_price,
            vat_rate_dropdown: item.vat_rate_dropdown,
          })),
        });
      }

      // If description provided, prefer invoices with matching item descriptions
      if (description) {
        const descLower = description.toLowerCase();
        const withMatch = detailed.filter(inv =>
          inv.items?.some(item =>
            item.custom_title?.toLowerCase().includes(descLower)
          )
        );
        if (withMatch.length > 0) {
          const withMatchIds = new Set(withMatch.map(i => i.id));
          const rest = detailed.filter(i => !withMatchIds.has(i.id));
          detailed.length = 0;
          detailed.push(...withMatch, ...rest);
        }
      }

      // Trim to requested limit
      detailed.splice(maxResults);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            supplier_id: clients_id,
            past_invoices: detailed,
            suggestion: detailed.length > 0
              ? "Use the purchase article and account settings from the most recent similar invoice."
              : "No past invoices found for this supplier. Use list_purchase_articles to find appropriate articles.",
          }, null, 2),
        }],
      };
    }
  );

  server.tool("create_purchase_invoice_from_pdf",
    "Full workflow: create a purchase invoice from extracted PDF data. " +
    "Resolves supplier, suggests booking, creates the invoice as DRAFT.",
    {
      supplier_client_id: z.number().describe("Supplier client ID (from resolve_supplier)"),
      invoice_number: z.string().describe("Invoice number"),
      invoice_date: z.string().describe("Invoice date (YYYY-MM-DD)"),
      journal_date: z.string().describe("Turnover/booking date (YYYY-MM-DD)"),
      term_days: z.number().describe("Payment term days"),
      items: z.string().describe("JSON array of items: [{custom_title, cl_purchase_articles_id, total_net_price, vat_rate_dropdown?, amount?}]"),
      liability_accounts_id: z.number().optional().describe("Liability account (default 2310)"),
      notes: z.string().optional().describe("Notes (e.g. PDF filename)"),
      gross_price: z.number().optional().describe("Total gross price"),
      ref_number: z.string().optional().describe("Reference number"),
      bank_account_no: z.string().optional().describe("Supplier bank account"),
    },
    async (params) => {
      // Get supplier name
      const supplier = await api.clients.get(params.supplier_client_id);

      const invoiceData = {
        clients_id: params.supplier_client_id,
        client_name: supplier.name,
        number: params.invoice_number,
        create_date: params.invoice_date,
        journal_date: params.journal_date,
        term_days: params.term_days,
        cl_currencies_id: "EUR",
        liability_accounts_id: params.liability_accounts_id ?? 2310,
        gross_price: params.gross_price,
        bank_ref_number: params.ref_number,
        bank_account_no: params.bank_account_no,
        notes: params.notes,
        items: safeJsonParse(params.items, "items") as PurchaseInvoiceItem[],
      };

      const result = await api.purchaseInvoices.create(invoiceData);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result,
            note: "Purchase invoice created as DRAFT. Review and use confirm_purchase_invoice to confirm.",
            invoice_data: invoiceData,
          }, null, 2),
        }],
      };
    }
  );

  server.tool("upload_invoice_document",
    "Upload a PDF document to an existing purchase invoice",
    {
      invoice_id: z.number().describe("Purchase invoice ID"),
      file_path: z.string().describe("Absolute path to the PDF file"),
    },
    async ({ invoice_id, file_path }) => {
      const resolved = await validatePdfPath(file_path);
      const buffer = await readFile(resolved);
      const base64 = buffer.toString("base64");
      const fileName = resolved.split("/").pop() ?? "document.pdf";
      const result = await api.purchaseInvoices.uploadDocument(invoice_id, fileName, base64);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
