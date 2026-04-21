import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { validateFilePath } from "../file-validation.js";
import {
  classifyReceiptDocument,
  categorizeTransactionGroup,
  detectReceiptCurrency,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  extractAmounts,
  extractDates,
  extractInvoiceNumber,
  extractPdfIdentifiers,
  extractSupplierName,
  getAutoBookedVatConfig,
  getAutoBookedVatRateDropdown,
  getClientCountryFromIban,
  hasAutoBookableReceiptFields,
  hasRecurringSimilarAmounts,
  inferSupplierCountry,
  looksLikePersonCounterparty,
  normalizeDate,
  normalizeCounterpartyName,
  scoreTransactionToInvoice,
  suggestBookingInternal,
} from "./receipt-extraction.js";
import {
  buildDryRunCreatedInvoicePreview,
  readValidatedReceiptFile,
  revalidateReceiptFilePath,
} from "./receipt-inbox.js";

vi.mock("../file-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../file-validation.js")>()),
  validateFilePath: vi.fn(),
}));

vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  readFile: vi.fn(),
}));

const mockedValidateFilePath = vi.mocked(validateFilePath);
const mockedReadFile = vi.mocked(readFile);

function makeTx(overrides: Partial<{
  type: string;
  amount: number;
  description: string;
  date: string;
  bank_subtype: string;
}> = {}) {
  return {
    type: "C",
    amount: 10,
    description: "",
    date: "2026-03-01",
    bank_subtype: "",
    ...overrides,
  };
}

describe("normalizeCounterpartyName", () => {
  it("removes common company suffixes and punctuation", () => {
    expect(normalizeCounterpartyName("AS LHV Pank")).toBe("lhv");
    expect(normalizeCounterpartyName("OÜ OpenAI, Inc.")).toBe("openai");
  });
});

describe("buildDryRunCreatedInvoicePreview", () => {
  it("marks process_receipt_batch previews as not yet uploaded or confirmed", () => {
    expect(buildDryRunCreatedInvoicePreview("INV-42")).toEqual({
      number: "INV-42",
      status: "would_create",
      confirmed: false,
      uploaded_document: false,
    });
  });
});

describe("receipt file revalidation", () => {
  it("revalidates the scanned path before re-reading the file", async () => {
    mockedValidateFilePath.mockResolvedValueOnce("/tmp/revalidated.pdf");

    await expect(revalidateReceiptFilePath({
      name: "receipt.pdf",
      path: "/tmp/original.pdf",
      extension: ".pdf",
      file_type: "pdf",
      size_bytes: 123,
      modified_at: "2026-03-01T00:00:00.000Z",
    })).resolves.toBe("/tmp/revalidated.pdf");

    expect(mockedValidateFilePath).toHaveBeenCalledWith("/tmp/original.pdf", [".pdf"], 50 * 1024 * 1024);
  });

  it("reads the revalidated path instead of the originally scanned path", async () => {
    mockedValidateFilePath.mockResolvedValueOnce("/tmp/revalidated.pdf");
    mockedReadFile.mockResolvedValueOnce(Buffer.from("pdf"));

    await expect(readValidatedReceiptFile({
      name: "receipt.pdf",
      path: "/tmp/original.pdf",
      extension: ".pdf",
      file_type: "pdf",
      size_bytes: 123,
      modified_at: "2026-03-01T00:00:00.000Z",
    })).resolves.toEqual(Buffer.from("pdf"));

    expect(mockedValidateFilePath).toHaveBeenCalledWith("/tmp/original.pdf", [".pdf"], 50 * 1024 * 1024);
    expect(mockedReadFile).toHaveBeenCalledWith("/tmp/revalidated.pdf");
    expect(mockedReadFile).not.toHaveBeenCalledWith("/tmp/original.pdf");
  });
});

describe("hasRecurringSimilarAmounts", () => {
  it("detects similar recurring amounts", () => {
    expect(hasRecurringSimilarAmounts([19.99, 20.49, 20.01])).toBe(true);
  });

  it("rejects widely different amounts", () => {
    expect(hasRecurringSimilarAmounts([10, 20])).toBe(false);
  });
});

