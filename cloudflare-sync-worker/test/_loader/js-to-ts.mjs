// Test-only ESM resolve hook that lets `node --test` import the worker's
// TypeScript source directly. The worker's `.ts` modules import each other
// using `.js` specifiers (the standard ESM-compatible TypeScript convention),
// e.g. `import { safeEqual } from "./auth.js"`, while the files on disk are
// `.ts`. Node's built-in TypeScript type-stripping (Node >= 22.6) handles a
// direct `.ts` import, but does not remap a `.js` specifier to a `.ts` file.
// This hook rewrites a failing `.js` specifier to its sibling `.ts` file when
// one exists, then lets Node's built-in loader strip the types.
//
// Usage from a `.test.mjs`:
//   import { register } from "node:module";
//   register("./_loader/js-to-ts.mjs", import.meta.url);
//   const { adminRouter } = await import("../src/admin.ts");
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function tryResolveToTs(specifier, parentURL) {
  let url;
  try {
    url = new URL(specifier, parentURL ?? "file://./");
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || !url.pathname.endsWith(".js")) {
    return null;
  }
  const ts = new URL(url.href);
  ts.pathname = `${ts.pathname.slice(0, -3)}.ts`;
  try {
    if (existsSync(fileURLToPath(ts))) {
      return ts.href;
    }
  } catch {}
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const tsHref = tryResolveToTs(specifier, context.parentURL);
    if (tsHref) {
      return nextResolve(tsHref, context);
    }
    throw error;
  }
}
