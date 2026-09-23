// Builds (or serves) the webview in a plain browser: the real bundle and the
// real markup from src/webview/html.ts, plus a host shim and theme variables.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

// One markup source: render the production HTML, then swap its CSP (there is no
// host to enforce it against) for the theme stylesheet and host shim.
const { outputFiles } = await esbuild.build({
  entryPoints: [join(root, "src/webview/html.ts")], bundle: true, format: "esm", platform: "node", write: false,
});
const { renderHtml } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const html = renderHtml({ cspSource: "", nonce: "harness", scriptUri: "webview.js", styleUri: "webview.css" })
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "")
  .replace("</head>", '<link id="theme" rel="stylesheet" href="themes/dark.css">\n<script src="shim.js"></script>\n</head>');
writeFileSync(join(dist, "index.html"), html);
cpSync(join(here, "themes"), join(dist, "themes"), { recursive: true });
cpSync(join(here, "gallery.html"), join(dist, "gallery.html"));

const contexts = await Promise.all([
  esbuild.context({ entryPoints: [join(root, "src/webview/main.ts")], bundle: true, format: "iife", outfile: join(dist, "webview.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "shim.ts")], bundle: true, format: "iife", outfile: join(dist, "shim.js"), sourcemap: true }),
]);

if (process.argv.includes("--serve")) {
  await Promise.all(contexts.map((c) => c.watch()));
  const { port } = await contexts[0].serve({ servedir: dist, port: 5178 });
  console.log(`harness:  http://localhost:${port}/?theme=dark&state=default`);
  console.log(`gallery:  http://localhost:${port}/gallery.html?state=default`);
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log(`harness built to ${dist}`);
}
