import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { imageDimensions } from "./context/image-size.js";
import { planScale, shrinkImage } from "./image-resize.js";
import { sniffImageMime } from "./images.js";

/**
 * `bun run image-preview <picture> [out-dir]`: writes the picture scaled to several pixel budgets, to look at what the model would
 * get (if you can still read what matters, the model usually can). Prints size and the estimated token cost of each.
 */
const [file, outDir = "data/image-preview"] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun run image-preview <picture> [out-dir]");
  process.exit(1);
}
const data = readFileSync(file);
const mime = sniffImageMime(data);
if (!mime) {
  console.error("not a jpeg/png/gif/webp picture");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const dims = imageDimensions(data);
console.log(`${file}: ${dims ? `${dims.width}x${dims.height}` : "?"} ${mime} ${data.length} bytes`);
const base = path.basename(file).replace(/\.[^.]+$/, "");
for (const maxPixels of [100_000, 250_000, 500_000, 800_000, 1_150_000]) {
  const out = await shrinkImage({ data, mime }, { maxPixels, maxEdge: 1568 });
  const d = imageDimensions(out.data) ?? dims;
  const ext = out.mime === "image/jpeg" ? "jpg" : out.mime === "image/webp" ? "webp" : (mime.split("/")[1] ?? "img");
  const name = path.join(outDir, `${base}.${maxPixels / 1000}k.${ext}`);
  writeFileSync(name, out.data);
  const scale = dims ? planScale(dims.width, dims.height, { maxPixels, maxEdge: 1568 }) : 1;
  console.log(`  budget ${String(maxPixels / 1000).padStart(5)}k px -> ${d ? `${d.width}x${d.height}` : "?"} (x${scale.toFixed(2)}) ~${d ? Math.ceil((d.width * d.height) / 750) : "?"} tokens, ${out.data.length} bytes -> ${name}`);
}
