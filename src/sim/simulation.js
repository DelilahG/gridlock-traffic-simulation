import {
  COMMIT_DECEL,
  CROSSWALK,
  DIRS,
  DT,
  IDM,
  LEFT_TURN_GAP,
  PED,
  ROAD_HALF,
  SPEED_LIMIT,
  STOPPED_SPEED,
  axisOf,
  opposite,
  toKmh,
} from './constants.js';
import { boxesOverlap } from './geometry.js';
import { buildNetwork, destinationsFor, findRoute, freeFlowTime, isStraightThrough } from './network.js';
import { createRng, exponential } from './rng.js';
import { DEFAULT_TIMING, MODES, SignalController } from './signals.js';

export const DEFAULTS = {
  mode: 'fixed',
  seed: 1337,
  demand: 45, // vehicles per minute entering the whole network
  ewShare: 0.5, // fraction of demand entering on east-west roads
  pedestrians: true,
  pedRate: 12, // pedestrians per minute across the network
  smartRouting: false, // re-plan routes around queues at departure time
};

const LOOKAHEAD = 400;

// Intelligent Driver Model acceleration towards a leader `gap` px ahead moving at `leaderV`.
export function idmAcceleration(v, v0, gap, leaderV, s0 = IDM.s0) {
  const { a, b, T, delta } = IDM;
  const free = 1 - Math.pow(v / v0, delta);
  if (gap === Infinity) return a * free;
  const dv = v - leaderV;
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
  const g = Math.max(gap, 0.01);
  return a * (free - (sStar / g) ** 2);
}

export class Simulation {
  constructor(options = {}) {
    const o = { ...DEFAULTS, ...options };
    if (!MODES[o.mode]) throw new Error(`Unknown signal mode: ${o.mode}`);
    this.mode = o.mode;
    this.seed = o.seed;
    this.demand = o.demand;
    this.ewShare = o.ewShare;
    this.pedestrians = o.pedestrians;
    this.pedRate = o.pedRate;
    this.smartRouting = o.smartRouting;
    this.timing = { ...DEFAULT_TIMING, ...(options.timing || {}) };
    this.rand = createRng(o.seed);
    this.net = buildNetwork();
    this.controllers = this.net.junctions.map((J) => new SignalController(J, this.mode, this.timing));
    this.paths = [...this.net.links, ...this.net.connectors];
    this.capacity = this.net.links.reduce((n, l) => n + l.capacity, 0);
    this.vehicles = [];
    this.peds = [];
    this.t = 0;
    this.stepCount = 0;
    this.nextId = 1;
    this.routeCache = new Map();
    this.entries = this.net.entries.map((link) => ({
      link,
      pending: 0,
      clock: 0,
      dests: destinationsFor(this.net, link),
    }));
    for (const e of this.entries) e.clock = exponential(this.rand, this.entryRate(e));
    this.pedClock = exponential(this.rand, this.pedRate / 60);
    this.stats = {
      spawned: 0,
      exited: 0,
      sumTrip: 0,
      sumDelay: 0,
      sumStopped: 0,
      sumStops: 0,
      collisions: 0,
      pedCollisions: 0,
      emergencyStops: 0,
      pedCrossed: 0,
      sumPedWait: 0,
      vehicleSeconds: 0,
      pendingSeconds: 0,
    };
    this.exitTimes = [];
    this.history = [];
    this.histClock = 0;
    this.overlaps = new Set();
  }

  /* ---------------- demand ---------------- */

  entryRate(e) {
    const share = axisOf(e.link.dir) === 0 ? this.ewShare : 1 - this.ewShare;
    const perAxis = this.entries.length / 2;
    return Math.max(1e-6, ((this.demand / 60) * share) / perAxis);
  }

  setDemand(demand, ewShare = this.ewShare) {
    this.demand = demand;
    this.ewShare = ewShare;
    for (const e of this.entries) e.clock = exponential(this.rand, this.entryRate(e));
  }

  setPedestrians(on) {
    this.pedestrians = on;
    if (!on) {
      this.peds.length = 0;
      for (const J of this.net.junctions) J.crossing.fill(0);
    }
  }

