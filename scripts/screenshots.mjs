// Captures documentation screenshots (and a short GIF) from the real production
// build. Usage: npm run build && npm run screenshots
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import pngjs from 'pngjs';

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { PNG } = pngjs;
import { preview } from 'vite';

const OUT = 'docs/screenshots';
const PORT = 4179;
const channel = process.env.PW_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);

await mkdir(OUT, { recursive: true });
const server = await preview({ preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await chromium.launch({ channel });

async function open(viewport, scale = 1) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__gridlock);
  return page;
}

const worldRect = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('world').getBoundingClientRect();
    const s = Math.min(c.width / 900, c.height / 600);
    return { x: c.left + (c.width - 900 * s) / 2, y: c.top + (c.height - 600 * s) / 2, s };
  });

async function clickJunction(page, x, y) {
  const r = await worldRect(page);
  await page.mouse.click(r.x + x * r.s, r.y + y * r.s);
}

// Advance the simulation headlessly to a given time (fast and deterministic).
const advance = (page, seconds) => page.evaluate((s) => window.__gridlock.sim.run(s), seconds);

async function shot(page, name, opts = {}) {
  await page.waitForTimeout(1200); // let the stats panel and fps counter refresh
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log('saved', name);
}

const desktop = { width: 1440, height: 900 };

// 1. Ready state
{
  const page = await open(desktop);
  await shot(page, '01-ready');
  await page.close();
}

// 2. Running, fixed timer, inspector open
{
  const page = await open(desktop);
  await page.click('#introStart');
  await advance(page, 75);
  await clickJunction(page, 450, 300);
  await page.click('#play'); // pause for a crisp frame
  await shot(page, '02-fixed-timer-running');
  await page.close();
}

// 3. Rush hour: heavy east-west demand, congestion rings and spillback
{
  const page = await open(desktop);
  await page.locator('#demand').fill('85');
  await page.locator('#ew').fill('75');
  await page.click('#introStart');
  await advance(page, 240);
  await page.click('#play');
  await page.locator('.panel').evaluate((el) => el.scrollTo(0, 560));
  await shot(page, '03-rush-hour-congestion');
  await page.close();
}

// 4. Max-pressure controller with junction inspector
{
  const page = await open(desktop);
  await page.click('#modes button[data-m="pressure"]');
  await page.locator('#ew').fill('70');
  await page.click('#introStart');
  await advance(page, 120);
  await clickJunction(page, 700, 300);
  await page.click('#play');
  await page.locator('.panel').evaluate((el) => el.scrollTo(0, 820));
  await shot(page, '04-max-pressure-inspector');
  await page.close();
}

// 5. Benchmark results
{
  const page = await open(desktop);
  await page.click('#bench');
  await page.locator('#btab tbody tr').nth(3).waitFor({ timeout: 60_000 });
  await page.locator('.panel').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot(page, '05-benchmark-comparison');
  await page.close();
}

// 6. Junction close-up (turning vehicles, signals, pedestrians)
{
  const page = await open(desktop, 2);
  await page.click('#introStart');
  await advance(page, 95);
  await page.click('#play');
  const r = await worldRect(page);
  await shot(page, '06-junction-closeup', { clip: { x: r.x + 330 * r.s, y: r.y + 200 * r.s, width: 250 * r.s, height: 200 * r.s } });
  await page.close();
}

// 7. Mobile
{
  const page = await open({ width: 390, height: 844 }, 2);
  await page.click('#introStart');
  await advance(page, 60);
  await page.click('#play');
  await shot(page, '07-mobile');
  await page.close();
}

// 8. Short GIF of live traffic, captured frame by frame from the canvas.
{
  const page = await open({ width: 1100, height: 760 });
  await page.locator('#demand').fill('55');
  await page.click('#introStart');
  await advance(page, 50);
  await page.click('#play');
  const r = await worldRect(page);
  const clip = { x: r.x + 120 * r.s, y: r.y + 80 * r.s, width: 660 * r.s, height: 440 * r.s };
  const gif = GIFEncoder();
  const FRAMES = 60;
  for (let k = 0; k < FRAMES; k++) {
    await advance(page, 0.25); // 0.25 s of simulated time per frame, played back at 8 fps (2x speed)
    await page.waitForTimeout(40);
    const png = PNG.sync.read(await page.screenshot({ clip }));
    const palette = quantize(png.data, 128);
    gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, { palette, delay: 125 });
  }
  gif.finish();
  await writeFile(`${OUT}/traffic-demo.gif`, gif.bytes());
  console.log('saved traffic-demo.gif');
  await page.close();
}

await browser.close();
await new Promise((res) => server.httpServer.close(res));
