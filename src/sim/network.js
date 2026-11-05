import {
  BOUNDARY_PAD,
  COLS,
  CROSSWALK,
  DIRS,
  IDM,
  LANE_OFF,
  ROAD_HALF,
  ROWS,
  SPEED_LIMIT,
  STOP_OFF,
  WORLD,
  axisOf,
  leftOf,
  opposite,
  rightOf,
} from './constants.js';
import { Path, arcPoints, minPathDistance } from './geometry.js';

// Lateral offset of the lane used by traffic heading in direction d (right-hand traffic).
function laneOffset(d) {
  const [dx, dy] = DIRS[d];
  return [-dy * LANE_OFF, dx * LANE_OFF];
}

// Well-known central Addis Ababa junctions, placed roughly by compass direction
// (north at the top). The grid is stylised: distances and street layout are not to scale.
export const JUNCTION_NAMES = [
  ['Piassa', 'Arat Kilo', 'Megenagna'],
  ['Mexico', 'Meskel Square', 'Kazanchis'],
  ['Sarbet', 'Gotera', 'Bole'],
];

const CONFLICT_DISTANCE = 9; // paths closer than this (car width + margin) conflict
export const TURN_PENALTY = { straight: 0, right: 3, left: 6 }; // seconds, used by routing

/**
 * Builds the road network: a 3x3 grid of signalised junctions joined by
 * single-lane links in each direction, plus a connector path for every legal
 * movement (straight / right / left) through each junction.
 */
export function buildNetwork() {
  const junctions = [];
  for (let j = 0; j < ROWS.length; j++) {
    for (let i = 0; i < COLS.length; i++) {
      junctions.push({
        id: junctions.length,
        i,
        j,
        x: COLS[i],
        y: ROWS[j],
        code: 'ABC'[i] + (j + 1),
        label: JUNCTION_NAMES[j]?.[i] ?? 'ABC'[i] + (j + 1),
        approach: [null, null, null, null], // incoming link by travel direction
        exit: [null, null, null, null], // outgoing link by travel direction
        connectors: [],
        crossing: [0, 0, 0, 0], // pedestrians currently on each arm's crosswalk
      });
    }
  }
  const jAt = (i, j) =>
    i >= 0 && i < COLS.length && j >= 0 && j < ROWS.length ? junctions[j * COLS.length + i] : null;

  const links = [];
  const addLink = (d, from, to, fixed) => {
    const [dx, dy] = DIRS[d];
    const [ox, oy] = laneOffset(d);
    // `fixed` is the coordinate of the road centre line on the perpendicular axis.
    const along = (node, isStart) => {
      if (node) return (dx !== 0 ? node.x : node.y) + (isStart ? ROAD_HALF : -STOP_OFF) * (dx + dy);
      const lo = -BOUNDARY_PAD;
      const hi = (dx !== 0 ? WORLD.w : WORLD.h) + BOUNDARY_PAD;
      const forward = dx + dy > 0;
      return isStart === forward ? lo : hi;
    };
    const a = along(from, true);
    const b = along(to, false);
    const p0 = dx !== 0 ? [a, fixed] : [fixed, a];
    const p1 = dx !== 0 ? [b, fixed] : [fixed, b];
    const path = new Path([
      [p0[0] + ox, p0[1] + oy],
      [p1[0] + ox, p1[1] + oy],
    ]);
    const link = {
      id: links.length,
      kind: 'link',
      dir: d,
      from,
      to,
      path,
      len: path.len,
      vehicles: [],
      next: [null, null, null, null], // connector by outgoing direction
      inbound: [], // connectors that feed this link
      committed: null, // front vehicle that has committed to crossing the junction ahead
      capacity: path.len / (16 + IDM.s0),
      isEntry: from === null,
      isExit: to === null,
    };
    links.push(link);
    if (from) from.exit[d] = link;
    if (to) to.approach[d] = link;
    return link;
  };

  for (let j = 0; j < ROWS.length; j++) {
    const seq = [null, ...COLS.map((_, i) => jAt(i, j)), null];
    for (let k = 0; k < seq.length - 1; k++) addLink(0, seq[k], seq[k + 1], ROWS[j]); // east
    for (let k = seq.length - 1; k > 0; k--) addLink(2, seq[k], seq[k - 1], ROWS[j]); // west
  }
  for (let i = 0; i < COLS.length; i++) {
    const seq = [null, ...ROWS.map((_, j) => jAt(i, j)), null];
    for (let k = 0; k < seq.length - 1; k++) addLink(1, seq[k], seq[k + 1], COLS[i]); // south
    for (let k = seq.length - 1; k > 0; k--) addLink(3, seq[k], seq[k - 1], COLS[i]); // north
  }

  const connectors = [];
  for (const J of junctions) {
    for (let dIn = 0; dIn < 4; dIn++) {
      const from = J.approach[dIn];
      for (const [turn, dOut] of [
        ['straight', dIn],
        ['right', rightOf(dIn)],
        ['left', leftOf(dIn)],
      ]) {
        const to = J.exit[dOut];
        const [ix, iy] = DIRS[dIn];
        const [ux, uy] = DIRS[dOut];
        const [oix, oiy] = laneOffset(dIn);
        const [oux, ouy] = laneOffset(dOut);
        const stop = [J.x - ix * STOP_OFF + oix, J.y - iy * STOP_OFF + oiy];
        const edgeIn = [J.x - ix * ROAD_HALF + oix, J.y - iy * ROAD_HALF + oiy];
        const edgeOut = [J.x + ux * ROAD_HALF + oux, J.y + uy * ROAD_HALF + ouy];
        let pts;
        if (turn === 'straight') pts = [stop, edgeIn, edgeOut];
        else {
          const centre = [J.x - ix * ROAD_HALF + ux * ROAD_HALF, J.y - iy * ROAD_HALF + uy * ROAD_HALF];
          pts = [stop, ...arcPoints(centre, edgeIn, edgeOut, turn === 'left' ? 18 : 10)];
        }
        const path = new Path(pts);
        const c = {
          id: connectors.length,
          kind: 'conn',
          junction: J,
          dIn,
          dOut,
          turn,
          from,
          to,
          path,
          len: path.len,
          vehicles: [],
          arms: [opposite(dIn), dOut], // crosswalks this movement passes over
          conflicts: [],
          siblings: [],
          overlap: new Map(), // sibling id -> arc length over which the two paths overlap
        };
        connectors.push(c);
        J.connectors.push(c);
        from.next[dOut] = c;
        to.inbound.push(c);
      }
    }
    // Conflict table: movements from different approaches whose swept paths come close.
    for (const a of J.connectors) {
      for (const b of J.connectors) {
        if (a === b) continue;
        if (a.dIn === b.dIn) {
          a.siblings.push(b);
          // Movements from the same lane share a start and separate gradually;
          // find how far along they stay closer than a car's width.
          let s = 0;
          const pa = {};
          const pb = {};
          while (s < Math.min(a.len, b.len)) {
            a.path.pointAt(s, pa);
            b.path.pointAt(s, pb);
            if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > CONFLICT_DISTANCE) break;
            s += 0.5;
          }
          a.overlap.set(b.id, s);
          continue;
        }
        if (minPathDistance(a.path, b.path) < CONFLICT_DISTANCE) a.conflicts.push(b);
      }
    }
  }

  const entries = links.filter((l) => l.isEntry);
  const exits = links.filter((l) => l.isExit);
  return { junctions, links, connectors, entries, exits, crosswalkDepth: CROSSWALK };
}

