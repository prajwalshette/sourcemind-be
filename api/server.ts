import path from "path";
import * as moduleAlias from "module-alias";

// Vercel's `@vercel/node` compiles `api/server.ts` (and imports) into the
// serverless bundle. There is no `dist/` folder at runtime, so we must map
// our path aliases to `src/` here (instead of `package.json`'s `_moduleAliases`,
// which points to `dist/` for local production runs).
const projectRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(projectRoot, "src");

moduleAlias.addAliases({
  "@": srcRoot,
  "@config": path.join(srcRoot, "config"),
  "@controllers": path.join(srcRoot, "controllers"),
  "@dtos": path.join(srcRoot, "dtos"),
  "@exceptions": path.join(srcRoot, "exceptions"),
  "@generated": path.join(srcRoot, "generated"),
  "@interfaces": path.join(srcRoot, "interfaces"),
  "@jobs": path.join(srcRoot, "jobs"),
  "@middlewares": path.join(srcRoot, "middlewares"),
  "@routes": path.join(srcRoot, "routes"),
  "@schemas": path.join(srcRoot, "schemas"),
  "@services": path.join(srcRoot, "services"),
  "@utils": path.join(srcRoot, "utils"),
});

// IMPORTANT: must be `require()` (not static `import`) so aliases are registered
// before `src/app` (and its `@config/env` import) is loaded in the bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require("../src/app").default;

export default app;
