// Bootstrap that registers the @/ alias resolution hook for the current
// process, then can be passed via `node --import ./scripts/alias-register.mjs`.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-loader.mjs", pathToFileURL("./scripts/").href);
