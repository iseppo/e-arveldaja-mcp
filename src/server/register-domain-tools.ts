import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CredentialSetupInfo, ToolExposureConfig } from "../config.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { ToolProfile } from "../tool-profile.js";
import { registerCrudTools } from "../tools/crud-tools.js";
import { registerAccountBalanceTools } from "../tools/account-balance.js";
import { registerPdfWorkflowTools } from "../tools/pdf-workflow.js";
import { registerDocumentAttachmentTools } from "../tools/document-attachments.js";
import { registerCurrencyRoundingTools } from "../tools/currency-rounding.js";
import { registerBankReconciliationTools } from "../tools/bank-reconciliation.js";
import { registerFinancialStatementTools } from "../tools/financial-statements.js";
import { registerAgingTools } from "../tools/aging-analysis.js";
import { registerRecurringInvoiceTools } from "../tools/recurring-invoices.js";
import { registerEstonianTaxTools } from "../tools/estonian-tax.js";
import { registerAnnualReportTools } from "../tools/annual-report.js";
import { registerDocumentAuditTools } from "../tools/document-audit.js";
import { registerOpeningBalanceTools } from "../tools/opening-balance-import.js";
import { registerReceiptInboxTools } from "../tools/receipt-inbox.js";
import { registerLightyearTools } from "../tools/lightyear-investments.js";
import { registerWiseImportTools } from "../tools/wise-import.js";
import { registerCamtImportTools } from "../tools/camt-import.js";
import { createElicitor } from "../elicitation.js";
import { createConnectionDefaultsStore, type ConnectionDefaultsStore } from "../connection-defaults-store.js";
import { registerProcessBankInputTool } from "../guided/process-bank-input.js";
import { registerProcessAccountingDocumentTool } from "../guided/process-accounting-document.js";
import { registerRunAccountingReportTool } from "../guided/run-accounting-report.js";
import { registerSearchAccountingRecordsTool } from "../guided/search-accounting-records.js";
import { registerInspectAccountingRecordTool } from "../guided/inspect-accounting-record.js";
import { registerManageSaleInvoiceTool } from "../guided/manage-sale-invoice.js";
import { registerAccountingInboxTools } from "../tools/accounting-inbox.js";
import { registerAnalyzeUnconfirmedTools } from "../tools/analyze-unconfirmed.js";
import { registerWorkflowRecommendationTools } from "../tools/workflow-recommendations.js";
import { registerPlanTools } from "../plan-tools.js";
import { registerOperationResultTools } from "../operation-result-page.js";
import { registerWorkflowPageTool } from "../workflow-page.js";
import { registerResources } from "../resources/static-resources.js";
import { registerDynamicResources } from "../resources/dynamic-resources.js";
import { registerAccountingKnowledgeResources } from "../resources/accounting-knowledge-resources.js";
import { registerPrompts } from "../prompts.js";

export interface RegisterDomainToolsContext {
  /** Public (profile/catalog-gated) server for tool registrations. */
  readonly publicServer: McpServer;
  /** Scoped/observed server for resource + prompt registrations. */
  readonly server: McpServer;
  readonly api: ApiContext;
  readonly toolExposure: ToolExposureConfig;
  readonly runtimeSafetyContext: RuntimeSafetyContext;
  readonly toolProfile: ToolProfile;
  readonly setupMode: boolean;
  readonly setupInfo: CredentialSetupInfo;
}

/**
 * Register the full domain-tool surface, resources, and prompts.
 *
 * The registration ORDER is a documented security boundary: every public tool
 * crosses the same profile/catalog boundary that delegates into the scoped
 * server. Moved verbatim from `createMcpServer` — only its file location changed.
 */
export function registerDomainTools(ctx: RegisterDomainToolsContext): void {
  const { publicServer, server, api, toolExposure, runtimeSafetyContext, toolProfile, setupMode, setupInfo } = ctx;

  // Every public tool registration crosses the same profile/catalog boundary;
  // that boundary delegates into the scoped server above.
  registerCrudTools(publicServer, api, toolExposure);
  registerAccountBalanceTools(publicServer, api);
  registerPdfWorkflowTools(publicServer, api);
  registerDocumentAttachmentTools(publicServer, api);
  registerCurrencyRoundingTools(publicServer, api);
  registerBankReconciliationTools(publicServer, api, runtimeSafetyContext, toolExposure);
  registerFinancialStatementTools(publicServer, api, toolExposure);
  registerAgingTools(publicServer, api, toolExposure);
  if (toolExposure.enableSales) registerRecurringInvoiceTools(publicServer, api);
  if (toolExposure.enableTaxTools) registerEstonianTaxTools(publicServer, api);
  if (toolExposure.enableAnnualReport) registerAnnualReportTools(publicServer, api);
  registerDocumentAuditTools(publicServer, api);
  registerOpeningBalanceTools(publicServer, api);
  registerReceiptInboxTools(publicServer, api, runtimeSafetyContext, toolExposure);
  if (toolExposure.enableLightyear) registerLightyearTools(publicServer, api, runtimeSafetyContext);
  registerWiseImportTools(publicServer, api, runtimeSafetyContext);
  registerCamtImportTools(publicServer, api, runtimeSafetyContext, toolExposure);
  // Guided-façade shared services: a capability-aware elicitor over the scoped
  // server, and the secure connection-defaults store that makes the persisted
  // saved-bank-default rung live. Both are inert until a client answers an
  // ambiguity form (elicitor) or a hint is persisted with explicit consent.
  const guidedElicitor = createElicitor(publicServer);
  const connectionDefaultsStore: ConnectionDefaultsStore = createConnectionDefaultsStore();
  registerProcessBankInputTool(publicServer, api, runtimeSafetyContext, {
    elicit: guidedElicitor,
    defaultsStore: connectionDefaultsStore,
  });
  registerProcessAccountingDocumentTool(publicServer, api, runtimeSafetyContext, {
    elicit: guidedElicitor,
  });
  registerRunAccountingReportTool(publicServer, api, toolExposure);
  registerSearchAccountingRecordsTool(publicServer, api, toolExposure);
  registerInspectAccountingRecordTool(publicServer, api, toolExposure);
  if (toolExposure.enableSales) registerManageSaleInvoiceTool(publicServer, api, runtimeSafetyContext);
  registerAccountingInboxTools(publicServer, api, runtimeSafetyContext, toolExposure);
  registerAnalyzeUnconfirmedTools(publicServer, api);
  registerWorkflowRecommendationTools(publicServer, toolExposure);
  registerPlanTools(publicServer, runtimeSafetyContext, { profile: toolProfile });
  registerOperationResultTools(publicServer, runtimeSafetyContext);
  // Registered unconditionally (mirrors the operation-result page tool); the
  // public registrar's profile gate keeps it in the `full` surface only for this
  // release. Paging non-plan workflow state carried between continuation calls.
  registerWorkflowPageTool(publicServer, runtimeSafetyContext);

  // Resources cross the scoped/observed server directly; the public registrar
  // intentionally owns only the exhaustive tool catalog.
  registerResources(server, api);
  registerDynamicResources(server, api);
  registerAccountingKnowledgeResources(server);

  // Register prompts
  registerPrompts(server, { setupInfo: setupMode ? setupInfo : undefined, toolExposure });
}
