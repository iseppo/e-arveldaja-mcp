// Resolve hook: every import of src/document-parser resolves to the frozen-parse cache (cached-parser.ts), except
// the cache module's own import of the real parser.
const CACHE = new URL("./cached-parser.ts", import.meta.url).href;

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (/\/src\/document-parser\.(?:ts|js)$/.test(resolved.url) && context.parentURL !== CACHE) {
    return { ...resolved, url: CACHE, shortCircuit: true };
  }
  return resolved;
}
