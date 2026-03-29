import { describe, expect, it, vi } from "vitest";
import { registerCamtImportTools } from "./camt-import.js";
import { registerLightyearTools } from "./lightyear-investments.js";
import { registerPdfWorkflowTools } from "./pdf-workflow.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { registerWiseImportTools } from "./wise-import.js";

function getToolConfig(
  register: (server: any, api: any) => void,
  toolName: string,
) {
  const server = { registerTool: vi.fn() } as any;
  register(server, {} as any);
  const registration = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!registration) throw new Error(`Missing tool registration for ${toolName}`);
  return registration[1] as { annotations?: { openWorldHint?: boolean } };
}

describe("file input tool metadata", () => {
  it("marks file and folder based tools as open-world", () => {
    const toolConfigs = [
      getToolConfig(registerPdfWorkflowTools, "extract_pdf_invoice"),
      getToolConfig(registerPdfWorkflowTools, "create_purchase_invoice_from_pdf"),
      getToolConfig(registerPdfWorkflowTools, "upload_invoice_document"),
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
});
