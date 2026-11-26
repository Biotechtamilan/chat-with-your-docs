// Renders every page of a PDF to PNG files: node scripts/render-pdf-pages.mjs in.pdf out-prefix
// Used to build the scanned sample (see scripts/make-scanned-sample.py).
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, renderPageAsImage } from "unpdf";

const [input, prefix] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(input));
const pdf = await getDocumentProxy(new Uint8Array(bytes));
for (let page = 1; page <= pdf.numPages; page++) {
  const png = await renderPageAsImage(new Uint8Array(bytes), page, {
    canvasImport: () => import("@napi-rs/canvas"),
    scale: 2,
  });
  writeFileSync(`${prefix}-${page}.png`, Buffer.from(png));
  console.log(`wrote ${prefix}-${page}.png`);
}
