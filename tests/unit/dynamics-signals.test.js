import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, IDM, SPEED_LIMIT } from '../../src/sim/constants.js';
import { DEFAULT_TIMING, MODES, SignalController } from '../../src/sim/signals.js';
import { Simulation, idmAcceleration } from '../../src/sim/simulation.js';

test('IDM accelerates to desired speed on a free road', () => {
  let v = 0;
  for (let t = 0; t < 60; t += DT) v += idmAcceleration(v, SPEED_LIMIT, Infinity, 0) * DT;
  assert.ok(Math.abs(v - SPEED_LIMIT) < 0.5, `v=${v}`);
  assert.ok(idmAcceleration(0, SPEED_LIMIT, Infinity, 0) <= IDM.a + 1e-9);
});

test('IDM brakes to a standstill behind a stopped obstacle without reaching it', () => {
  let v = SPEED_LIMIT;
  let x = 0;
  const obstacle = 300;
  for (let t = 0; t < 40; t += DT) {
    const a = Math.max(-IDM.bMax, idmAcceleration(v, SPEED_LIMIT, obstacle - x, 0));
    v = Math.max(0, v + a * DT);
    x += v * DT;
  }
  assert.ok(v < 0.05, `still moving: ${v}`);
  assert.ok(x < obstacle, 'overran obstacle');
  assert.ok(obstacle - x < IDM.s0 + 4, `stopped too early: gap ${obstacle - x}`);
});

test('IDM keeps a larger gap at higher speed', () => {
  // equilibrium: acceleration ~0 when following at the same speed
  const eqGap = (v) => {
    let lo = 1;
    let hi = 400;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (idmAcceleration(v, SPEED_LIMIT * 1.2, mid, v) < 0) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  assert.ok(eqGap(40) > eqGap(10));
});

function mockSim(overrides = {}) {
  return {
    crosswalksClearForAxis: () => true,
    detectorOccupied: () => false,
    hasDemand: () => true,
    pressure: () => 0,
    ...overrides,
  };
}

test('fixed controller cycles through green, amber and all-red with configured durations', () => {
  const timing = { ...DEFAULT_TIMING, greenEW: 10, greenNS: 6, amber: 3, allRed: 1 };
  const c = new SignalController({ i: 0 }, 'fixed', timing);
  const sim = mockSim();
  const seen = [];
  let prev = '';
  for (let t = 0; t < 60; t += DT) {
    c.update(DT, sim);
    const key = `${c.phase}${c.stage}`;
    if (key !== prev) seen.push({ key, t });
    prev = key;
  }
  const keys = seen.slice(0, 7).map((s) => s.key);
  assert.deepEqual(keys, ['0G', '0Y', '0R', '1G', '1Y', '1R', '0G']);
  const dur = (k) => seen[k + 1].t - seen[k].t;
  assert.ok(Math.abs(dur(0) - 10) < 0.11); // EW green
  assert.ok(Math.abs(dur(1) - 3) < 0.11); // amber
  assert.ok(Math.abs(dur(2) - 1) < 0.11); // all-red
  assert.ok(Math.abs(dur(3) - 6) < 0.11); // NS green
});

test('no controller ever shows a non-red light to both axes', () => {
  for (const mode of Object.keys(MODES)) {
    const sim = new Simulation({ mode, demand: 60, seed: 7 });
    for (let k = 0; k < 3000; k++) {
      sim.step();
      for (const c of sim.controllers) {
        assert.ok(c.light(0) === 'r' || c.light(1) === 'r', `${mode} both axes open`);
      }
    }
  }
});

test('actuated controller rests in green without cross-street demand', () => {
  const c = new SignalController({ i: 0 }, 'actuated', { ...DEFAULT_TIMING });
  const sim = mockSim({ hasDemand: () => false });
  for (let t = 0; t < 120; t += DT) c.update(DT, sim);
  assert.equal(c.stage, 'G');
  assert.equal(c.switches, 0);
});

test('actuated controller gaps out after min green and is capped by max green', () => {
  const timing = { ...DEFAULT_TIMING, minGreen: 5, maxGreen: 20, gap: 2 };
  const gapOut = new SignalController({ i: 0 }, 'actuated', timing);
  let t = 0;
  while (gapOut.stage === 'G' && t < 60) {
    gapOut.update(DT, mockSim());
    t += DT;
  }
  assert.ok(t >= 5 && t < 5.2, `gapped out at ${t}`);
  const busy = new SignalController({ i: 0 }, 'actuated', timing);
  t = 0;
  while (busy.stage === 'G' && t < 60) {
    busy.update(DT, mockSim({ detectorOccupied: () => true }));
    t += DT;
  }
  assert.ok(Math.abs(t - 20) < 0.2, `max green at ${t}`);
});

test('max-pressure controller switches towards the higher-pressure phase', () => {
  const timing = { ...DEFAULT_TIMING, minGreen: 5 };
  const c = new SignalController({ i: 0 }, 'pressure', timing);
  const sim = mockSim({ pressure: (_J, axis) => (axis === 0 ? 2 : 8) });
  let t = 0;
  while (c.stage === 'G' && t < 30) {
    c.update(DT, sim);
    t += DT;
  }
  assert.ok(t >= 5 && t < 5.2, `switched at ${t}`);
  const hold = new SignalController({ i: 0 }, 'pressure', timing);
  const sim2 = mockSim({ pressure: (_J, axis) => (axis === 0 ? 8 : 2) });
  for (let k = 0; k < 400; k++) hold.update(DT, sim2);
  assert.equal(hold.stage, 'G');
  assert.equal(hold.phase, 0);
});

test('green wave offsets columns by the travel time between junctions', () => {
  const timing = { ...DEFAULT_TIMING };
  const a = new SignalController({ i: 0 }, 'wave', timing);
  const b = new SignalController({ i: 1 }, 'wave', timing);
  // b should turn green for east-west about 250 px / (0.9 * limit) seconds after a
  const offset = 250 / (SPEED_LIMIT * 0.9);
  const sim = mockSim();
  const greenStart = (c) => {
    // run until next EW green start
    let t = 0;
    let wasGreen = c.light(0) === 'g';
    for (; t < 200; t += DT) {
      c.update(DT, sim);
      const g = c.light(0) === 'g';
      if (g && !wasGreen) return t;
      wasGreen = g;
    }
    return NaN;
  };
  const C = a.cycleLength();
  const ta = greenStart(a);
  const tb = greenStart(b);
  const diff = (((tb - ta) % C) + C) % C;
  assert.ok(Math.abs(diff - offset) < 0.2, `offset ${diff} vs ${offset}`);
});
