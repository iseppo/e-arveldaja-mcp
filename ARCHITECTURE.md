# Architecture Diagram

```mermaid
graph TB
    subgraph Client["MCP Client"]
        Claude["Claude / AI Assistant"]
    end

    subgraph Server["MCP Server (Node.js + TypeScript)"]
        Entry["index.ts\nMCP entry point"]

        subgraph Tools["tools/ — 111 tools across 16 modules"]
            CRUD["crud-tools.ts\nBasic CRUD"]
            PDF["pdf-workflow.ts\nInvoice PDF"]
            OCR["receipt-extraction.ts\nReceipt OCR"]
            Bank["bank-reconciliation.ts\nTransaction matching"]
            CAMT["camt-import.ts\nISO 20022 parsing"]
            Fin["financial-statements.ts\nP&L, balance sheet"]
            Tax["estonian-tax.ts\nDividend / VAT"]
            Inv["lightyear-investments.ts\nTrade booking"]
            Inbox["accounting-inbox.ts\nFile scanner"]
        end

        subgraph Resources["resources/ — MCP read-only data"]
            Static["static-resources.ts\nChart of accounts, VAT"]
            Dynamic["dynamic-resources.ts\nCompany defaults"]
        end

        subgraph Core["Core Infrastructure"]
            Cache["cache.ts\nLRU 500, TTL 300s"]
            Auth["auth.ts\nHMAC-SHA-384 signing"]
            HTTP["http-client.ts\n~10 rps, 60s timeout"]
            Config["config.ts\nMulti-company credentials"]
            Audit["audit-log.ts\nlogs/*.audit.md"]
        end

        subgraph APIs["api/ — 7 resource clients"]
            Base["base-resource.ts\nGeneric CRUD + pagination"]
            Clients["clients.api.ts"]
            Products["products.api.ts"]
            Journals["journals.api.ts"]
            Transactions["transactions.api.ts"]
            PurchaseInv["purchase-invoices.api.ts"]
            SaleInv["sale-invoices.api.ts"]
            Readonly["readonly.api.ts"]
        end
    end

    subgraph External["External Services"]
        EArv["e-arveldaja API\nrmp-api.rik.ee/v1"]
        Registry["Estonian Business Registry\nariregister.rik.ee"]
        LiteParse["LiteParse OCR\nlocal server"]
    end

    subgraph Files["Local Files"]
        APIKey["apikey*.txt\nCredentials"]
        CSVs["Wise / Lightyear CSVs\nBank / trade exports"]
        PDFs["PDF / JPG / PNG\nReceipts & invoices"]
        AuditLog["logs/*.audit.md\nMutation history"]
    end

    Claude -->|MCP protocol| Entry
    Entry --> Tools
    Entry --> Resources

    Tools --> Core
    Resources --> Core

    CRUD & PDF & OCR & Bank & CAMT & Fin & Tax & Inv & Inbox --> APIs

    APIs --> Base
    Base --> Cache
    Cache --> Auth
    Auth --> HTTP

    HTTP -->|HTTPS| EArv
    OCR -->|HTTPS| LiteParse
    CRUD -->|lookup| Registry

    Config --> APIKey
    Bank & CAMT & Inv --> CSVs
    PDF & OCR --> PDFs
    Audit --> AuditLog
```

## Layer Summary

| Layer | Role |
|---|---|
| **Tools** | Domain logic — invoices, bank, tax, OCR, reporting |
| **API clients** | Resource-specific REST wrappers (CRUD + pagination) |
| **Cache** | In-memory LRU, auto-invalidated on mutations |
| **Auth** | Signs every request with HMAC-SHA-384 |
| **HTTP client** | Rate-limited, timeout-guarded outbound calls |
| **Config** | Multi-company credential loading & switching |
| **Audit log** | Append-only markdown log of all mutations |
