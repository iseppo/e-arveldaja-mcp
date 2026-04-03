import type { InvoiceExtractionFallback } from "./invoice-extraction-fallback.js";
import type {
  ExtractedReceiptFields,
  ReceiptClassification,
  TransactionClassificationCategory,
} from "./tools/receipt-extraction.js";

export interface ReviewGuidance {
  recommendation: string;
  compliance_basis: string[];
  follow_up_questions: string[];
  policy_hint?: string;
}

const BASIS_RPS_DOCUMENT = "RPS § 6–7: iga kirjend peab põhinema algdokumendil ning tehing tuleb dokumenteerida ja kirjendada selle tegeliku sisu järgi.";
const BASIS_RPS_SUBSTANCE = "RPS § 4: lähtuda tuleb tehingu majanduslikust sisust ja olla konservatiivne, kui tõendav alus või käsitlus ei ole veel piisavalt selge.";
const BASIS_RPS_MATCHING = "RPS § 4: tulud ja kulud tuleb kajastada nende tegeliku majandusliku sisu ning õige perioodi järgi.";
const BASIS_KMS_DEDUCTION = "KMS § 29 lg 1 ja 4: sisendkäibemaksu tohib maha arvata ainult maksustatava ettevõtluse tarbeks kasutatud osas.";
const BASIS_KMS_RESTRICTIONS = "KMS § 30: külaliste vastuvõtu ning oma töötajate toitlustuse või majutuse sisendkäibemaks ei ole üldjuhul mahaarvatav, välja arvatud töölähetuse majutus.";
const BASIS_KMS_INVOICE = "KMS § 31 ja § 37: Eesti tarnija sisendkäibemaksu mahaarvamine eeldab üldjuhul nõuetele vastavat arvet; ilma piisava alusdokumendita ei tohiks käibemaksu maha arvata.";
const BASIS_KMS_FOREIGN_SERVICE = "KMS § 29 lg 3 p 3, § 31 lg 3 ja § 10: välisriigi ettevõtjalt saadud teenus võib Eestis pöördmaksustamise alla minna, kuid mahaarvamine sõltub endiselt ettevõtluskasutusest ja tõenditest.";
const BASIS_KMS_PARTIAL = "KMS § 32 ja EMTA sõiduauto juhis: segakasutuse või maksuvaba käibe korral võib maha arvata ainult ettevõtluse maksustatava osa; sõiduauto kulude puhul kehtib üldjuhul 50% piirang.";

function normalizedText(...parts: Array<string | undefined | null>): string {
  return parts
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .toLowerCase();
}

