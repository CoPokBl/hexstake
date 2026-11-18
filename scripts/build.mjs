import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const tests = process.argv.includes("--tests");

if (tests) {
  rmSync("dist-test", { recursive: true, force: true });
  const entries = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
  await build({
    entryPoints: entries, outdir: "dist-test", bundle: true, platform: "node", format: "esm",
    target: "node22", packages: "external", outExtension: { ".js": ".mjs" }, logLevel: "warning",
  });
} else {
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist/public", { recursive: true });
  await build({
    entryPoints: ["server/index.ts"], outfile: "dist/server.js", bundle: true, platform: "node",
    format: "esm", target: "node22", packages: "external", sourcemap: true, logLevel: "warning",
  });
  await build({
    entryPoints: ["client/main.ts"], outfile: "dist/public/app.js", bundle: true, platform: "browser",
    format: "esm", target: "es2020", minify: true, sourcemap: true, logLevel: "warning",
  });
  cpSync("client/public", "dist/public", { recursive: true });
}