  routeFor(entry, exit) {
    if (this.smartRouting) {
      // Penalise links by the number of queued vehicles (~2.2 s of discharge per car).
      return findRoute(this.net, entry, exit, (link) => {
        let q = 0;
        for (const u of link.vehicles) if (u.v < STOPPED_SPEED) q++;
        return q * 2.2;
      });
    }
    const key = entry.id * 1000 + exit.id;
    let r = this.routeCache.get(key);
    if (!r) {
      r = findRoute(this.net, entry, exit);
      this.routeCache.set(key, r);
    }
    return r;
  }

  pickDestination(e) {
    // Through traffic is three times as likely as any single turning destination.
    let total = 0;
    const w = e.dests.map((x) => {
      const wt = isStraightThrough(e.link, x) ? 3 : 1;
      total += wt;
      return wt;
    });
    let r = this.rand() * total;
    for (let k = 0; k < w.length; k++) {
      r -= w[k];
      if (r <= 0) return e.dests[k];
    }
    return e.dests[e.dests.length - 1];
  }

  spawn(dt) {
    for (const e of this.entries) {
      e.clock -= dt;
      while (e.clock <= 0) {
        e.pending++;
        e.clock += exponential(this.rand, this.entryRate(e));
      }
      if (e.pending > 0 && this.trySpawn(e)) e.pending--;
      this.stats.pendingSeconds += e.pending * dt;
    }
  }

  trySpawn(e) {
    const link = e.link;
    const last = link.vehicles[link.vehicles.length - 1];
    const van = this.rand() < 0.08;
    const len = van ? 22 : 15 + Math.floor(this.rand() * 3);
    if (last && last.s - last.len < len + IDM.s0 + 2) return false;
    const exit = this.pickDestination(e);
    const route = this.routeFor(link, exit);
    if (!route) return false;
    const v0 = SPEED_LIMIT * (van ? 0.85 : 0.88 + this.rand() * 0.22);
    const u = {
      id: this.nextId++,
      kind: van ? 'van' : 'car',
      len,
      wid: van ? 8 : 7,
      v0,
      v: last ? Math.min(last.v, v0 * 0.8) : v0 * 0.8,
      acc: 0,
      s: len,
      route,
      idx: 0,
      permit: false,
      born: this.t,
      freeTime: freeFlowTime(route, v0),
      stopT: 0,
      stops: 0,
      wasStopped: false,
      hue: Math.floor(this.rand() * 360),
      x: 0,
      y: 0,
      ang: 0,
    };
    link.vehicles.push(u);
    this.vehicles.push(u);
    this.stats.spawned++;
    return true;
  }

  /* ---------------- junction logic ---------------- */

  nextConnector(u) {
    return u.route[u.idx + 1];
  }

  conflictFree(conn) {
    for (const c of conn.conflicts) {
      if (c.vehicles.length) return false;
      const cm = c.from.committed;
      if (cm && this.nextConnector(cm) === c) return false;
    }
    return true;
  }

  downstreamSpace(conn, u) {
    const L = conn.to;
    const last = L.vehicles[L.vehicles.length - 1];
    let rear = last ? last.s - last.len : L.len;
    for (const c of L.inbound) {
      for (const w of c.vehicles) rear -= w.len + IDM.s0;
      const cm = c.from.committed;
      if (cm && cm !== u && this.nextConnector(cm) === c) rear -= cm.len + IDM.s0;
    }
    return rear >= CROSSWALK + u.len + IDM.s0;
  }

  crosswalksFree(conn) {
    const J = conn.junction;
    return J.crossing[conn.arms[0]] === 0 && J.crossing[conn.arms[1]] === 0;
  }

  // Permissive left turn: accept the gap only if no opposing through/right vehicle
  // can reach the junction within LEFT_TURN_GAP seconds.
  leftGapOk(link, ctrl) {
    const opp = link.to.approach[opposite(link.dir)];
    const oppGreen = ctrl.light(axisOf(opp.dir)) === 'g';
    for (const w of opp.vehicles) {
      const d = opp.len - w.s;
      if (d > SPEED_LIMIT * 1.15 * LEFT_TURN_GAP) break;
      if (opp.committed === w) return false;
      if (this.nextConnector(w).turn === 'left') continue;
      if (!oppGreen) continue;
      if (w.v > 1 && d / w.v < LEFT_TURN_GAP) return false;
      if (w.v <= 1 && w.permit && d < 20) return false;
    }
    return true;
  }

