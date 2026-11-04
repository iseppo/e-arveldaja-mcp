/**
 * Business-register names by registry code, cached for the process by the
 * extraction cross-check (registry-supplier-check.ts). Only the register's own
 * names are stored; a failed lookup is not. Dependency-free so the Vitest
 * setup can clear it without loading the extraction modules early.
 */
const CACHE_MAX_ENTRIES = 500;
const registryNames = new Map<string, string>();

export function cachedRegistryName(regCode: string): string | undefined {
  return registryNames.get(regCode);
}

export function cacheRegistryName(regCode: string, name: string): void {
  if (registryNames.size >= CACHE_MAX_ENTRIES) registryNames.delete(registryNames.keys().next().value!);
  registryNames.set(regCode, name);
}

/** Test seam: forget cached register names. */
export function clearRegistryNameCache(): void {
  registryNames.clear();
}