function hasAnyKeyword(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

function formatMissingField(field: string): string {
  switch (field) {
    case "supplier_name":
      return "müüja nimi";
    case "invoice_number":
      return "arve number";
    case "invoice_date":
      return "arve kuupäev";
    case "total_gross":
      return "brutosumma";
    case "total_vat":
      return "käibemaksusumma";
    case "total_net":
      return "netosumma";
    case "supplier_reg_code":
      return "registrikood";
    case "supplier_vat_no":
      return "KMKR number";
    case "supplier_iban":
      return "IBAN";
    case "ref_number":
      return "viitenumber";
    case "due_date":
      return "maksetähtaeg";
    default:
      return field.replaceAll("_", " ");
  }
}

function buildMissingFieldQuestions(missingFields: string[]): string[] {
  const questions: string[] = [];
  if (missingFields.includes("supplier_name")) {
    questions.push("Kes on dokumendil müüja täpse nimega ja kas registrikood või KMKR number on dokumendilt loetav?");
  }
  if (missingFields.includes("invoice_number") || missingFields.includes("invoice_date")) {
    questions.push("Mis on dokumendi arve number ja arve kuupäev täpselt nii, nagu need algdokumendil kirjas on?");
  }
  if (missingFields.includes("total_gross") || missingFields.includes("total_net") || missingFields.includes("total_vat")) {
    questions.push("Mis on dokumendi netosumma, käibemaksusumma ja brutosumma ning kas need liituvad omavahel korrektselt?");
  }
  return dedupe(questions);
}

export function buildOwnerExpenseVatReviewGuidance(params: {
  description: string;
  accountName?: string;
}): ReviewGuidance {
  const text = normalizedText(params.accountName, params.description);

  if (hasAnyKeyword(text, /\b(sõiduauto|auto|vehicle|fuel|kütus|parking|parkim|liising|leasing)\b/u)) {
    return {
      recommendation: "Soovitus: ära eelda täismahaarvamist. Kui tegu on tavalise M1 sõiduauto või selle kuluga ja erasõidud ei ole välistatud, kasuta konservatiivse vaikimisi lahendusena osalist mahaarvamist ning alusta 50% piirangust.",
      compliance_basis: [
        BASIS_KMS_DEDUCTION,
        BASIS_KMS_PARTIAL,
      ],
      follow_up_questions: [
        "Kas kulu on seotud M1-kategooria sõiduauto või selle kasutamisega?",
        "Kas sõidukit kasutatakse eranditult ettevõtluses ja kas erasõidud on tegelikult välistatud?",
        "Kas ettevõttel on ka maksuvaba käive või muud mitte-ettevõtluslikku kasutust, mis vähendaks mahaarvatavat osa veelgi?",
      ],
      policy_hint: "Kui sama sõiduauto või kululiigi poliitika kordub, salvesta see accounting-rules.md faili owner_expense_reimbursement jaotisesse, et edaspidi küsitaks vähem.",
    };
  }

  if (hasAnyKeyword(text, /\b(representation|esindus|entertainment|restaurant|restoran|cafe|kohvik|food|toitlust|majutus|accommodation)\b/u)) {
    return {
      recommendation: "Soovitus: käsitle sisendkäibemaks vaikimisi mitte-mahaarvatavana, välja arvatud juhul, kui tegemist on töötaja tõendatud töölähetuse majutusega või muu selgelt mahaarvatava erandiga.",
      compliance_basis: [
        BASIS_KMS_DEDUCTION,
        BASIS_KMS_RESTRICTIONS,
        BASIS_KMS_INVOICE,
      ],
      follow_up_questions: [
        "Kas kulu on külaliste vastuvõtt, oma töötaja toitlustus/majutus või töötaja töölähetuse majutus?",
        "Kui tegemist oli töölähetusega, kas selle kohta on olemas lähetuse alus ja kulu seos ettevõtlusega on tõendatav?",
      ],
      policy_hint: "Kui sama tüüpi kulude käsitlus on ettevõttes püsiv, salvesta see accounting-rules.md faili owner_expense_reimbursement jaotisesse.",
    };
  }

  return {
    recommendation: "Soovitus: kui kulu on üksnes ettevõtluse jaoks ning alusdokument on olemas, käsitle sisendkäibemaks vaikimisi mahaarvatavana. Kui kasutus on segane või osaliselt isiklik, vähenda mahaarvatavat osa.",
    compliance_basis: [
      BASIS_KMS_DEDUCTION,
      BASIS_KMS_INVOICE,
    ],
    follow_up_questions: [
      "Kas kulu on tehtud ainult ettevõtluse tarbeks või on siin ka isiklikku / mitte-ettevõtluslikku kasutust?",
      "Kas alusdokumendilt on müüja, kuupäev, summa ja käibemaks selgelt tuvastatavad?",
    ],
    policy_hint: "Kui sama kululiigi käibemaksukäsitlus kordub, salvesta see accounting-rules.md faili owner_expense_reimbursement jaotisesse.",
  };
}

export function buildReceiptReviewGuidance(params: {
  classification: ReceiptClassification;
  notes: string[];
  extracted?: Partial<ExtractedReceiptFields>;
  llmFallback?: InvoiceExtractionFallback;
}): ReviewGuidance | undefined {
  const text = normalizedText(
    params.extracted?.supplier_name,
    params.extracted?.description,
    params.notes.join(" "),
  );
  const missingFields = params.llmFallback?.missing_required_fields ?? [];

  if (params.classification === "owner_paid_expense_reimbursement") {
    const ownerExpenseGuidance = buildOwnerExpenseVatReviewGuidance({
      description: params.extracted?.description ?? params.extracted?.supplier_name ?? "Owner-paid expense",
    });
    return {
      recommendation: "Soovitus: ära tee sellest automaatselt ostuarvet. Kasuta omaniku kulu hüvitamise voogu ning otsusta käibemaksu mahaarvamine pärast ettevõtluskasutuse kontrolli.",
      compliance_basis: dedupe([
        BASIS_RPS_DOCUMENT,
        ...ownerExpenseGuidance.compliance_basis,
      ]),
      follow_up_questions: ownerExpenseGuidance.follow_up_questions,
      policy_hint: ownerExpenseGuidance.policy_hint,
    };
  }

  if (params.classification !== "purchase_invoice") {
    return {
      recommendation: "Soovitus: ära kajasta seda enne ostuarvena, kui dokumendi liik ja majanduslik sisu on selged. Kui see ei ole tarnija arve, kasuta sellele sobivat eraldi töövoogu.",
      compliance_basis: [
        BASIS_RPS_DOCUMENT,
        BASIS_RPS_SUBSTANCE,
      ],
      follow_up_questions: [
        "Kas tegemist on üldse tarnija arvega või on see pigem kviitung, lepingu lisa, omaniku kulu või muu tõend?",
        "Mis on selle dokumendi tegelik majanduslik sisu: ost, omaniku kulu hüvitis, lähetuskulu või midagi muud?",
      ],
    };
  }

  if (missingFields.length > 0 || params.notes.some(note => note.includes("Missing supplier name"))) {
    const readableFields = missingFields.map(formatMissingField);
    return {
      recommendation: readableFields.length > 0
        ? `Soovitus: ära auto-booki enne, kui algdokumendilt on kinnitatud vähemalt ${readableFields.join(", ")}.`
        : "Soovitus: ära auto-booki enne, kui müüja, arve kuupäev, number ja summad on algdokumendilt kindlalt kinnitatud.",
      compliance_basis: [
        BASIS_RPS_DOCUMENT,
        BASIS_KMS_INVOICE,
      ],
      follow_up_questions: buildMissingFieldQuestions(missingFields),
      policy_hint: "Kui sama tarnija OCR kipub korduvalt samu välju vahele jätma, tasub sama tarnija jaoks kasutada varasemaid kinnitatud arveid või accounting-rules.md vaikereeglit ainult pärast põhiandmete kinnitamist.",
    };
  }

  if (params.notes.some(note => note.includes("Supplier could not be resolved"))) {
    return {
      recommendation: "Soovitus: seo või loo tarnija alles pärast seda, kui müüja nimi ning võimalusel registrikood, KMKR number või IBAN on algdokumendilt kinnitatud.",
      compliance_basis: [
        BASIS_RPS_DOCUMENT,
        BASIS_KMS_INVOICE,
      ],
      follow_up_questions: [
        "Mis on dokumendil müüja ametlik nimi ning kas registrikood või KMKR number on loetav?",
        "Kas dokumendilt on näha IBAN või muu tunnus, mille järgi saab tarnija olemasoleva kliendiga kindlalt siduda?",
      ],
      policy_hint: "Pärast tarnija kinnitamist saab sama tarnija vaikekäsitluse talletada accounting-rules.md faili või lasta süsteemil kasutada varasemat kinnitatud arvet.",
    };
  }

  if (params.notes.some(note => note.includes("Could not find a purchase article / account suggestion"))) {
    const foreignService = hasAnyKeyword(text, /\b(openai|google|microsoft|zoom|slack|github|hosting|cloud|subscription|software)\b/u);
    return {
      recommendation: foreignService
        ? "Soovitus: käsitle seda vaikimisi teenuse ostuna ning kinnita, kas tegemist on välisriigi ettevõtja teenusega, mis vajab pöördmaksustamist. Alles siis vali konto/artikkel või salvesta see reegliks."
        : "Soovitus: vali konto ja artikkel kulu tegeliku sisu järgi, kasutades võimalusel sama tarnija varasemat kinnitatud arvet vaikimisi pretsedendina.",
      compliance_basis: foreignService
        ? [
            BASIS_RPS_SUBSTANCE,
            BASIS_KMS_DEDUCTION,
            BASIS_KMS_FOREIGN_SERVICE,
          ]
        : [
            BASIS_RPS_SUBSTANCE,
            BASIS_RPS_DOCUMENT,
          ],
      follow_up_questions: foreignService
        ? [
            "Kas tarnija on välisriigi ettevõtja ja kas teenuse käibe tekkimise koht on Eestis?",
            "Kas teenus on kasutatud maksustatava ettevõtluse tarbeks ning kas pöördmaksustamise alus on olemas?",
            "Millisele kulukontole te soovite selle teenuse edaspidi vaikimisi suunata?",
          ]
        : [
            "Mis on selle kauba või teenuse tegelik majanduslik sisu, mille järgi konto valida?",
            "Kas sama tarnija kohta on varasem kinnitatud arve, mille käsitlust võiks vaikeotsusena üle võtta?",
          ],
      policy_hint: "Kui sama tarnija või kululiigi käsitlus kordub, salvesta see accounting-rules.md faili auto_booking jaotisesse.",
    };
  }

  return undefined;
}

export function buildClassificationReviewGuidance(params: {
  category: TransactionClassificationCategory;
  displayCounterparty: string;
}): ReviewGuidance | undefined {
  switch (params.category) {
    case "tax_payments":
      return {
        recommendation: "Soovitus: ära tee sellest ostuarvet. Kajasta makse olemasoleva maksukohustuse, ettemaksu või viivise/intiressina alles pärast seda, kui makse liik on kinnitatud.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [
          `Millise maksu või maksuotsuse kohta ${params.displayCounterparty} makse tegelikult käib?`,
          "Kas see tasub olemasolevat maksukohustust, ettemaksu, viivist või trahvi?",
        ],
      };
    case "salary_payroll":
      return {
        recommendation: "Soovitus: ära tee sellest ostuarvet. Palk, tööjõumaksud ja töötajatele tehtud väljamaksed tuleb kajastada palgaarvestuse või töötasu alusdokumentide järgi.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
          BASIS_RPS_MATCHING,
        ],
        follow_up_questions: [
          "Kas see ülekanne on netopalk, tööjõumaks, lähetushüvitis või muu personalikulu?",
          "Milline palgaarvestuse või muu alusdokument selle maksega seostub?",
        ],
      };
    case "owner_transfers":
      return {
        recommendation: "Soovitus: ära tee sellest ostuarvet. Omanikuga seotud makse tuleb sisu järgi eristada laenuks, kapitalipanuseks, kuluhüvitiseks, dividendiks või eratarbimiseks.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [
          "Kas see liikumine on omaniku laen, kapitalipanus, kulude hüvitis, dividend või omaniku eratarbimine?",
          "Kas selle jaoks on olemas laenuleping, osaniku otsus, kuludokument või muu alusdokument?",
        ],
      };
    case "revenue_without_invoice":
      return {
        recommendation: "Soovitus: ära tee sellest ostuarvet. Seo laekumine müügi, ettemaksu või muu tulu alusdokumendiga ning veendu, et müügiarve või muu tõend on olemas.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
          BASIS_RPS_MATCHING,
        ],
        follow_up_questions: [
          "Kas selle laekumise taga on müügiarve, ettemaks, toetuse laekumine või midagi muud?",
          "Kas tulu kuulub samasse perioodi ja kas vajalik müügidokument on juba olemas?",
        ],
      };
    case "unknown":
      return {
        recommendation: "Soovitus: ära auto-booki enne, kui tehingu tegelik sisu ja alusdokument on selged. Ebakindla tehingu puhul on konservatiivne käsitlus reeglitega kooskõlas parem kui vale automaatkanne.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [
          "Mis on selle tehingu tegelik majanduslik sisu ja mis alusdokumendiga see seostub?",
          "Kas seda tuleks käsitleda ostuna, omaniku liikumisena, palgakuluna, maksena EMTA-le või millegi muuna?",
        ],
      };
    default:
      return undefined;
  }
}

export function buildCamtDuplicateReviewGuidance(params: {
  hasConfirmedMatch: boolean;
}): ReviewGuidance {
  return params.hasConfirmedMatch
    ? {
        recommendation: "Soovitus: hoia vaikimisi alles juba kinnitatud vanem kanne, lisa sellele CAMT bank_ref_number ja muu puuduva pangameta ning ära dubleeri sama pangaliikumist uue kirjega.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [],
      }
    : {
        recommendation: "Soovitus: ära kustuta ega kinnita midagi automaatselt enne, kui on selge, kumb kanne on usaldusväärsem alusdokumentidega seotud kanne. Kui vana kanne on endiselt PROJECT või ebakvaliteetne käsikanne, eelista tavaliselt CAMT allikast tulnud rida.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [],
      };
}
