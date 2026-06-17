// Minimal Node module-resolution hook for running the TS engine under
// `node --experimental-strip-types`. It:
//  1. maps the "@/..." path alias (tsconfig.json) to the project root, and
//  2. appends ".ts" to extensionless local imports (TS allows them).
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function withTsExtension(spec) {
  // Only adjust extensionless local/aliased paths.
  if (/\.(ts|tsx|mjs|js|json)$/.test(spec)) return spec;
  return spec + ".ts";
}

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith("@/")) {
    const fsPath = join(root, spec.slice(2));
    const withExt = withTsExtension(fsPath);
    return nextResolve(pathToFileURL(existsSync(fsPath) ? fsPath : withExt).href, context);
  }
  if (spec.startsWith(".") && !/\.(ts|tsx|mjs|js|json)$/.test(spec)) {
    spec = withTsExtension(spec);
  }
  return nextResolve(spec, context);
}