/**
 * Dijkstra over links. Cost is free-flow travel time plus a turn penalty and,
 * optionally, a congestion term supplied by `extraCost(link)`.
 * Returns the alternating list of paths [link, connector, link, ..., exitLink].
 */
export function findRoute(net, entry, exit, extraCost = null) {
  const n = net.links.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Array(n).fill(null);
  const done = new Uint8Array(n);
  dist[entry.id] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) if (!done[k] && dist[k] < best) ((best = dist[k]), (u = k));
    if (u < 0) break;
    if (u === exit.id) break;
    done[u] = 1;
    const link = net.links[u];
    for (const c of link.next) {
      if (!c) continue;
      const v = c.to.id;
      const cost =
        (c.len + c.to.len) / SPEED_LIMIT + TURN_PENALTY[c.turn] + (extraCost ? extraCost(c.to) : 0);
      if (dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        prev[v] = c;
      }
    }
  }
  if (!Number.isFinite(dist[exit.id])) return null;
  const route = [exit];
  let cur = exit;
  while (cur !== entry) {
    const c = prev[cur.id];
    route.push(c, c.from);
    cur = c.from;
  }
  return route.reverse();
}

// Valid destinations for a trip: every exit except a U-turn back out of the same road end.
export function destinationsFor(net, entry) {
  const [sx, sy] = entry.path.pts[0];
  return net.exits.filter((x) => {
    const [ex, ey] = x.path.pts[1];
    const sameEnd = Math.hypot(ex - sx, ey - sy) < 3 * LANE_OFF;
    return !sameEnd;
  });
}

export function isStraightThrough(entry, exit) {
  return entry.dir === exit.dir && axisOf(entry.dir) === axisOf(exit.dir) &&
    (axisOf(entry.dir) === 0 ? entry.path.pts[0][1] === exit.path.pts[0][1] : entry.path.pts[0][0] === exit.path.pts[0][0]);
}

// Free-flow travel time of a route, used as the baseline for delay.
export function freeFlowTime(route, desiredSpeed) {
  let len = 0;
  for (const p of route) len += p.len;
  return len / desiredSpeed;
}
