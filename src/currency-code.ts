// The SINGLE canonical home for the `CurrencyCode` nominal alias.
//
// A lightweight nominal alias — deliberately NOT validated at runtime and with
// no validation-library dependency. The optional brand keeps it structurally
// assignable from a plain `string`, so every existing caller that passes a raw
// three-letter currency code keeps compiling; the alias documents intent and
// gives a future tightening hook without a happy-path behaviour change.
//
// Task 18 first introduced this alias inside `src/types/mutations.ts`; Task 19
// moved the definition here so there is ONE definition and no drift.
// `src/types/mutations.ts` re-exports it. A currency code is NOT a monetary
// cent value and NOT an exchange rate — those live in `money-cents.ts` and
// `exchange-rate.ts` respectively and must stay conceptually separate.
export type CurrencyCode = string & { readonly __brand?: "CurrencyCode" };
