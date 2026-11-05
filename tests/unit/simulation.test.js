import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STOPPED_SPEED, axisOf } from '../../src/sim/constants.js';
import { MODES } from '../../src/sim/signals.js';
import { Simulation, congestionLevel, windowMetrics } from '../../src/sim/simulation.js';

const MODE_KEYS = Object.keys(MODES);

function measured(opts, warm = 60, measure = 300) {
  const s = new Simulation(opts);
  s.run(warm);
  const a = s.snapshot();
  s.run(measure);
  return { sim: s, w: windowMetrics(a, s.snapshot()) };
}

test('same seed reproduces identical runs; a different seed does not', () => {
  const a = new Simulation({ seed: 99, mode: 'actuated' });
  const b = new Simulation({ seed: 99, mode: 'actuated' });
  const c = new Simulation({ seed: 100, mode: 'actuated' });
  a.run(120);
  b.run(120);
  c.run(120);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.notDeepEqual(a.snapshot(), c.snapshot());
});

test('vehicles are conserved: spawned = exited + on road', () => {
  const s = new Simulation({ demand: 60 });
  s.run(240);
  assert.equal(s.stats.spawned, s.stats.exited + s.vehicles.length);
  assert.ok(s.stats.exited > 100);
});

for (const mode of MODE_KEYS) {
  test(`${mode}: safety invariants hold every step under heavy load`, () => {
    const s = new Simulation({ mode, demand: 80, pedRate: 24, seed: 11 });
    const onConnectorSince = new Map();
    for (let k = 0; k < 6000; k++) {
      s.step();
      for (const J of s.net.junctions) {
        const ctrl = s.controllers[J.id];
        // pedestrians are only ever on a crosswalk whose road has a red light
        for (let arm = 0; arm < 4; arm++) {
          if (J.crossing[arm] > 0) assert.equal(ctrl.light(axisOf(arm)), 'r', `${mode} ped on green road at ${J.label}`);
        }
      }
      // nobody gets stuck inside a junction box (no box blocking)
      for (const u of s.vehicles) {
        const P = u.route[u.idx];
        if (P.kind !== 'conn') {
          onConnectorSince.delete(u.id);
          continue;
        }
        if (!onConnectorSince.has(u.id)) onConnectorSince.set(u.id, s.t);
        assert.ok(s.t - onConnectorSince.get(u.id) < 12, `${mode} vehicle ${u.id} stuck in ${P.junction.label}`);
      }
    }
    assert.equal(s.stats.collisions, 0, 'vehicle collisions');
    assert.equal(s.stats.pedCollisions, 0, 'pedestrian collisions');
    assert.equal(s.stats.emergencyStops, 0, 'emergency stops');
    assert.ok(s.stats.pedCrossed > 50);
    assert.ok(s.stats.exited > 150);
  });
}

test('vehicles only commit to a junction on green (or a left turn clearing on amber)', () => {
  const s = new Simulation({ mode: 'fixed', demand: 60, seed: 5 });
  const committed = new Set();
  let checked = 0;
  for (let k = 0; k < 4000; k++) {
    s.step();
    for (const J of s.net.junctions) {
      for (let d = 0; d < 4; d++) {
        const u = J.approach[d].committed;
        if (!u || committed.has(`${u.id}:${J.id}`)) continue;
        committed.add(`${u.id}:${J.id}`);
        const light = s.controllers[J.id].light(axisOf(d));
        const turn = u.route[u.idx + 1].turn;
        // commitment happens during this step's decision, before the controller's next update
        assert.ok(light === 'g' || (light === 'y' && turn === 'left'), `committed on ${light} (${turn})`);
        checked++;
      }
    }
  }
  assert.ok(checked > 300, `only ${checked} commitments observed`);
});

test('queues form at red lights and discharge on green', () => {
  const s = new Simulation({ mode: 'fixed', demand: 60, seed: 3 });
  s.run(90);
  const q = s.junctionQueues();
  assert.ok(q.some((j) => j.total > 0), 'some queue exists');
  // every stopped vehicle at the head of a queue is facing a red, or is yielding
  for (const J of s.net.junctions) {
    for (let d = 0; d < 4; d++) {
      const u = J.approach[d].vehicles[0];
      if (u && u.v < STOPPED_SPEED && J.approach[d].len - u.s < 3 && s.controllers[J.id].light(axisOf(d)) === 'g') {
        assert.equal(u.permit, false, 'stopped at green line only when denied (yield, peds, or spillback)');
      }
    }
  }
});

