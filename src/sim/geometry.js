// Polyline paths with arc-length parameterisation. Every lane segment and every
// movement through a junction is a Path, so vehicles only ever need (path, s).

export class Path {
  constructor(points) {
    if (points.length < 2) throw new Error('Path needs at least two points');
    this.pts = points;
    this.cum = [0];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      this.cum.push(this.cum[i - 1] + Math.hypot(dx, dy));
    }
    this.len = this.cum[this.cum.length - 1];
  }

  segmentIndex(s) {
    const c = this.cum;
    if (s <= 0) return 0;
    if (s >= this.len) return c.length - 2;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  // Position and heading at arc length s. Values outside [0, len] are
  // extrapolated along the end tangents, which is how a car body that straddles
  // two paths is drawn.
  pointAt(s, out = {}) {
    const i = this.segmentIndex(s);
    const p0 = this.pts[i];
    const p1 = this.pts[i + 1];
    const segLen = this.cum[i + 1] - this.cum[i] || 1;
    const t = (s - this.cum[i]) / segLen;
    out.x = p0[0] + (p1[0] - p0[0]) * t;
    out.y = p0[1] + (p1[1] - p0[1]) * t;
    out.ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    return out;
  }

  sample(step) {
    const out = [];
    const n = Math.max(1, Math.ceil(this.len / step));
    for (let k = 0; k <= n; k++) {
      const p = this.pointAt((k / n) * this.len);
      out.push([p.x, p.y]);
    }
    return out;
  }
}

// Points on a circular arc from p0 to p1 around centre c, taking the short way.
export function arcPoints(c, p0, p1, segments = 16) {
  const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
  const a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const r = Math.hypot(p0[0] - c[0], p0[1] - c[1]);
  const pts = [];
  for (let k = 0; k <= segments; k++) {
    const a = a0 + (d * k) / segments;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return pts;
}

// Smallest distance between two sampled paths (used to build conflict tables).
export function minPathDistance(a, b, step = 1.5) {
  const sa = a.sample(step);
  const sb = b.sample(step);
  let best = Infinity;
  for (const p of sa) {
    for (const q of sb) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

// Oriented-rectangle overlap test (separating axis theorem).
export function boxesOverlap(A, B) {
  const axes = [
    [Math.cos(A.ang), Math.sin(A.ang)],
    [-Math.sin(A.ang), Math.cos(A.ang)],
    [Math.cos(B.ang), Math.sin(B.ang)],
    [-Math.sin(B.ang), Math.cos(B.ang)],
  ];
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  for (const [ux, uy] of axes) {
    const ra =
      (A.hl * Math.abs(Math.cos(A.ang) * ux + Math.sin(A.ang) * uy)) +
      (A.hw * Math.abs(-Math.sin(A.ang) * ux + Math.cos(A.ang) * uy));
    const rb =
      (B.hl * Math.abs(Math.cos(B.ang) * ux + Math.sin(B.ang) * uy)) +
      (B.hw * Math.abs(-Math.sin(B.ang) * ux + Math.cos(B.ang) * uy));
    if (Math.abs(dx * ux + dy * uy) > ra + rb) return false;
  }
  return true;
}