  // Decide, for the front vehicle of every approach, whether it may enter the junction.
  decide() {
    for (const J of this.net.junctions) {
      const ctrl = this.controllers[J.id];
      for (let d = 0; d < 4; d++) {
        const link = J.approach[d];
        const u = link.vehicles[0];
        if (!u) continue;
        for (let k = 1; k < link.vehicles.length; k++) link.vehicles[k].permit = false;
        if (link.committed === u) {
          u.permit = true;
          continue;
        }
        const dist = link.len - u.s;
        const light = ctrl.light(axisOf(d));
        if (dist > 260) {
          u.permit = light === 'g';
          continue;
        }
        const conn = this.nextConnector(u);
        // A left-turner already waiting at the line may clear on amber.
        let ok = light === 'g' || (light === 'y' && conn.turn === 'left' && dist < 6 && u.v < 2);
        ok =
          ok &&
          this.conflictFree(conn) &&
          this.downstreamSpace(conn, u) &&
          this.crosswalksFree(conn) &&
          (conn.turn !== 'left' || this.leftGapOk(link, ctrl));
        u.permit = ok;
        if (ok && dist <= (u.v * u.v) / (2 * COMMIT_DECEL) + 4) link.committed = u;
      }
    }
  }

  /* ---------------- vehicle dynamics ---------------- */

  siblingGap(conn, offset) {
    // Vehicles on other movements from the same approach still occupy the shared
    // crosswalk segment until their rear clears it.
    let gap = Infinity;
    let lv = 0;
    for (const sib of conn.siblings) {
      const w = sib.vehicles[sib.vehicles.length - 1];
      if (!w) continue;
      const rear = w.s - w.len;
      if (rear < CROSSWALK + 2) {
        const g = offset + rear;
        if (g < gap && g > -w.len) ((gap = g), (lv = w.v));
      }
    }
    return [gap, lv];
  }

  lookahead(u, P) {
    const dist = P.len - u.s;
    if (P.kind === 'link') {
      if (P.isExit) return Infinity;
      if (!u.permit) return idmAcceleration(u.v, u.v0, dist, 0, IDM.sLine);
      const C = this.nextConnector(u);
      let [gap, lv] = this.siblingGap(C, dist);
      const last = C.vehicles[C.vehicles.length - 1];
      if (last) {
        const g = dist + last.s - last.len;
        if (g < gap) ((gap = g), (lv = last.v));
      } else {
        const l2 = C.to.vehicles[C.to.vehicles.length - 1];
        if (l2) {
          const g = dist + C.len + l2.s - l2.len;
          if (g < gap) ((gap = g), (lv = l2.v));
        }
      }
      return gap < LOOKAHEAD ? idmAcceleration(u.v, u.v0, gap, lv) : Infinity;
    }
    // On a connector: follow the tail of the next link.
    let [gap, lv] = this.siblingGap(P, -u.s);
    if (gap < 0) gap = Infinity; // that vehicle is behind us
    const L = u.route[u.idx + 1];
    const l2 = L.vehicles[L.vehicles.length - 1];
    if (l2) {
      const g = dist + l2.s - l2.len;
      if (g < gap) ((gap = g), (lv = l2.v));
    }
    return gap < LOOKAHEAD ? idmAcceleration(u.v, u.v0, gap, lv) : Infinity;
  }

  computeAccelerations() {
    for (const P of this.paths) {
      const list = P.vehicles;
      for (let k = 0; k < list.length; k++) {
        const u = list[k];
        let acc = idmAcceleration(u.v, u.v0, Infinity, 0);
        if (k > 0) {
          const l = list[k - 1];
          acc = Math.min(acc, idmAcceleration(u.v, u.v0, l.s - l.len - u.s, l.v));
        } else {
          acc = Math.min(acc, this.lookahead(u, P));
        }
        u.acc = Math.max(-IDM.bMax, Math.min(IDM.a, acc));
      }
    }
  }

  integrate(dt) {
    for (const u of this.vehicles) {
      const a = u.acc;
      const nv = u.v + a * dt;
      if (nv < 0) {
        u.s += a < 0 ? -(u.v * u.v) / (2 * a) : 0;
        u.v = 0;
      } else {
        u.s += u.v * dt + 0.5 * a * dt * dt;
        u.v = nv;
      }
      if (u.v < STOPPED_SPEED) {
        u.stopT += dt;
        if (!u.wasStopped) {
          u.stops++;
          u.wasStopped = true;
        }
      } else if (u.v > 2 * STOPPED_SPEED) u.wasStopped = false;
    }
  }

