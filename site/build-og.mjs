#!/usr/bin/env node
// site/build-og.mjs - render site/og-card.html to site/og.png (1200x630).
//
// The Open Graph image is referenced from index.html's og:image/twitter:image.
// Committing only the PNG would make the copy uneditable, so the card is
// authored as HTML and rasterised here. Run this after changing og-card.html.
//
//   node site/build-og.mjs
//
// Requires playwright's chromium (npx playwright install chromium).

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "og-card.html");
const out = join(here, "og.png");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(source).href, { waitUntil: "networkidle" });
// Webfonts load over the network; make sure they are painted before capture.
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();

console.log(`wrote ${out}`);