test('adaptive control reduces delay versus fixed timing (averaged over seeds)', () => {
  const seeds = [1337, 1, 2, 3];
  const avgDelay = (opts) => seeds.reduce((a, seed) => a + measured({ ...opts, seed }).w.avgDelay, 0) / seeds.length;
  const fixedLight = avgDelay({ demand: 15, mode: 'fixed' });
  const actLight = avgDelay({ demand: 15, mode: 'actuated' });
  const mpLight = avgDelay({ demand: 15, mode: 'pressure' });
  assert.ok(actLight < fixedLight * 0.85, `light: actuated ${actLight} vs fixed ${fixedLight}`);
  assert.ok(mpLight < fixedLight * 0.85, `light: pressure ${mpLight} vs fixed ${fixedLight}`);
  const fixedMid = avgDelay({ demand: 45, mode: 'fixed' });
  const mpMid = avgDelay({ demand: 45, mode: 'pressure' });
  assert.ok(mpMid < fixedMid * 0.95, `default: pressure ${mpMid} vs fixed ${fixedMid}`);
});

test('congestion-aware routing produces valid trips', () => {
  const s = new Simulation({ demand: 70, smartRouting: true, seed: 21 });
  s.run(200);
  assert.ok(s.stats.exited > 100);
  assert.equal(s.stats.collisions, 0);
});

test('demand and pedestrians can be changed while running', () => {
  const s = new Simulation({ demand: 10 });
  s.run(30);
  s.setDemand(80, 0.7);
  s.run(60);
  assert.ok(s.vehicles.length > 15);
  s.setPedestrians(false);
  assert.equal(s.peds.length, 0);
  s.run(10);
  assert.equal(s.peds.length, 0);
  for (const J of s.net.junctions) assert.deepEqual(J.crossing, [0, 0, 0, 0]);
});

