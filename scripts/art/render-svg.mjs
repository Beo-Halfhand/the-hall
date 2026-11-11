// Renders an SVG file, exactly as it is, to a transparent PNG of a given width (its own aspect kept), in headless Chrome.
// Used for the official Midnight symbol on the saloon tapestry: the file is not redrawn, recoloured or stretched, only drawn
// at a size. Usage: node scripts/art/render-svg.mjs <in.svg> <width px> <out.png>
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [src, widthArg, out] = process.argv.slice(2);
if (!src || !widthArg || !out) {
  console.error('usage: node scripts/art/render-svg.mjs <in.svg> <width px> <out.png>');
  process.exit(2);
}
const svg = readFileSync(src);
const box = /viewBox="([\d.\s-]+)"/.exec(svg.toString())?.[1].trim().split(/\s+/).map(Number);
if (!box) throw new Error('no viewBox in the svg');
const width = Number(widthArg);
const height = Math.round((width * box[3]) / box[2]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img src="data:image/svg+xml;base64,${svg.toString('base64')}" width="${width}" height="${height}">`);
await page.waitForFunction(() => document.querySelector('img').complete);
await page.locator('img').screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(`${out}: ${width} x ${height}`);
