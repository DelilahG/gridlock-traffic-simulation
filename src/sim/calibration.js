// Queue-discharge experiment (Highway Capacity Manual method) used to calibrate
// the car-following model against start-up lost time measured in Addis Ababa.
import { DT, IDM, SPEED_LIMIT } from './constants.js';
import { Simulation } from './simulation.js';

/**
 * Queue `n` identical cars at a red light, switch to green, and record when
 * each front bumper crosses the stop line. Returns per-vehicle headways, the
 * saturation headway (mean from the 5th vehicle on) and start-up lost time
 * (sum over the first four of headway minus saturation headway).
 */
export function queueDischarge({ n = 12, idm = {} } = {}) {
  const saved = { ...IDM };
  Object.assign(IDM, idm);
  try {
    const sim = new Simulation({ mode: 'fixed', demand: 1e-6, pedestrians: false, taxiShare: 0, seed: 1 });
    sim.timing.greenEW = 1e9; // hold east-west green once it starts
    const J = sim.net.junctions[4];
    const ctrl = sim.controllers[J.id];
    Object.assign(ctrl, { phase: 1, stage: 'G', t: 0 }); // north-south green, east-west red
    sim.timing.greenNS = 2; // switch soon
    const link = J.approach[0]; // eastbound approach
    const entry = sim.net.links.find((l) => l.isEntry && l.dir === 0 && Math.abs(l.path.pts[0][1] - link.path.pts[0][1]) < 1);
    const exit = sim.net.links.find((l) => l.isExit && l.dir === 0 && Math.abs(l.path.pts[0][1] - link.path.pts[0][1]) < 1);
    const route = sim.routeFor(entry, exit);
    const idx = route.indexOf(link);
    const len = 16;
    for (let k = 0; k < n; k++) {
      const u = {
        id: sim.nextId++, kind: 'car', len, wid: 7, v0: SPEED_LIMIT, v: 0, acc: 0,
        s: link.len - IDM.sLine - k * (len + IDM.s0), route, idx, permit: false, born: 0,
        freeTime: 1, stopT: 0, stops: 0, wasStopped: true, hue: 0, curb: null, dwelling: false, x: 0, y: 0, ang: 0,
      };
      link.vehicles.push(u);
      sim.vehicles.push(u);
    }
    const ids = link.vehicles.map((u) => u.id);
    const crossed = new Map();
    let greenAt = null;
    for (let step = 0; step < 4000 && crossed.size < n; step++) {
      sim.step(DT);
      if (greenAt === null && ctrl.light(0) === 'g') greenAt = sim.t - DT;
      for (const u of sim.vehicles) if (!crossed.has(u.id) && u.route[u.idx] !== link && ids.includes(u.id)) crossed.set(u.id, sim.t);
    }
    const times = ids.map((id) => crossed.get(id));
    const headways = times.map((t, i) => t - (i ? times[i - 1] : greenAt));
    const sat = headways.slice(4).reduce((a, b) => a + b, 0) / (n - 4);
    const lost = headways.slice(0, 4).reduce((a, h) => a + (h - sat), 0);
    return { headways, saturationHeadway: sat, saturationFlow: 3600 / sat, startUpLostTime: lost };
  } finally {
    Object.assign(IDM, saved);
  }
}