test('extreme demand saturates gracefully without NaN or collisions', () => {
  const s = new Simulation({ demand: 90, ewShare: 0.8, mode: 'pressure', seed: 2 });
  s.run(400);
  const m = s.metrics();
  for (const [k, v] of Object.entries(m)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k}=${v}`);
  assert.equal(m.collisions, 0);
  assert.ok(['heavy', 'gridlock'].includes(congestionLevel(m).key));
});

test('timing changes apply to running controllers', () => {
  const s = new Simulation({ mode: 'fixed' });
  s.timing.greenEW = 30;
  for (const c of s.controllers) assert.equal(c.green(0), 30);
});

test('performance: a step with ~100 vehicles stays well under a frame budget', () => {
  const s = new Simulation({ demand: 90, seed: 4 });
  s.run(150);
  assert.ok(s.vehicles.length > 80, `only ${s.vehicles.length} vehicles`);
  const t0 = performance.now();
  const N = 1200;
  for (let k = 0; k < N; k++) s.step();
  const per = (performance.now() - t0) / N;
  assert.ok(per < 1.5, `${per.toFixed(3)} ms per step`);
});

test('unknown mode is rejected', () => {
  assert.throws(() => new Simulation({ mode: 'nope' }), /Unknown signal mode/);
});

test('junctions carry Addis Ababa names', () => {
  const s = new Simulation();
  const names = s.net.junctions.map((J) => J.label);
  assert.deepEqual(names, ['Piassa', 'Arat Kilo', 'Megenagna', 'Mexico', 'Meskel Square', 'Kazanchis', 'Sarbet', 'Gotera', 'Bole']);
  assert.equal(s.net.junctions[4].code, 'B2');
});

test('minibus taxis appear at the configured share and none when disabled', () => {
  const s = new Simulation({ taxiShare: 0.4, demand: 60, seed: 8 });
  s.run(120);
  let taxis = 0;
  let total = 0;
  const seen = new Set();
  for (let k = 0; k < 2400; k++) {
    s.step();
    for (const u of s.vehicles) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      total++;
      if (u.kind === 'taxi') taxis++;
    }
  }
  assert.ok(Math.abs(taxis / total - 0.4) < 0.08, `taxi share ${taxis / total}`);
  const none = new Simulation({ taxiShare: 0 });
  none.run(120);
  assert.equal(none.vehicles.filter((u) => u.kind === 'taxi').length, 0);
  assert.equal(none.stats.taxiStops, 0);
});

test('taxis stop at the kerb, dwell, then continue, without reserving a junction meanwhile', () => {
  const s = new Simulation({ taxiShare: 0.5, demand: 50, seed: 12 });
  const dwellStart = new Map();
  const dwellTime = [];
  for (let k = 0; k < 6000; k++) {
    s.step();
    for (const J of s.net.junctions) {
      for (let d = 0; d < 4; d++) {
        const link = J.approach[d];
        if (link.committed) assert.equal(s.pendingCurb(link.committed, link), null, 'taxi committed with a pending kerb stop');
      }
    }
    for (const u of s.vehicles) {
      if (u.kind !== 'taxi') continue;
      if (u.dwelling && !dwellStart.has(u.id)) dwellStart.set(u.id, s.t);
      if (!u.dwelling && dwellStart.has(u.id)) {
        dwellTime.push(s.t - dwellStart.get(u.id));
        dwellStart.delete(u.id);
        assert.ok(u.v < 10, 'pulls away from a standstill');
      }
      if (u.dwelling) assert.ok(u.v < 2.1, 'dwelling taxis are stopped');
    }
  }
  assert.ok(s.stats.taxiStops > 40, `only ${s.stats.taxiStops} stops`);
  const avg = dwellTime.reduce((a, b) => a + b, 0) / dwellTime.length;
  assert.ok(avg > 2.5 && avg < 9, `average dwell ${avg}`);
  assert.equal(s.stats.collisions, 0);
  assert.equal(s.stats.pedCollisions, 0);
  assert.equal(s.stats.emergencyStops, 0);
});

test('kerbside taxi stops add delay to the traffic behind them', () => {
  const delay = (taxiShare) => {
    const s = new Simulation({ taxiShare, demand: 45, seed: 1337 });
    s.run(60);
    const a = s.snapshot();
    s.run(300);
    return windowMetrics(a, s.snapshot()).avgDelay;
  };
  assert.ok(delay(0.5) > delay(0) * 1.2);
});

test('kerb stops leave room for a queued vehicle to clear the junction behind the taxi', () => {
  const s = new Simulation({ taxiShare: 1, seed: 4 });
  let checked = 0;
  for (const entry of s.net.entries) {
    for (const exit of s.entries[0].dests.slice(0, 4)) {
      const route = s.routeFor(entry, exit);
      if (!route) continue;
      for (const [id, st] of s.planCurbStops(route)) {
        const link = s.net.links[id];
        // taxi rear, minus a 22-unit van and its jam gap, must still be past the crosswalk
        assert.ok(st.s - 19 - 22 - 8 >= 9, `stop at ${st.s} on link ${id}`);
        assert.ok(st.s <= link.len - 30);
        checked++;
      }
    }
  }
  assert.ok(checked > 10);
});

test('calibration: queue discharge matches Addis Ababa start-up lost time and saturation flow', async () => {
  const { queueDischarge } = await import('../../src/sim/calibration.js');
  const q = queueDischarge();
  // targets: 2.51 s start-up lost time (AAU thesis), 1900 veh/h saturation flow (Frontiers 2024)
  assert.ok(Math.abs(q.startUpLostTime - 2.51) < 0.3, `lost time ${q.startUpLostTime}`);
  assert.ok(Math.abs(q.saturationFlow - 1900) < 120, `saturation flow ${q.saturationFlow}`);
});

test('desired speeds follow the observed Addis distribution within legal limits', () => {
  const s = new Simulation({ seed: 3 });
  const v = Array.from({ length: 4000 }, () => (s.desiredSpeed() / 4) * 3.6);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  assert.ok(Math.min(...v) >= 35 && Math.max(...v) <= 70);
  assert.ok(mean > 50 && mean < 58, `mean ${mean}`);
});
