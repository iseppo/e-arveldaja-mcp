import type { Transaction, TransactionDistribution } from "../../types/api.js";
import { positiveEurAmount } from "../eur-amount-proof.js";

export interface ConfirmedDistributionRow {
  table: string; relation_id: number; accounts_id: number | null;
  accounts_dimensions_id: number | null; amount_eur: number;
}

/** Normalize observed GET rows without guessing an invoice relation or FX base. */
export function confirmedDistributionEvidence(tx: Transaction, reviewed: readonly TransactionDistribution[]):
  {ok: true; rows: ConfirmedDistributionRow[]; linkage_absent: boolean} | {ok: false; reason: string} {
  const rows: ConfirmedDistributionRow[] = [];
  for (const item of tx.items ?? []) {
    const proof=positiveEurAmount(item,tx.cl_currencies_id);
    if (!proof.ok) return {ok:false,reason:proof.reason};
    const base=proof.value;
    const table = item.relation_table ?? "accounts";
    if (table !== "accounts" && table !== "sale_invoices" && table !== "purchase_invoices") return {ok:false, reason:"distribution_table_unknown"};
    const id = table === "accounts" ? item.accounts_id : item.relation_id;
    if (typeof id!=="number" || !Number.isSafeInteger(id) || id<=0) return {ok:false,reason:"distribution_relation_conflict"};
    if (table === "accounts" && item.relation_id != null && item.relation_id !== id) {
      const dimension=item.accounts_dimensions_id;
      // Native GET observed 2026-10-18: relation_id concatenates the already
      // explicit account + dimension. Never split it to infer either identity.
      const nativeComposite=item.relation_table==="accounts" && typeof dimension==="number" && Number.isSafeInteger(dimension) && dimension>0
        && Number.isSafeInteger(item.relation_id) && String(item.relation_id)===`${id}${dimension}`;
      if (!nativeComposite) return {ok:false,reason:"distribution_relation_conflict"};
    }
    rows.push({table, relation_id:id, accounts_id:table === "accounts" ? item.accounts_id ?? null : null,
      accounts_dimensions_id:table === "accounts" ? item.accounts_dimensions_id ?? null : null, amount_eur:base});
  }
  const sort = (values: ConfirmedDistributionRow[]) => values.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const expected = reviewed.map(row => ({table: row.related_table, relation_id:row.related_id!,
    accounts_id: row.related_table === "accounts" ? row.related_id ?? null : null,
    accounts_dimensions_id: row.related_table === "accounts" ? row.related_sub_id ?? null : null, amount_eur:row.amount!}));
  sort(rows); sort(expected);
  if (rows.length && (rows.length !== expected.length || rows.some((row,index) => {
    const approved = expected[index]!;
    return row.table !== approved.table || row.relation_id !== approved.relation_id || row.accounts_id !== approved.accounts_id
      || row.accounts_dimensions_id !== approved.accounts_dimensions_id || Math.abs(row.amount_eur - approved.amount_eur) > .01;
  }))) return {ok:false, reason:"distribution_material_drift"};
  return {ok:true, rows, linkage_absent:rows.length === 0};
}