  advance() {
    let removed = false;
    for (const P of this.paths) {
      const list = P.vehicles;
      // Safety net: followers can never overlap their leader on the same path.
      for (let k = 1; k < list.length; k++) {
        const l = list[k - 1];
        const u = list[k];
        const maxS = l.s - l.len - 0.3;
        if (u.s > maxS) {
          u.s = maxS;
          if (u.v > l.v) u.v = l.v;
        }
      }
      while (list.length && list[0].s >= P.len) {
        const u = list[0];
        if (P.kind === 'link') {
          if (P.isExit) {
            list.shift();
            this.retire(u);
            removed = true;
            continue;
          }
          if (P.committed !== u) {
            // Should not happen: drivers only reach the line after committing.
            u.s = P.len;
            u.v = 0;
            this.stats.emergencyStops++;
            break;
          }
          P.committed = null;
        }
        list.shift();
        u.s -= P.len;
        u.idx++;
        u.permit = false;
        u.route[u.idx].vehicles.push(u);
      }
    }
    if (removed) this.vehicles = this.vehicles.filter((u) => !u.done);
  }

  retire(u) {
    u.done = true;
    const trip = this.t - u.born;
    const s = this.stats;
    s.exited++;
    s.sumTrip += trip;
    s.sumDelay += Math.max(0, trip - u.freeTime);
    s.sumStopped += u.stopT;
    s.sumStops += u.stops;
    this.exitTimes.push(this.t);
  }

  updatePoses() {
    for (const u of this.vehicles) u.route[u.idx].path.pointAt(u.s - u.len / 2, u);
  }

  /* ---------------- pedestrians ---------------- */

  crossTime(speed) {
    return (2 * PED.span) / speed;
  }

  crosswalkClearOfVehicles(J, arm) {
    for (const c of J.connectors) {
      if (c.arms[0] !== arm && c.arms[1] !== arm) continue;
      if (c.vehicles.length) return false;
      const cm = c.from.committed;
      if (cm && this.nextConnector(cm) === c) return false;
    }
    const ex = J.exit[arm].vehicles;
    for (let k = ex.length - 1; k >= 0; k--) {
      if (ex[k].s - ex[k].len < CROSSWALK + 1) return false;
      break;
    }
    for (let d = 0; d < 4; d++) {
      const ap = J.approach[d];
      const u = ap.vehicles[0];
      if (!u) continue;
      const c = this.nextConnector(u);
      if (c.arms[0] !== arm && c.arms[1] !== arm) continue;
      const dist = ap.len - u.s;
      if (u.permit && dist < (u.v * u.v) / (2 * COMMIT_DECEL) + 12) return false;
    }
    return true;
  }

  canStartCrossing(J, arm, crossTime) {
    const ctrl = this.controllers[J.id];
    const axis = axisOf(arm); // the road this crosswalk crosses
    if (ctrl.stage !== 'G' || ctrl.phase === axis) return false;
    const limit = ctrl.mode === 'fixed' || ctrl.mode === 'wave' ? ctrl.green(ctrl.phase) : this.timing.maxGreen;
    if (ctrl.t + crossTime > limit) return false;
    return this.crosswalkClearOfVehicles(J, arm);
  }

  crosswalksClearForAxis(J, axis) {
    for (let a = 0; a < 4; a++) if (axisOf(a) === axis && J.crossing[a] > 0) return false;
    return true;
  }

  updatePeds(dt) {
    this.pedClock -= dt;
    while (this.pedClock <= 0) {
      this.pedClock += exponential(this.rand, Math.max(1e-6, this.pedRate / 60));
      const waiting = this.peds.reduce((n, p) => n + (p.state === 'wait' ? 1 : 0), 0);
      if (waiting < PED.maxWaiting) {
        const J = this.net.junctions[Math.floor(this.rand() * this.net.junctions.length)];
        this.peds.push({
          id: this.nextId++,
          J,
          arm: Math.floor(this.rand() * 4),
          side: this.rand() < 0.5 ? 1 : -1,
          speed: PED.speedMin + this.rand() * (PED.speedMax - PED.speedMin),
          jitter: (this.rand() - 0.5) * 5,
          state: 'wait',
          wait: 0,
          prog: 0,
          x: 0,
          y: 0,
        });
      }
    }
    for (let k = this.peds.length - 1; k >= 0; k--) {
      const p = this.peds[k];
      const J = p.J;
      if (p.state === 'wait') {
        p.wait += dt;
        const ct = this.crossTime(p.speed);
        if (this.canStartCrossing(J, p.arm, ct)) {
          p.state = 'cross';
          J.crossing[p.arm]++;
          const ctrl = this.controllers[J.id];
          ctrl.pedHold = Math.max(ctrl.pedHold, ctrl.t + ct + 0.5);
        }
      } else {
        p.prog += p.speed * dt;
        if (p.prog >= 2 * PED.span) {
          J.crossing[p.arm]--;
          this.stats.pedCrossed++;
          this.stats.sumPedWait += p.wait;
          this.peds.splice(k, 1);
          continue;
        }
      }
      // pose
      const [ux, uy] = DIRS[p.arm];
      const cx = J.x + ux * (ROAD_HALF + CROSSWALK / 2) + ux * p.jitter * 0.4;
      const cy = J.y + uy * (ROAD_HALF + CROSSWALK / 2) + uy * p.jitter * 0.4;
      const along = p.state === 'wait' ? -p.side * (PED.span + 3) : p.side * (p.prog - PED.span);
      p.x = cx - uy * along;
      p.y = cy + ux * along;
    }
  }

