import { expect, test } from '@playwright/test';

const simT = (page) => page.evaluate(() => window.__gridlock.sim.t);
const vehicles = (page) => page.evaluate(() => window.__gridlock.sim.vehicles.length);

async function worldPoint(page, x, y) {
  return page.evaluate(
    ([wx, wy]) => {
      const c = document.getElementById('world').getBoundingClientRect();
      const s = Math.min(c.width / 900, c.height / 600);
      return { x: c.left + (c.width - 900 * s) / 2 + wx * s, y: c.top + (c.height - 600 * s) / 2 + wy * s };
    },
    [x, y],
  );
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
});
test.afterEach(() => expect(errors, 'console errors').toEqual([]));

test('loads in a ready state with intro and controls', async ({ page }) => {
  await expect(page).toHaveTitle(/Gridlock/);
  await expect(page.locator('#runState')).toHaveText('Ready');
  await expect(page.locator('#intro')).toBeVisible();
  await expect(page.locator('#play')).toContainText('Start');
  await expect(page.locator('#modes button')).toHaveCount(4);
  expect(await simT(page)).toBe(0);
  const size = await page.locator('#world').evaluate((c) => [c.width, c.height]);
  expect(size[0]).toBeGreaterThan(300);
  // icons are rendered as inline SVG, not emoji or text glyphs
  expect(await page.locator('#play svg').count()).toBe(1);
});

test('start, pause, resume and reset', async ({ page }) => {
  await page.click('#introStart');
  await expect(page.locator('#runState')).toHaveText('Running');
  await expect(page.locator('#intro')).toBeHidden();
  await page.click('#speed button[data-v="8"]');
  await expect.poll(() => vehicles(page), { timeout: 10_000 }).toBeGreaterThan(5);
  await page.click('#play');
  await expect(page.locator('#runState')).toHaveText('Paused');
  await expect(page.locator('#play')).toContainText('Resume');
  const t1 = await simT(page);
  await page.waitForTimeout(600);
  expect(await simT(page)).toBe(t1);
  await page.click('#play');
  await expect.poll(() => simT(page)).toBeGreaterThan(t1);
  await page.click('#reset');
  expect(await simT(page)).toBeLessThan(1);
  await expect(page.locator('#runState')).toHaveText('Running');
});

test('step advances exactly one simulated second while paused', async ({ page }) => {
  await page.click('#step');
  await expect(page.locator('#runState')).toHaveText('Paused');
  expect(await simT(page)).toBeCloseTo(1, 5);
  await page.keyboard.press('ArrowRight');
  expect(await simT(page)).toBeCloseTo(2, 5);
});

test('keyboard shortcuts toggle and reset', async ({ page }) => {
  await page.keyboard.press('Space');
  await expect(page.locator('#runState')).toHaveText('Running');
  await page.keyboard.press('Space');
  await expect(page.locator('#runState')).toHaveText('Paused');
  await page.keyboard.press('r');
  expect(await simT(page)).toBe(0);
});

test('switching controller rebuilds the simulation and shows matching timing controls', async ({ page }) => {
  await expect(page.locator('#t_greenEW')).toBeVisible();
  await expect(page.locator('#t_gap')).toHaveCount(0);
  await page.click('#modes button[data-m="actuated"]');
  expect(await page.evaluate(() => window.__gridlock.sim.mode)).toBe('actuated');
  await expect(page.locator('#mdesc')).toContainText('detectors');
  await expect(page.locator('#t_gap')).toBeVisible();
  await expect(page.locator('#t_greenEW')).toHaveCount(0);
  await page.click('#modes button[data-m="pressure"]');
  expect(await page.evaluate(() => window.__gridlock.sim.controllers.every((c) => c.mode === 'pressure'))).toBe(true);
});

test('sliders change the live simulation', async ({ page }) => {
  await page.locator('#t_greenEW').fill('30');
  expect(await page.evaluate(() => window.__gridlock.sim.timing.greenEW)).toBe(30);
  expect(await page.evaluate(() => window.__gridlock.sim.controllers[0].green(0))).toBe(30);
  await expect(page.locator('#t_greenEWV')).toHaveText('30 s');
  await page.locator('#demand').fill('80');
  expect(await page.evaluate(() => window.__gridlock.sim.demand)).toBe(80);
  await expect(page.locator('#demandV')).toHaveText('80 veh/min');
  await page.locator('#ew').fill('70');
  expect(await page.evaluate(() => window.__gridlock.sim.ewShare)).toBeCloseTo(0.7);
  await page.locator('#peds').uncheck();
  expect(await page.evaluate(() => window.__gridlock.sim.pedestrians)).toBe(false);
  await expect(page.locator('#pedRate')).toBeDisabled();
  await page.locator('#smart').check();
  expect(await page.evaluate(() => window.__gridlock.sim.smartRouting)).toBe(true);
});

test('seed input resets with reproducible traffic', async ({ page }) => {
  await page.locator('#seed').fill('4242');
  await page.locator('#seed').press('Enter');
  await page.locator('#seed').blur();
  expect(await page.evaluate(() => window.__gridlock.sim.seed)).toBe(4242);
});

test('clicking a junction opens the inspector and metrics update', async ({ page }) => {
  await page.click('#introStart');
  await page.click('#speed button[data-v="8"]');
  await expect.poll(() => page.evaluate(() => window.__gridlock.sim.t), { timeout: 15_000 }).toBeGreaterThan(40);
  const p = await worldPoint(page, 450, 300);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('#inspector .insp-head b')).toHaveText('B2');
  await expect(page.locator('#inspector .q')).toHaveCount(4);
  await expect(page.locator('#m_on')).not.toHaveText('0');
  await expect(page.locator('#level')).not.toHaveText('No traffic');
  await expect(page.locator('#safety')).toContainText('0 collisions');
  // clicking again deselects
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('#inspector .empty')).toBeVisible();
});

test('benchmark compares all four controllers', async ({ page }) => {
  await page.click('#bench');
  await expect(page.locator('#bench')).toBeDisabled();
  await expect(page.locator('#btab tbody tr')).toHaveCount(4, { timeout: 45_000 });
  await expect(page.locator('#bstat')).toContainText('Lowest delay');
  await expect(page.locator('#bstat')).toContainText('0 collisions');
  await expect(page.locator('#bench')).toBeEnabled();
  expect(await page.locator('#btab td.best').count()).toBeGreaterThanOrEqual(4);
});

test('mobile layout stacks without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const stage = await page.locator('.stage').boundingBox();
  const panel = await page.locator('.panel').boundingBox();
  expect(panel.y).toBeGreaterThan(stage.y + stage.height - 1);
  await page.click('#introStart');
  await expect(page.locator('#runState')).toHaveText('Running');
});
