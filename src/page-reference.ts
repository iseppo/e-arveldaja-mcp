import { cloneAndFreezePlanData, type PlanData } from "./plan-store.js";

export interface PageReference {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export function pageReference(tool: string, args: Readonly<Record<string, unknown>>): PageReference {
  const clonedArgs = cloneAndFreezePlanData(args as unknown as PlanData) as unknown as Readonly<Record<string, unknown>>;
  return Object.freeze({ tool, args: clonedArgs });
}
