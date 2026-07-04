import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAccountingInboxTools } from "./accounting-inbox.js";
import { registerCamtImportTools } from "./camt-import.js";
import { registerDocumentAttachmentTools } from "./document-attachments.js";
import { registerLightyearTools } from "./lightyear-investments.js";
import { registerPdfWorkflowTools } from "./pdf-workflow.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { registerWiseImportTools } from "./wise-import.js";

function getToolConfig(
  register: (server: any, api: any, exposure?: { enableLightyear: boolean; exposeGranularTools: boolean }) => void,
  toolName: string,
) {
  const server = { registerTool: vi.fn() } as any;
  // Metadata assertions cover the granular constituent tools too, so register
  // with the full surface exposed (default hides them behind the merged tools).
  register(server, {} as any, { enableLightyear: true, exposeGranularTools: true });
  const registration = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!registration) throw new Error(`Missing tool registration for ${toolName}`);
  return registration[1] as { description?: string; inputSchema?: Record<string, unknown>; annotations?: { openWorldHint?: boolean } };
}

function toolMetadataText(config: { description?: string; inputSchema?: Record<string, unknown> }): string {
  const schema = config.inputSchema ? z.object(config.inputSchema as z.ZodRawShape).toJSONSchema() : {};
  return `${config.description ?? ""}\n${JSON.stringify(schema)}`;
}

describe("file input tool metadata", () => {
  it("marks file and folder based tools as open-world", () => {
    const toolConfigs = [
      getToolConfig(registerAccountingInboxTools, "accounting_inbox"),
      getToolConfig(registerPdfWorkflowTools, "extract_pdf_invoice"),
      getToolConfig(registerPdfWorkflowTools, "create_purchase_invoice_from_pdf"),
      getToolConfig(registerDocumentAttachmentTools, "attach_document"),
      getToolConfig(registerLightyearTools, "parse_lightyear_statement"),
      getToolConfig(registerLightyearTools, "book_lightyear_trades"),
      getToolConfig(registerLightyearTools, "book_lightyear_distributions"),
      getToolConfig(registerLightyearTools, "lightyear_portfolio_summary"),
      getToolConfig(registerWiseImportTools, "import_wise_transactions"),
      getToolConfig(registerReceiptInboxTools, "scan_receipt_folder"),
      getToolConfig(registerReceiptInboxTools, "process_receipt_batch"),
      getToolConfig(registerCamtImportTools, "parse_camt053"),
      getToolConfig(registerCamtImportTools, "import_camt053"),
    ];

    for (const config of toolConfigs) {
      expect(config.annotations?.openWorldHint).toBe(true);
    }
  });

  it("exposes the entity-agnostic document tools and drops the old upload_invoice_document", () => {
    const collectNames = (register: (server: any, api: any) => void): string[] => {
      const names: string[] = [];
      register({ registerTool: vi.fn((name: string) => { names.push(name); }) } as any, {} as any);
      return names;
    };

    const docNames = collectNames(registerDocumentAttachmentTools);
    expect(docNames).toEqual(expect.arrayContaining(["attach_document", "get_document", "delete_document"]));

    // The purchase-only predecessor must be gone (subsumed by attach_document).
    expect(collectNames(registerPdfWorkflowTools)).not.toContain("upload_invoice_document");
  });

  it("keeps file-input workflow metadata free of relocatable implementation notes", () => {
    const receiptBatch = toolMetadataText(getToolConfig(registerReceiptInboxTools, "process_receipt_batch"));
    expect(receiptBatch).toContain("DRY RUN by default");
    expect(receiptBatch).toContain("explicit approval");
    expect(receiptBatch).not.toContain("#19");
    expect(receiptBatch).not.toContain("#20");
    expect(receiptBatch).not.toContain("Legacy execute=true");

    const autoRule = toolMetadataText(getToolConfig(registerAccountingInboxTools, "save_auto_booking_rule"));
    expect(autoRule).toContain("confirmed and approved");
    expect(autoRule).not.toContain("Open Knowledge Format bundle");
  });
});
