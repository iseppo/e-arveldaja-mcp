/**
 * Canonical owner-facing guidance for the limited taxpayer (piiratud
 * maksukohustuslane, KMS § 21). Rendered by `limited_vat` mode `guide` and
 * included in the `earveldaja://tax_rules` resource. Server-authored text;
 * only the facts verified on LIMITED_VAT_GUIDANCE_VERIFIED_AT are stated.
 */

export const LIMITED_VAT_GUIDANCE_VERIFIED_AT = "2026-11-04";

export interface LimitedVatGuidanceSection {
  id: "why" | "what_it_means" | "how_to_register" | "after_registering" | "monthly_routine" | "oss_caveat";
  title: string;
  paragraphs: readonly string[];
}

export interface LimitedVatGuidanceSource {
  title: string;
  url?: string;
}

export interface LimitedVatGuidance {
  title: string;
  verified_at: string;
  sections: readonly LimitedVatGuidanceSection[];
  sources: readonly LimitedVatGuidanceSource[];
}

export const LIMITED_VAT_NUMBER_CHECK_URL = "https://apps.emta.ee/saqu/public/kmkrnr?lang=et";

const SECTIONS: readonly LimitedVatGuidanceSection[] = [
  {
    id: "why",
    title: "Miks see vajalik on",
    paragraphs: [
      "Kui ettevõte ei ole käibemaksukohustuslasena registreeritud ja ostab välismaa ettevõttelt, kes ei ole Eestis registreeritud, KMS § 10 lg 5 nimetatud teenuseid, tuleb end registreerida piiratud maksukohustuslaseks alates teenuse saamise päevast (KMS § 21 lg 1).",
      "Teenuste puhul piirmäära ei ole: kohustus tekib kohe esimese sellise teenuse saamisel. 10 000 € piirmäär kehtib ainult kaupade ühendusesisesele soetamisele (KMS § 21 lg 2).",
      "KMS § 10 lg 5 teenused on: 1) intellektuaalomandi õigused, 2) reklaam, 3) konsultatsiooni-, raamatupidamis-, õigus-, auditi-, inseneri-, tõlke-, andmetöötlus- ja infoteenus, 4) finants- ja kindlustusteenus (v.a seifirent), 5) personali andmine, 6) vallasasja rent (v.a transpordivahend), 7) elektroonilise side teenus, 8) elektrooniliselt osutatav teenus, 9) gaasi-, elektri- ja soojusvõrgu juurdepääs, 10) heitkoguse ühikud, 11) punktides 1–10 nimetatust hoidumine.",
      "Pilveteenused, SaaS-tarkvara ja tehisintellekti API-d on tavaliselt punkt 3 ja/või punkt 8.",
      "Selles tööriistas ei loeta panga-, makse-, Wise'i ega Lightyeari tasusid (finantsteenused) kohustuse tekitajaks; omanik saab iga tarnija puhul selle otsuse üle kirjutada.",
      "Erand: kui tarnija on ELi väikeettevõtja erikorra kasutaja ja tema registreerimisnumber lõpeb tähtedega \"EX\", registreerimiskohustust selle teenuse tõttu ei teki.",
    ],
  },
  {
    id: "what_it_means",
    title: "Mida piiratud maksukohustuslane tähendab",
    paragraphs: [
      "Piiratud maksukohustuslane maksab käibemaksu välismaa ettevõtetelt (kes ei ole Eestis registreeritud) saadud teenustelt (KMS § 3 lg 5, § 29 lg 12). See tööriist käsitleb ainult neid teenuseid; kaupade ühendusesisene soetamine on eraldi teema.",
      "Sisendkäibemaksu maha arvata ei saa ja oma müügiarvetele käibemaksu ei lisata (KMS § 25 lg 1). Arvestatud käibemaks on seega ettevõtte kulu.",
      "Käibedeklaratsioon (KMD) esitatakse ainult nende kuude kohta, kus selliseid tehinguid oli (KMS § 27 lg 2 p 2), ja maks tasutakse järgmise kuu 20. kuupäevaks (KMS § 38 lg 1).",
      "Teenus loetakse saaduks kõige varasemal kuupäeval järgmistest: teenuse osutamine või (osaline) tasumine (KMS § 11 lg 1). Välisvaluuta arvestatakse eurodesse Euroopa Keskpanga selle päeva kursiga (KMS § 29 lg 13).",
    ],
  },
  {
    id: "how_to_register",
    title: "Kuidas registreerida",
    paragraphs: [
      "Avaldus tuleb esitada 3 tööpäeva jooksul; ettevõte registreeritakse alates kohustuse tekkimise päevast (KMS § 21 lg 3). Varem võib end registreerida ka vabatahtlikult (KMS § 21 lg 4).",
      "e-MTA-s: \"Registrid ja päringud\" → \"Registreerimine\" → \"Käibemaksukohustuslaseks registreerimine\" ja vali piiratud maksukohustuslane.",
      "Selleks on vaja pääsuõigust \"Käibemaksukohustuslasena registreerimise (KMKR) avalduste esitamine\" (\"Seaded\" → \"Pääsuõigused\" → \"Esindajate pääsuõigused\").",
      "Teine võimalus: vorm \"Piiratud maksukohustuslase registreerimise avaldus\" digiallkirjastatult aadressile emta@emta.ee või teenindusbüroos.",
      `Numbrit saab kontrollida: ${LIMITED_VAT_NUMBER_CHECK_URL}`,
    ],
  },
  {
    id: "after_registering",
    title: "Pärast registreerimist",
    paragraphs: [
      "Anna saadud number välismaa tarnijatele (nende arveldusliideses maksunumbri väljale), et nad lõpetaksid käibemaksu lisamise.",
      "Kui number on e-arveldajas olemas, kontrollib server EMTA avalikust KMKR päringust ise, kas see on piiratud või täieliku käibemaksukohustuslase number, ja võtab registreerimise kuupäeva staatuse alguseks; vaata limited_vat mode \"status\". Piiratud maksukohustuslasena ei käsitle server ettevõtet täieliku käibemaksukohustuslasena: ostuarvetel sisendkäibemaksu maha ei arvata ja pöördmaksustamise sisendrida ei teki. Müügiarvetele ära lisa käibemaksu.",
      "Kui EMTA päring ei õnnestu või ei näita täpselt üht kehtivat registreeringut, keeldub käibemaksust sõltuv broneerimine, kuni päring õnnestub või omanik kinnitab staatuse: limited_vat mode \"set_status\" status \"limited\" koos effective_from kuupäevaga (või \"full\"). Omaniku kinnitus kehtib selle KMKR numbri kohta ja on EMTA päringust ülimuslik.",
    ],
  },
  {
    id: "monthly_routine",
    title: "Igakuine töö",
    paragraphs: [
      "Pärast kuu ostuarvete kinnitamist ja enne järgmise kuu 20. kuupäeva: käivita limited_vat mode \"month\" selle kuu kohta (eelvaade), kinnita tarnijate liigitus ja vaata kanne üle; pärast omaniku nõusolekut loob server kande PKM-AAAA-KK (deebet kulukontod, kreedit käibemaksukohustis) ja kinnitab selle.",
      "Väljund annab ka KMD read: rida 1 ja rida 4 (maksustatav väärtus ja käibemaks) ning saadud teenused rida 6 (ELi tarnija) / rida 7 (muu välismaa tarnija) — kontrolli neid e-MTA KMD juhendi järgi.",
      "See server KMD-d ei esita. Kui e-arveldaja toetab piiratud maksukohustuslase KMD-d ise, kasuta seda.",
      "Maksu tasumine EMTA-le käib nagu tavaliselt ettemaksukonto (1516) kaudu: pangamakse EMTA-le broneeritakse ettemaksukonto täiendusena.",
    ],
  },
  {
    id: "oss_caveat",
    title: "Kui tarnija on juba käibemaksu lisanud (kontrolli)",
    paragraphs: [
      "Kui välismaa tarnija on arvele käibemaksu juba lisanud (OSS / eraisikule müügi käsitlus), ei ütle see server, kas tuleb lisaks ise käibemaksu arvestada või kuidas tarnija lisatud maks tagasi saada. Küsi seda EMTA-lt kirjalikult.",
      "limited_vat mode \"month\" märgib sellised arved ülevaatamiseks ega lisa neid kandesse.",
    ],
  },
];

const SOURCES: readonly LimitedVatGuidanceSource[] = [
  { title: "Käibemaksuseadus (KMS) § 3 lg 5, § 10 lg 5, § 11 lg 1, § 21 lg 1–4, § 25 lg 1, § 27 lg 2 p 2, § 29 lg 12–13, § 38 lg 1" },
  { title: "EMTA käsiraamat: piiratud maksukohustuslasena registreerimine" },
  { title: "Rahandusministeeriumi kommentaar (jaanuar 2026): teenuste puhul maksuvaba piirmäära ei ole" },
  { title: "EMTA KMKR numbri kontroll", url: LIMITED_VAT_NUMBER_CHECK_URL },
];

export function buildLimitedVatGuidance(): LimitedVatGuidance {
  return {
    title: "Piiratud maksukohustuslane (KMS § 21)",
    verified_at: LIMITED_VAT_GUIDANCE_VERIFIED_AT,
    sections: SECTIONS,
    sources: SOURCES,
  };
}