describe("extractAmounts", () => {
  it("ignores registry and reference numbers when falling back to the gross amount", () => {
    const result = extractAmounts([
      "Reg nr 737350",
      "Viitenumber 123456",
      "KMKR EE123456789",
      "24,40 EUR",
    ].join("\n"));

    expect(result.total_gross).toBe(24.4);
  });

  it("prefers the gross amount on VAT-inclusive total lines", () => {
    const result = extractAmounts("Kokku €22.87 (sisaldab €4.12 käibemaksu)");

    expect(result).toMatchObject({
      total_net: 18.75,
      total_vat: 4.12,
      total_gross: 22.87,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("treats component sums without VAT lines as zero-vat totals", () => {
    const result = extractAmounts([
      "Vahesumma €12.95",
      "Transport €2.69",
      "Kokku €15.64",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 15.64,
      total_vat: 0,
      total_gross: 15.64,
    });
    expect(result.vat_explicit).toBe(false);
  });

  it("recomputes net amounts when OCR subtotal and gross collapse onto the same value", () => {
    const result = extractAmounts([
      "Subtotal €21.96",
      "Tax 1 €3.96 €3.96",
      "Total €21.96",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 18,
      total_vat: 3.96,
      total_gross: 21.96,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("does not treat käibemaksuta lines as VAT amounts", () => {
    const result = extractAmounts([
      "Käibemaksuta: 10,47 €",
      "Käibemaks 5%: 0,52 €",
      "Summa kokku 10,99 €",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 10.47,
      total_vat: 0.52,
      total_gross: 10.99,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("does not treat price lines with embedded KM percentages as VAT rows", () => {
    const result = extractAmounts([
      "Pileti(te) hind (KM 22%): 15,25 EUR",
      "KM (22%): 3,35 EUR",
      "Kokku 18,60 EUR",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 15.25,
      total_vat: 3.35,
      total_gross: 18.6,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("extracts KM-ta and KM-ga summary rows used by IKEA-style invoices", () => {
    const result = extractAmounts([
      "Summa eurodes (KM-ta) 151,41",
      "Summa eurodes (KM-ga) 181,69",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 151.41,
      total_vat: 30.28,
      total_gross: 181.69,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("ignores years and ZIP codes as fallback gross amounts", () => {
    const result = extractAmounts([
      "Kuupäev 25. nov 2024",
      "Tallinn, Estonia",
      "51005",
      "Makstud summa € 47",
    ].join("\n"));

    expect(result.total_gross).toBe(47);
  });

  it("prefers VAT-inclusive grand totals over earlier net-only total rows", () => {
    const result = extractAmounts([
      "Invoice no. 8579478-FI1123-335",
      "Vattuniemenranta 4 B 13 00210 Helsinki",
      "Title Sum (EUR) VAT 10% Total sum (EUR)",
      "Trip Fee 13.73 1.37 15.10",
      "Total (EUR): 13.73",
      "VAT 10%: 1.37",
      "Total including VAT (EUR): 15.10",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 13.73,
      total_vat: 1.37,
      total_gross: 15.1,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("does not treat years on paid-amount lines as the gross total", () => {
    const result = extractAmounts("Kuupäeval 25. nov 2024 makstud summa € 47");

    expect(result.total_gross).toBe(47);
  });

  it("detects VAT from split OCR lines that continue onto the next line", () => {
    const result = extractAmounts([
      "Vahesumma   €19.98",
      "Transport   €2.89 Omniva",
      "Kokku  €22.87 (sisaldab €4.12",
      "käibemaksu)",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 18.75,
      total_vat: 4.12,
      total_gross: 22.87,
    });
    expect(result.vat_explicit).toBe(true);
  });
});

describe("detectReceiptCurrency", () => {
  it("detects non-euro currencies from receipt text", () => {
    expect(detectReceiptCurrency("Amount due 12.50 USD")).toBe("USD");
  });

  it("defaults to EUR when no currency marker is present", () => {
    expect(detectReceiptCurrency("Kokku 24,40")).toBe("EUR");
  });
});

describe("extractPdfIdentifiers", () => {
  it("extracts alphanumeric IBAN values from receipt text", () => {
    const result = extractPdfIdentifiers("Supplier IBAN: IE29AIBK93115212345678");

    expect(result.supplier_iban).toBe("IE29AIBK93115212345678");
  });

  it("extracts foreign VAT numbers and normalizes spaced IBAN values", () => {
    const result = extractPdfIdentifiers("KM-number: IE3668997OH\nIBAN: EE47 1000 0010 2014 5685");

    expect(result.supplier_vat_no).toBe("IE3668997OH");
    expect(result.supplier_iban).toBe("EE471000001020145685");
  });

  it("does not misclassify VAT numbers as IBANs", () => {
    const result = extractPdfIdentifiers("KMKR: EE100576146 Narva mnt 13");

    expect(result.supplier_vat_no).toBe("EE100576146");
    expect(result.supplier_iban).toBeUndefined();
  });

  it("prefers supplier tax id before a bill-to section", () => {
    const result = extractPdfIdentifiers([
      "Fraqmented OÜ",
      "Tax ID: EE102814482",
      "Bill to",
      "Seppo AI OÜ",
      "Tax ID: EE102809963",
    ].join("\n"));

    expect(result.supplier_vat_no).toBe("EE102814482");
  });
});

describe("normalizeDate", () => {
  it("supports two-digit dotted dates and English month names", () => {
    expect(normalizeDate("28.02.26")).toBe("2026-02-28");
    expect(normalizeDate("16 March 2026")).toBe("2026-03-16");
    expect(normalizeDate("February 20, 2026")).toBe("2026-02-20");
    expect(normalizeDate("May 23,2024")).toBe("2024-05-23");
    expect(normalizeDate("21/05/2024")).toBe("2024-05-21");
  });

  it("supports Estonian textual month names and weekday prefixes", () => {
    expect(normalizeDate("pühapäev, 23. juuni 2024")).toBe("2024-06-23");
  });
});

describe("extractInvoiceNumber", () => {
  it("extracts bare invoice labels from LiteParse text", () => {
    expect(extractInvoiceNumber("Invoice 171\nIssue Date: 16 March 2026", "fraqmented.pdf")).toBe("171");
    expect(extractInvoiceNumber("Arve-saateleht nr.: 391929", "invoice.pdf")).toBe("391929");
  });

  it("does not treat section labels as invoice numbers", () => {
    expect(extractInvoiceNumber("Arve Saatja nimi\nArve/Tehingu nr UPMPCA26F6IB", "delfi.pdf")).toBe("UPMPCA26F6IB");
    expect(extractInvoiceNumber("Arve aadress:\nTellimuse number: E-H9J241K2", "ikea.pdf")).toBe("E-H9J241K2");
  });

  it("does not confuse registry-code labels with invoice numbers", () => {
    expect(extractInvoiceNumber([
      "Arve Saatja nimi Deli Meedia AS",
      "Reg nr 10586863, KMKR EE100576146",
      "Arve/Tehingu nr UPMPCA26F6IB",
    ].join("\n"), "delfi.pdf")).toBe("UPMPCA26F6IB");
  });
});

describe("extractDates", () => {
  it("extracts textual issue and due dates from LiteParse text", () => {
    expect(extractDates("Date of issue February 20, 2026\nDate due February 20, 2026")).toEqual({
      invoice_date: "2026-02-20",
      due_date: "2026-02-20",
    });
    expect(extractDates("Issue Date: 16 March 2026")).toEqual({
      invoice_date: "2026-03-16",
      due_date: undefined,
    });
  });

  it("extracts Estonian textual invoice dates from transaction-style invoices", () => {
    expect(extractDates("Arve kpv pühapäev, 23. juuni 2024")).toEqual({
      invoice_date: "2024-06-23",
      due_date: undefined,
    });
  });

  it("extracts slash-separated order dates", () => {
    expect(extractDates("Tellimuse kuupäev 21/05/2024")).toEqual({
      invoice_date: "2024-05-21",
      due_date: undefined,
    });
  });
});

describe("extractSupplierName", () => {
  it("strips sender labels and buyer blocks from supplier names", () => {
    expect(extractSupplierName("Saatja nimi Deli Meedia AS", "delfi.pdf")).toBe("Deli Meedia AS");
    expect(extractSupplierName("Anthropic Bill to", "anthropic.pdf")).toBe("Anthropic");
  });

  it("extracts labelled supplier lines from ticket-like documents", () => {
    expect(
      extractSupplierName("Vedaja/Teenuse pakkuja: Lux Express Estonia AS; Lastekodu 46, Tallinn", "ticket.pdf"),
    ).toBe("Lux Express Estonia AS");
  });

  it("does not treat buyer lines as supplier names", () => {
    expect(
      extractSupplierName("DIGITALL OÜ\nSeppo OÜ Vastuvõtja: Arve number: 202404068", "digitall.pdf"),
    ).toBe("DIGITALL OÜ");
  });

  it("extracts the seller from split Ostja/Müüja name rows", () => {
    expect(
      extractSupplierName("Ostja Müüja\nNimi: Csik Timea Nimi: Runikon Retail OU", "ikea.pdf"),
    ).toBe("Runikon Retail OU");
  });

  it("extracts the rightmost seller column after recipient rows", () => {
    expect(
      extractSupplierName("Recipient:\nIndrek                 bilaal tmi", "bolt.pdf"),
    ).toBe("bilaal tmi");
  });

  it("does not switch to the buyer column on mixed supplier/Bill to rows", () => {
    expect(
      extractSupplierName([
        "Midjourney Inc                          Bill to",
        "611 Gateway Blvd                        Indrek Seppo",
      ].join("\n"), "midjourney.pdf"),
    ).toBe("Midjourney Inc");
  });
});

describe("classifyReceiptDocument", () => {
  it("keeps sales invoices out of the purchase invoice flow", () => {
    expect(classifyReceiptDocument("MÜÜGIARVE 2024_20\nKlient: Fopaa OÜ", "sale.pdf")).toBe("unclassifiable");
  });

  it("classifies travel tickets and order confirmations as reimbursement-style receipts", () => {
    expect(classifyReceiptDocument("Pileti nr 241028846820\nLux Express Estonia AS", "ticket.pdf")).toBe("owner_paid_expense_reimbursement");
    expect(classifyReceiptDocument("Order details\nPayment method: Pay with bank", "beep.png")).toBe("owner_paid_expense_reimbursement");
  });

  it("classifies non-invoice confirmations as reimbursement-style review items", () => {
    expect(classifyReceiptDocument("See on sinu tehingu kinnitus\nPalun pane tähele, et see ei ole arve", "booking.pdf")).toBe("owner_paid_expense_reimbursement");
    expect(classifyReceiptDocument("Sinu tellimuse kokkuvõte\nTellimuse number: E-H9J241K2", "ikea.pdf")).toBe("owner_paid_expense_reimbursement");
  });

  it("classifies taxi card-terminal receipts as reimbursement-style review items", () => {
    expect(classifyReceiptDocument("Arve nr TG43882106\nMaksemeetod Kaarditerminal\nForus Taxi", "forus.pdf")).toBe("owner_paid_expense_reimbursement");
  });
});

describe("hasAutoBookableReceiptFields", () => {
  it("requires a confident supplier invoice number for auto-booking", () => {
    expect(hasAutoBookableReceiptFields({
      supplier_name: "Runikon Retail OU",
      invoice_number: "AUTO-20260320-E-9411L9KU",
      invoice_date: "2021-03-12",
      total_gross: 181.69,
    })).toBe(false);

    expect(hasAutoBookableReceiptFields({
      supplier_name: "Runikon Retail OU",
      invoice_number: "POS-23-081972",
      invoice_date: "2023-06-30",
      total_gross: 624.86,
    })).toBe(true);
  });
});

describe("inferSupplierCountry", () => {
  it("prefers supplier-side country text when no IBAN is present", () => {
    expect(inferSupplierCountry({
      supplier_vat_no: "EU372045196",
      raw_text: [
        "Midjourney Inc                          Bill to",
        "611 Gateway Blvd                        Seppo OÜ",
        "United States                           Estonia",
      ].join("\n"),
    })).toBe("USA");
  });

  it("uses VAT prefixes for foreign suppliers when available", () => {
    expect(inferSupplierCountry({
      supplier_vat_no: "FI32738114",
      raw_text: "",
    })).toBe("FIN");
  });
});

describe("getClientCountryFromIban", () => {
  it("maps foreign IBAN prefixes to e-arveldaja country codes", () => {
    expect(getClientCountryFromIban("IE29AIBK93115212345678")).toBe("IRL");
    expect(getClientCountryFromIban("EE471000001020145685")).toBe("EST");
  });
});

describe("looksLikePersonCounterparty", () => {
  it("rejects company-like names and all-caps legal suffixes", () => {
    expect(
      looksLikePersonCounterparty(normalizeCounterpartyName("OpenAI Ireland Limited"), "OpenAI Ireland Limited"),
    ).toBe(false);
    expect(
      looksLikePersonCounterparty(normalizeCounterpartyName("TELIA EESTI AS"), "TELIA EESTI AS"),
    ).toBe(false);
  });

  it("accepts normal person-style names", () => {
    expect(looksLikePersonCounterparty(normalizeCounterpartyName("John Doe"), "John Doe")).toBe(true);
  });
});

describe("getAutoBookedVatConfig", () => {
  it("defaults unmatched auto-bookings to no VAT assumptions", () => {
    expect(getAutoBookedVatConfig("saas_subscriptions", "IRL")).toEqual({
      vat_rate_dropdown: "-",
    });
  });
});

describe("getAutoBookedVatRateDropdown", () => {
  it("keeps conservative no-VAT defaults for unmatched heuristics", () => {
    expect(getAutoBookedVatRateDropdown("card_purchases", "EST")).toBe("-");
    expect(getAutoBookedVatRateDropdown("saas_subscriptions", "IRL")).toBe("-");
    expect(getAutoBookedVatRateDropdown("bank_fees", "EST")).toBe("-");
  });
});

describe("deriveAutoBookedNetAmount", () => {
  it("keeps unmatched card purchases at gross until a real VAT treatment is known", () => {
    const vatConfig = getAutoBookedVatConfig("card_purchases", "EST");

    expect(deriveAutoBookedNetAmount(100, vatConfig)).toBe(100);
    expect(deriveAutoBookedVatPrice(100, vatConfig)).toBe(0);
  });

  it("keeps reverse-charge SaaS purchases at their supplier gross amount", () => {
    const vatConfig = getAutoBookedVatConfig("saas_subscriptions", "IRL");

    expect(deriveAutoBookedNetAmount(100, vatConfig)).toBe(100);
    expect(deriveAutoBookedVatPrice(100, vatConfig)).toBe(0);
  });
});

describe("scoreTransactionToInvoice", () => {
  it("does not compare nominal amounts across different currencies without a base amount", () => {
    const { confidence, reasons } = scoreTransactionToInvoice({
      id: 1,
      accounts_dimensions_id: 1,
      type: "C",
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2024-10-01",
    }, {
      gross_price: 10,
      cl_currencies_id: "USD",
      create_date: "2024-10-01",
    });

    expect(confidence).toBe(20);
    expect(reasons).toEqual(["date_within_3_days"]);
  });

  it("uses base amounts for foreign-currency invoice matching when available", () => {
    const { confidence, reasons } = scoreTransactionToInvoice({
      id: 1,
      accounts_dimensions_id: 1,
      type: "C",
      amount: 9.23,
      base_amount: 10.81,
      cl_currencies_id: "EUR",
      date: "2024-10-01",
    }, {
      gross_price: 10,
      base_gross_price: 10.81,
      cl_currencies_id: "USD",
      create_date: "2024-10-01",
    });

    expect(confidence).toBe(70);
    expect(reasons).toEqual(["exact_base_amount", "date_within_3_days"]);
  });
});

describe("suggestBookingInternal", () => {
  it("preserves reverse-charge metadata from supplier history", async () => {
    const api = {
      purchaseInvoices: {
        get: async () => ({
          id: 1,
          number: "PI-1",
          items: [{
            custom_title: "AI subscription",
            cl_purchase_articles_id: 45,
            purchase_accounts_id: 5230,
            purchase_accounts_dimensions_id: null,
            vat_rate_dropdown: "24",
            vat_accounts_id: 1510,
            cl_vat_articles_id: 1,
            reversed_vat_id: 1,
          }],
        }),
      },
    } as any;

    const context = {
      purchaseInvoices: [{
        id: 1,
        clients_id: 7,
        status: "CONFIRMED",
        create_date: "2026-02-15",
      }],
      purchaseArticlesWithVat: [{
        id: 45,
        name_est: "Software",
        name_eng: "Software",
        accounts_id: 5230,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "",
        account_type_eng: "",
      }],
    } as any;

    const result = await suggestBookingInternal(api, context, 7, "subscription");

    expect(result?.item.reversed_vat_id).toBe(1);
  });
});

describe("categorizeTransactionGroup", () => {
  it("classifies tax authority payments", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "emta",
      transactions: [makeTx({ description: "TAX PAYMENT" })],
    });

    expect(result.category).toBe("tax_payments");
    expect(result.apply_mode).toBe("review_only");
  });

  it("classifies bank fees", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "lhv",
      transactions: [makeTx({ amount: 5.5, description: "Monthly fee" })],
    });

    expect(result.category).toBe("bank_fees");
    expect(result.apply_mode).toBe("purchase_invoice");
  });

  it("does not classify incoming bank credits as bank fees", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "lhv",
      transactions: [makeTx({ type: "D", amount: 5.5, description: "Monthly fee refund" })],
    });

    expect(result.category).toBe("revenue_without_invoice");
  });

  it("classifies recurring non-person counterparties as subscriptions", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "openai ireland limited",
      transactions: [
        makeTx({ amount: 20, description: "ChatGPT subscription" }),
        makeTx({ amount: 20.4, description: "ChatGPT subscription", date: "2026-04-01" }),
      ],
    });

    expect(result.category).toBe("saas_subscriptions");
    expect(result.recurring).toBe(true);
    expect(result.similar_amounts).toBe(true);
  });

  it("classifies known owner counterparties separately", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "john doe",
      owner_counterparties: new Set(["john doe"]),
      transactions: [makeTx({ amount: 300 })],
    });

    expect(result.category).toBe("owner_transfers");
  });

  it("classifies incoming EMTA transactions before the generic revenue fallback", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "emta",
      display_counterparty: "EMTA",
      transactions: [makeTx({ type: "D", amount: 300 })],
    });

    expect(result.category).toBe("tax_payments");
  });

  it("classifies incoming owner transfers before the generic revenue fallback", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "john doe",
      display_counterparty: "John Doe",
      owner_counterparties: new Set(["john doe"]),
      transactions: [makeTx({ type: "D", amount: 300 })],
    });

    expect(result.category).toBe("owner_transfers");
  });

  it("classifies incoming unmatched payments as revenue without invoice", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "customer payment",
      transactions: [makeTx({ type: "D", amount: 1500 })],
    });

    expect(result.category).toBe("revenue_without_invoice");
  });

  it("classifies bolt and similar card purchases", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "bolt",
      transactions: [makeTx({ description: "Card purchase", bank_subtype: "card" })],
    });

    expect(result.category).toBe("card_purchases");
    expect(result.apply_mode).toBe("purchase_invoice");
  });
});