  /* ---------------- safety audit ---------------- */

  // Independent check: counts genuine overlaps between vehicle bodies (and
  // between vehicles and pedestrians). The driving logic never reads this.
  detectCollisions() {
    const cell = 32;
    const grid = new Map();
    const boxes = this.vehicles.map((u) => ({
      u,
      x: u.x,
      y: u.y,
      ang: u.ang,
      hl: u.len / 2 - 0.6,
      hw: u.wid / 2 - 0.6,
    }));
    for (const b of boxes) {
      const key = Math.floor(b.x / cell) * 1000 + Math.floor(b.y / cell);
      let arr = grid.get(key);
      if (!arr) grid.set(key, (arr = []));
      arr.push(b);
    }
    const now = new Set();
    const check = (b, cx, cy, isPed) => {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const arr = grid.get(gx * 1000 + gy);
          if (!arr) continue;
          for (const o of arr) {
            if (!isPed && o.u.id <= b.u.id) continue;
            if (!boxesOverlap(b, o)) continue;
            const key = isPed ? `p${b.id}-${o.u.id}` : `${b.u.id}-${o.u.id}`;
            now.add(key);
            if (!this.overlaps.has(key)) {
              if (isPed) this.stats.pedCollisions++;
              else this.stats.collisions++;
            }
          }
        }
      }
    };
    for (const b of boxes) check(b, Math.floor(b.x / cell), Math.floor(b.y / cell), false);
    this.peds.forEach((p) => {
      if (p.state !== 'cross') return;
      const b = { id: p.id, x: p.x, y: p.y, ang: 0, hl: 1.5, hw: 1.5 };
      check(b, Math.floor(p.x / cell), Math.floor(p.y / cell), true);
    });
    this.overlaps = now;
  }

  /* ---------------- signal-controller sensors ---------------- */

  detectorOccupied(J, axis) {
    for (let d = 0; d < 4; d++) {
      if (axisOf(d) !== axis) continue;
      const ap = J.approach[d];
      for (const u of ap.vehicles) {
        if (ap.len - u.s > 140) break;
        if (u.v > 2 || u.permit) return true;
      }
    }
    return false;
  }

  // Advance detection: anything on the approach link, or already turning into it
  // at the upstream junction, places a call for this phase.
  hasDemand(J, axis) {
    for (let d = 0; d < 4; d++) {
      if (axisOf(d) !== axis) continue;
      const ap = J.approach[d];
      if (ap.vehicles.length) return true;
      for (const c of ap.inbound) if (c.vehicles.length) return true;
    }
    // Pedestrians waiting to cross the other road need this phase.
    for (const p of this.peds) if (p.J === J && p.state === 'wait' && p.wait > PED.callAfter && axisOf(p.arm) !== axis) return true;
    return false;
  }

  pressure(J, axis) {
    let p = 0;
    for (let d = 0; d < 4; d++) {
      if (axisOf(d) !== axis) continue;
      for (const u of J.approach[d].vehicles) {
        const out = u.route[u.idx + 2];
        p += 1 - Math.min(1, out.vehicles.length / out.capacity);
      }
    }
    return p;
  }

  /* ---------------- main loop ---------------- */

  step(dt = DT) {
    this.t += dt;
    this.stepCount++;
    this.spawn(dt);
    for (const c of this.controllers) c.update(dt, this);
    this.decide();
    this.computeAccelerations();
    this.integrate(dt);
    this.advance();
    this.updatePoses();
    if (this.pedestrians) this.updatePeds(dt);
    if (this.stepCount % 2 === 0) this.detectCollisions();
    this.stats.vehicleSeconds += this.vehicles.length * dt;
    this.histClock += dt;
    if (this.histClock >= 1) {
      this.histClock -= 1;
      const m = this.metrics();
      this.history.push({ t: this.t, speed: m.avgSpeed, stopped: m.stopped, onRoad: m.onRoad });
      if (this.history.length > 180) this.history.shift();
    }
  }

  run(seconds, dt = DT) {
    const n = Math.round(seconds / dt);
    for (let k = 0; k < n; k++) this.step(dt);
  }

  /* ---------------- reporting ---------------- */

  junctionQueues() {
    return this.net.junctions.map((J) => {
      const q = [0, 0, 0, 0];
      for (let d = 0; d < 4; d++) for (const u of J.approach[d].vehicles) if (u.v < STOPPED_SPEED) q[d]++;
      return { J, q, total: q[0] + q[1] + q[2] + q[3] };
    });
  }

  metrics() {
    let sum = 0;
    let ratio = 0;
    let stopped = 0;
    for (const u of this.vehicles) {
      sum += u.v;
      ratio += u.v / u.v0;
      if (u.v < STOPPED_SPEED) stopped++;
    }
    const n = this.vehicles.length;
    while (this.exitTimes.length && this.exitTimes[0] < this.t - 60) this.exitTimes.shift();
    const win = Math.min(60, this.t) || 1;
    const s = this.stats;
    const pending = this.entries.reduce((a, e) => a + e.pending, 0);
    return {
      t: this.t,
      onRoad: n,
      stopped,
      pending,
      avgSpeed: n ? toKmh(sum / n) : 0,
      congestion: n ? 1 - ratio / n : 0,
      occupancy: n / this.capacity,
      throughput: (this.exitTimes.length * 60) / win,
      exited: s.exited,
      avgTrip: s.exited ? s.sumTrip / s.exited : null,
      avgDelay: s.exited ? s.sumDelay / s.exited : null,
      avgStopped: s.exited ? s.sumStopped / s.exited : null,
      stopsPerTrip: s.exited ? s.sumStops / s.exited : null,
      collisions: s.collisions,
      pedCollisions: s.pedCollisions,
      emergencyStops: s.emergencyStops,
      pedCrossed: s.pedCrossed,
      pedWaiting: this.peds.filter((p) => p.state === 'wait').length,
      avgPedWait: s.pedCrossed ? s.sumPedWait / s.pedCrossed : null,
    };
  }

  snapshot() {
    return { t: this.t, ...this.stats };
  }
}

