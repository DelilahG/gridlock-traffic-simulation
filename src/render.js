import { CROSSWALK, DIRS, PX_PER_M, ROAD_HALF, STOPPED_SPEED, STOP_OFF, WORLD, axisOf } from './sim/constants.js';

const LIGHT = { g: '#2ecc71', y: '#ffd23f', r: '#ff4d4d' };

export class Renderer {
  constructor(canvas, net) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('This browser cannot create a 2D canvas.');
    this.net = net;
    this.bg = document.createElement('canvas');
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.resize();
  }

  setNetwork(net) {
    this.net = net;
    this.drawBackground();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr));
    this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.scale = Math.min(this.cv.width / WORLD.w, this.cv.height / WORLD.h);
    this.ox = (this.cv.width - WORLD.w * this.scale) / 2;
    this.oy = (this.cv.height - WORLD.h * this.scale) / 2;
    this.bg.width = this.cv.width;
    this.bg.height = this.cv.height;
    this.drawBackground();
  }

  toWorld(clientX, clientY) {
    const r = this.cv.getBoundingClientRect();
    return {
      x: ((clientX - r.left) * this.dpr - this.ox) / this.scale,
      y: ((clientY - r.top) * this.dpr - this.oy) / this.scale,
    };
  }

  // Static layer: blocks, roads, markings. Redrawn only on resize.
  drawBackground() {
    const g = this.bg.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0e141b';
    g.fillRect(0, 0, this.bg.width, this.bg.height);
    g.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
    // The city continues past the simulated area so the letterbox looks seamless.
    const EXT = 600;
    g.fillStyle = '#131b24';
    g.fillRect(-EXT, -EXT, WORLD.w + 2 * EXT, WORLD.h + 2 * EXT);

    const cols = this.net.junctions.filter((J) => J.j === 0).map((J) => J.x);
    const rows = this.net.junctions.filter((J) => J.i === 0).map((J) => J.y);
    const xs = [-EXT, ...cols, WORLD.w + EXT];
    const ys = [-EXT, ...rows, WORLD.h + EXT];
    const curb = ROAD_HALF + 6;
    for (let a = 0; a < xs.length - 1; a++) {
      for (let b = 0; b < ys.length - 1; b++) {
        const x0 = xs[a] + curb;
        const x1 = xs[a + 1] - curb;
        const y0 = ys[b] + curb;
        const y1 = ys[b + 1] - curb;
        g.fillStyle = '#17212c';
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
        g.fillStyle = '#1b2733';
        for (let bx = x0 + 9; bx < x1 - 30; bx += 40) {
          for (let by = y0 + 9; by < y1 - 30; by += 40) g.fillRect(bx, by, 31, 31);
        }
      }
    }
    // roads
    g.fillStyle = '#232d39';
    for (const x of cols) g.fillRect(x - ROAD_HALF, -EXT, 2 * ROAD_HALF, WORLD.h + 2 * EXT);
    for (const y of rows) g.fillRect(-EXT, y - ROAD_HALF, WORLD.w + 2 * EXT, 2 * ROAD_HALF);
    // centre lines, then repaint junction areas so they stay unmarked
    g.strokeStyle = '#3a4757';
    g.lineWidth = 1.2;
    g.setLineDash([9, 9]);
    for (const x of cols) {
      g.beginPath();
      g.moveTo(x, -EXT);
      g.lineTo(x, WORLD.h + EXT);
      g.stroke();
    }
    for (const y of rows) {
      g.beginPath();
      g.moveTo(-EXT, y);
      g.lineTo(WORLD.w + EXT, y);
      g.stroke();
    }
    g.setLineDash([]);
    for (const J of this.net.junctions) {
      g.fillStyle = '#232d39';
      g.fillRect(J.x - STOP_OFF, J.y - ROAD_HALF, 2 * STOP_OFF, 2 * ROAD_HALF);
      g.fillRect(J.x - ROAD_HALF, J.y - STOP_OFF, 2 * ROAD_HALF, 2 * STOP_OFF);
    }
    for (const J of this.net.junctions) {
      g.fillStyle = '#262f3b';
      g.fillRect(J.x - ROAD_HALF, J.y - ROAD_HALF, 2 * ROAD_HALF, 2 * ROAD_HALF);
      for (let arm = 0; arm < 4; arm++) {
        const [ux, uy] = DIRS[arm];
        const vx = -uy;
        const vy = ux;
        const cx = J.x + ux * (ROAD_HALF + CROSSWALK / 2);
        const cy = J.y + uy * (ROAD_HALF + CROSSWALK / 2);
        g.strokeStyle = '#4a586a';
        g.lineWidth = 1.6;
        for (let s = -ROAD_HALF + 3; s < ROAD_HALF; s += 5) {
          g.beginPath();
          g.moveTo(cx + vx * s - ux * 3, cy + vy * s - uy * 3);
          g.lineTo(cx + vx * s + ux * 3, cy + vy * s + uy * 3);
          g.stroke();
        }
      }
      g.fillStyle = '#6b7b8f';
      g.font = '600 9px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillText(J.label, J.x + STOP_OFF + 8, J.y - ROAD_HALF - 10); // clear of the signal lamps
    }
  }

  draw(sim, { heat = true, selected = null } = {}) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);

    const queues = sim.junctionQueues();
    for (const { J, total } of queues) {
      const ctrl = sim.controllers[J.id];
      // congestion ring
      if (total >= 3) {
        const k = Math.min(1, (total - 2) / 14);
        ctx.strokeStyle = `hsla(${38 - 38 * k}, 95%, 58%, ${0.35 + 0.5 * k})`;
        ctx.lineWidth = 2 + 2 * k;
        ctx.strokeRect(J.x - STOP_OFF - 3, J.y - STOP_OFF - 3, 2 * STOP_OFF + 6, 2 * STOP_OFF + 6);
      }
      if (selected === J.id) {
        ctx.strokeStyle = '#4cc3ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(J.x - STOP_OFF - 8, J.y - STOP_OFF - 8, 2 * STOP_OFF + 16, 2 * STOP_OFF + 16);
        ctx.setLineDash([]);
      }
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d];
        const rx = -dy; // right-hand normal of the approach
        const ry = dx;
        const st = ctrl.light(axisOf(d));
        const sx = J.x - dx * STOP_OFF;
        const sy = J.y - dy * STOP_OFF;
        ctx.strokeStyle = LIGHT[st];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx + rx * 1, sy + ry * 1);
        ctx.lineTo(sx + rx * (ROAD_HALF - 1), sy + ry * (ROAD_HALF - 1));
        ctx.stroke();
        const lx = sx + rx * (ROAD_HALF + 4);
        const ly = sy + ry * (ROAD_HALF + 4);
        ctx.fillStyle = '#0b1016';
        ctx.beginPath();
        ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = LIGHT[st];
        ctx.beginPath();
        ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const blinkOn = this.reducedMotion || Math.floor(sim.t * 2.5) % 2 === 0;
    for (const u of sim.vehicles) this.drawVehicle(u, heat, blinkOn);

    for (const p of sim.peds) {
      ctx.fillStyle = p.state === 'wait' ? '#ffb020' : '#f4f7fb';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawVehicle(u, heat, blinkOn) {
    const ctx = this.ctx;
    const P = u.route[u.idx];
    let turn = null;
    if (P.kind === 'conn') turn = P.turn;
    else if (!P.isExit && P.len - u.s < 110) turn = u.route[u.idx + 1].turn;
    ctx.save();
    ctx.translate(u.x, u.y);
    ctx.rotate(u.ang);
    const hl = u.len / 2;
    const hw = u.wid / 2;
    ctx.fillStyle = heat
      ? `hsl(${Math.min(120, (u.v / u.v0) * 125)}, 72%, 54%)`
      : u.kind === 'van'
        ? 'hsl(210, 15%, 78%)'
        : `hsl(${u.hue}, 55%, 60%)`;
    if (u.kind === 'taxi' && !heat) ctx.fillStyle = '#2f6fd6'; // Addis minibus blue
    ctx.beginPath();
    ctx.roundRect(-hl, -hw, u.len, u.wid, 2);
    ctx.fill();
    if (u.kind === 'taxi') {
      // white upper body: the blue-and-white minibus livery
      ctx.fillStyle = '#f4f7fb';
      ctx.fillRect(-hl + 3, -hw + 1.6, u.len - 8, u.wid - 3.2);
    }
    ctx.fillStyle = '#0b101688';
    ctx.fillRect(hl - 6, -hw + 1, 3, u.wid - 2);
    const braking = u.v < STOPPED_SPEED || u.acc < -1.5 * PX_PER_M;
    if (braking) {
      ctx.fillStyle = '#ff3b3b';
      ctx.fillRect(-hl, -hw + 0.5, 1.6, 2);
      ctx.fillRect(-hl, hw - 2.5, 1.6, 2);
    }
    if (u.dwelling && blinkOn) {
      // hazard lights while picking up passengers at the kerb
      ctx.fillStyle = '#ffb020';
      for (const x of [hl - 2, -hl]) for (const y of [-hw, hw - 2]) ctx.fillRect(x, y, 2, 2);
    } else if (turn && turn !== 'straight' && blinkOn) {
      ctx.fillStyle = '#ffb020';
      const side = turn === 'right' ? hw - 2 : -hw;
      ctx.fillRect(hl - 2, side, 2, 2);
      ctx.fillRect(-hl, side, 2, 2);
    }
    ctx.restore();
  }
}

export function drawSpark(canvas, values, { max = 1, color = '#ffb020', label = '' } = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#243040';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, h - 0.5);
  g.lineTo(w, h - 0.5);
  g.stroke();
  if (values.length < 2) return;
  const top = Math.max(max, ...values) || 1;
  g.strokeStyle = color;
  g.lineWidth = 1.6;
  g.beginPath();
  values.forEach((v, i) => {
    const x = (i / 179) * w;
    const y = h - 3 - (v / top) * (h - 8);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.stroke();
  g.fillStyle = '#8796a8';
  g.font = '10px ui-monospace, Menlo, monospace';
  g.textAlign = 'right';
  g.fillText(label, w - 2, 10);
}
