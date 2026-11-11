// Renders the link-preview card (og-card.html) at 1200x630 in headless Chrome and writes it as a progressive JPEG.
//   node scripts/art/og-card.mjs                      -> public/og.jpg (with the Midnight symbol)
//   node scripts/art/og-card.mjs --no-symbol out.jpg  -> the same card without the symbol, to a path
//   node scripts/art/og-card.mjs --png out.png        -> a PNG, for a look
// The fonts come from Google Fonts, so it needs the network. Nothing about this machine goes into the image.
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const noSymbol = args.includes('--no-symbol');
const png = args.includes('--png');
const out = args.filter((a) => !a.startsWith('--'))[0] ?? resolve(new URL('../../public/og.jpg', import.meta.url).pathname);
const html = pathToFileURL(new URL('./og-card.html', import.meta.url).pathname).href;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(html);
if (noSymbol) await page.evaluate(() => document.body.classList.add('no-symbol'));
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => document.fonts.check('700 100px Cinzel') && document.fonts.check('500 40px "Alegreya SC"'), null, { timeout: 20000 });
await page.waitForTimeout(400);
const shot = await page.locator('#card').screenshot({ type: 'png' });
await browser.close();
if (png) await sharp(shot).png().toFile(out);
else await sharp(shot).jpeg({ quality: 92, progressive: true, mozjpeg: true }).toFile(out);
const meta = await sharp(out).metadata();
console.log(`${out}: ${meta.width}x${meta.height} ${meta.format}, ${Math.round((await sharp(out).toBuffer()).length / 1024)} KB${noSymbol ? ', no symbol' : ''}`);
