// ESM loader hook: resolves bare TypeScript imports (e.g. './db') that omit
// the .ts extension — needed because Node's strip-types mode still requires
// explicit extensions in import specifiers, but our lib code omits them
// (Vite + Astro handle the resolution at build time).
// Usage: node --loader ./src/lib/test-ts-resolve.mjs --experimental-strip-types ...
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) &&
      !specifier.includes('.', specifier.lastIndexOf('/') + 1)) {
    const parent = new URL(context.parentURL);
    const candidate = fileURLToPath(new URL(specifier + '.ts', parent));
    if (existsSync(candidate)) {
      return nextResolve(specifier + '.ts', context);
    }
  }
  return nextResolve(specifier, context);
}
