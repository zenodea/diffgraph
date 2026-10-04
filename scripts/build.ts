// Bundles the page (src/web) into dist/web. --watch rebuilds on change.
import * as esbuild from "esbuild";

const options: esbuild.BuildOptions = {
  entryPoints: { main: "src/web/main.tsx" },
  bundle: true,
  outdir: "dist/web",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !process.argv.includes("--watch"),
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