// Aggregate metrics between two snapshots (used to exclude warm-up).
export function windowMetrics(a, b) {
  const exited = b.exited - a.exited;
  const minutes = (b.t - a.t) / 60;
  const per = (k) => (exited ? (b[k] - a[k]) / exited : null);
  const peds = b.pedCrossed - a.pedCrossed;
  return {
    throughput: exited / minutes,
    avgTrip: per('sumTrip'),
    avgDelay: per('sumDelay'),
    avgStopped: per('sumStopped'),
    stopsPerTrip: per('sumStops'),
    avgOnRoad: (b.vehicleSeconds - a.vehicleSeconds) / (b.t - a.t),
    avgPending: (b.pendingSeconds - a.pendingSeconds) / (b.t - a.t),
    avgPedWait: peds ? (b.sumPedWait - a.sumPedWait) / peds : null,
    collisions: b.collisions - a.collisions + (b.pedCollisions - a.pedCollisions),
    emergencyStops: b.emergencyStops - a.emergencyStops,
  };
}

// Network state from how full the links are and whether queues spill back to
// the entry points (a stopped car at a red light alone is not congestion).
export function congestionLevel(m) {
  if (m.onRoad === 0) return { key: 'idle', label: 'No traffic' };
  if (m.occupancy > 0.28 || m.pending > 25) return { key: 'gridlock', label: 'Gridlock' };
  if (m.occupancy > 0.16 || m.pending > 8) return { key: 'heavy', label: 'Heavy' };
  if (m.occupancy > 0.08) return { key: 'busy', label: 'Busy' };
  return { key: 'free', label: 'Free flow' };
}
