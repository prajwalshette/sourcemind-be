import moduleAlias from "module-alias";

// Vercel Serverless runs from source (no `dist/`).
// Set aliases so existing `@utils/*` style imports keep working.
// `module-alias` types don't expose `addAliases`, but it exists at runtime.
(moduleAlias as any).addAliases({
  "@": __dirname + "/../src",
  "@config": __dirname + "/../src/config",
  "@controllers": __dirname + "/../src/controllers",
  "@dtos": __dirname + "/../src/dtos",
  "@exceptions": __dirname + "/../src/exceptions",
  "@generated": __dirname + "/../src/generated",
  "@interfaces": __dirname + "/../src/interfaces",
  "@jobs": __dirname + "/../src/jobs",
  "@middlewares": __dirname + "/../src/middlewares",
  "@routes": __dirname + "/../src/routes",
  "@schemas": __dirname + "/../src/schemas",
  "@services": __dirname + "/../src/services",
  "@utils": __dirname + "/../src/utils",
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require("../src/vercel").default;

export default handler;

