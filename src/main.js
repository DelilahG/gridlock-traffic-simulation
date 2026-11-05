import './styles.css';
import { createIcons, Gauge, Pause, Play, RotateCcw, StepForward, X } from 'lucide';
import { DT, axisOf } from './sim/constants.js';
import { DEFAULT_TIMING, MODES } from './sim/signals.js';
import { DEFAULTS, Simulation, congestionLevel, windowMetrics } from './sim/simulation.js';
import { Renderer, drawSpark } from './render.js';

const ICONS = { Gauge, Pause, Play, RotateCcw, StepForward, X };
const $ = (id) => document.getElementById(id);
const icons = () => createIcons({ icons: ICONS, attrs: { 'stroke-width': 2.2 } });

const TIMING_FIELDS = [
  { key: 'greenEW', label: 'East–west green', min: 6, max: 40, step: 1, modes: ['fixed', 'wave'] },
  { key: 'greenNS', label: 'North–south green', min: 6, max: 40, step: 1, modes: ['fixed', 'wave'] },
  { key: 'minGreen', label: 'Minimum green', min: 3, max: 15, step: 1, modes: ['actuated', 'pressure'] },
  { key: 'maxGreen', label: 'Maximum green', min: 15, max: 60, step: 5, modes: ['actuated', 'pressure'] },
  { key: 'gap', label: 'Gap-out time', min: 1, max: 6, step: 0.5, modes: ['actuated'] },
  { key: 'amber', label: 'Amber', min: 2, max: 5, step: 0.5, modes: null },
  { key: 'allRed', label: 'All-red clearance', min: 0.5, max: 3, step: 0.5, modes: null },
];
const FROM = ['W', 'N', 'E', 'S']; // approach heading d arrives from FROM[d]

const settings = { ...DEFAULTS, timing: { ...DEFAULT_TIMING } };
let sim;
let renderer;
let runState = 'ready'; // ready | running | paused
let speed = 1;
let selected = null;
let benchRunning = false;

function build() {
  sim = new Simulation({ ...settings, timing: settings.timing });
  // The simulation copies the timing object; keep one shared instance so sliders act live.
  settings.timing = sim.timing;
  renderer?.setNetwork(sim.net);
  updateStats();
}

/* ---------------- controls ---------------- */

function setRunState(state) {
  runState = state;
  const chip = $('runState');
  chip.dataset.state = state;
  chip.textContent = state === 'running' ? 'Running' : state === 'paused' ? 'Paused' : 'Ready';
  const play = $('play');
  play.innerHTML =
    state === 'running' ? '<i data-lucide="pause"></i><span>Pause</span>' : `<i data-lucide="play"></i><span>${state === 'paused' ? 'Resume' : 'Start'}</span>`;
  icons();
  $('intro').hidden = state !== 'ready' || sim.t > 0;
}

function togglePlay() {
  setRunState(runState === 'running' ? 'paused' : 'running');
}

function stepOnce() {
  if (runState === 'running') setRunState('paused');
  safely(() => sim.run(1, DT));
  if (runState === 'ready') setRunState('paused');
  updateStats();
}

function reset() {
  build();
  setRunState(runState === 'running' ? 'running' : 'ready');
}

function setMode(m) {
  settings.mode = m;
  document.querySelectorAll('#modes button').forEach((b) => {
    b.classList.toggle('on', b.dataset.m === m);
    b.setAttribute('aria-checked', String(b.dataset.m === m));
  });
  $('mdesc').textContent = MODES[m].desc;
  renderTimingControls();
  reset();
}

function renderTimingControls() {
  const box = $('timing');
  box.innerHTML = '';
  for (const f of TIMING_FIELDS) {
    if (f.modes && !f.modes.includes(settings.mode)) continue;
    const id = `t_${f.key}`;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<label class="lbl" for="${id}">${f.label} <span class="val" id="${id}V"></span></label>
      <input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${settings.timing[f.key]}">`;
    box.appendChild(wrap);
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('.val');
    const show = () => (out.textContent = `${Number(input.value).toFixed(f.step < 1 ? 1 : 0)} s`);
    show();
    input.addEventListener('input', () => {
      settings.timing[f.key] = Number(input.value);
      if (f.key === 'minGreen' && settings.timing.maxGreen < settings.timing.minGreen) settings.timing.maxGreen = settings.timing.minGreen;
      show();
    });
  }
}

function bindRange(id, outId, fmt, apply) {
  const el = $(id);
  const out = $(outId);
  const update = () => {
    out.textContent = fmt(Number(el.value));
    apply(Number(el.value));
  };
  el.addEventListener('input', update);
  out.textContent = fmt(Number(el.value));
}

function wireControls() {
  $('play').addEventListener('click', togglePlay);
  $('introStart').addEventListener('click', () => setRunState('running'));
  $('step').addEventListener('click', stepOnce);
  $('reset').addEventListener('click', reset);
  document.querySelectorAll('#speed button').forEach((b) =>
    b.addEventListener('click', () => {
      speed = Number(b.dataset.v);
      document.querySelectorAll('#speed button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
    }),
  );
  $('seed').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(999999, Math.round(Number(e.target.value)) || 1));
    e.target.value = v;
    settings.seed = v;
    reset();
  });
  document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));

  bindRange('demand', 'demandV', (v) => `${v} veh/min`, (v) => {
    settings.demand = v;
    sim.setDemand(v, settings.ewShare);
  });
  bindRange('ew', 'ewV', (v) => `${v}%`, (v) => {
    settings.ewShare = v / 100;
    sim.setDemand(settings.demand, settings.ewShare);
  });
  bindRange('taxis', 'taxisV', (v) => `${v}% of vehicles`, (v) => {
    settings.taxiShare = v / 100;
    sim.taxiShare = v / 100;
  });
  bindRange('pedRate', 'pedRateV', (v) => `${v} /min`, (v) => {
    settings.pedRate = v;
    sim.pedRate = v;
  });
  $('peds').addEventListener('change', (e) => {
    settings.pedestrians = e.target.checked;
    sim.setPedestrians(e.target.checked);
    $('pedRate').disabled = !e.target.checked;
  });
  $('smart').addEventListener('change', (e) => {
    settings.smartRouting = e.target.checked;
    sim.smartRouting = e.target.checked;
  });
  $('bench').addEventListener('click', runBenchmark);

  const cv = $('world');
  cv.addEventListener('click', (e) => {
    const p = renderer.toWorld(e.clientX, e.clientY);
    let best = null;
    let bd = 48;
    for (const J of sim.net.junctions) {
      const d = Math.hypot(J.x - p.x, J.y - p.y);
      if (d < bd) ((bd = d), (best = J.id));
    }
    selected = best === selected ? null : best;
    updateStats();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'r' || e.key === 'R') reset();
    else if (e.key === 'ArrowRight' && runState !== 'running') stepOnce();
  });

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => renderer.resize(), 60);
  });
}

/* ---------------- stats ---------------- */

const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));

function updateStats() {
  const m = sim.metrics();
  $('m_speed').textContent = fmt(m.avgSpeed, 0);
  $('m_thr').textContent = fmt(m.throughput, 0);
  $('m_delay').textContent = fmt(m.avgDelay);
  $('m_stop').textContent = fmt(m.avgStopped);
  $('m_on').textContent = m.onRoad;
  $('m_stopped').textContent = m.stopped;
  $('m_pend').textContent = m.pending;
  $('m_ped').textContent = m.pedCrossed;
  $('m_pw').textContent = fmt(m.avgPedWait);
  $('m_taxi').textContent = m.taxis;
  $('m_kerb').textContent = m.taxisAtKerb;
  $('m_tstops').textContent = m.taxiStops;
  const t = Math.floor(sim.t);
  $('clock').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const lvl = congestionLevel(m);
  const el = $('level');
  if (el.dataset.level !== lvl.key) {
    el.dataset.level = lvl.key;
    el.textContent = lvl.label;
  }
  const c = m.collisions + m.pedCollisions;
  $('safety').innerHTML = `Safety audit: <b class="${c ? 'bad' : ''}">${c}</b> collisions · <b class="${m.emergencyStops ? 'bad' : ''}">${m.emergencyStops}</b> emergency stops`;
  drawSpark($('sparkSpeed'), sim.history.map((h) => h.speed), { max: 50, color: '#ffb020', label: `${fmt(m.avgSpeed, 0)} km/h` });
  drawSpark($('sparkStop'), sim.history.map((h) => h.stopped), { max: 10, color: '#ff6b5a', label: `${m.stopped}` });
  updateInspector();
}

function updateInspector() {
  const queues = sim.junctionQueues();
  const hot = queues.filter((q) => q.total > 0).sort((a, b) => b.total - a.total).slice(0, 3);
  $('hotspots').innerHTML = hot.length
    ? `Longest queues<ol>${hot.map((q) => `<li><b>${q.J.label}</b> · ${q.total} stopped</li>`).join('')}</ol>`
    : sim.vehicles.length
      ? 'No queues right now.'
      : '';
  const box = $('inspector');
  if (selected == null) {
    box.innerHTML = '<p class="empty">Click a junction on the map to see its signal phase and queues.</p>';
    return;
  }
  const J = sim.net.junctions[selected];
  const ctrl = sim.controllers[selected];
  const q = queues[selected].q;
  const light = (axis) => {
    const s = ctrl.light(axis);
    return `<span class="${s}">${s === 'g' ? 'green' : s === 'y' ? 'amber' : 'red'}</span>`;
  };
  const waiting = sim.peds.filter((p) => p.J === J && p.state === 'wait').length;
  box.innerHTML = `<div class="insp-head"><b>${J.label}</b><span class="phase">E–W ${light(0)} · N–S ${light(1)} · ${ctrl.t.toFixed(1)} s</span></div>
    <div class="qgrid">${[1, 2, 3, 0]
      .map((d) => `<div class="q"><b>${q[d]}</b><span>from ${FROM[d]}</span></div>`)
      .join('')}</div>
    <p class="desc">${MODES[ctrl.mode].name} · ${ctrl.switches} phase changes · ${waiting} pedestrian${waiting === 1 ? '' : 's'} waiting${
      ctrl.mode === 'pressure' ? ` · pressure E–W ${sim.pressure(J, 0).toFixed(1)} / N–S ${sim.pressure(J, 1).toFixed(1)}` : ''
    }</p>`;
}

/* ---------------- benchmark ---------------- */

async function runBenchmark() {
  if (benchRunning) return;
  benchRunning = true;
  const btn = $('bench');
  btn.disabled = true;
  const tbody = document.querySelector('#btab tbody');
  tbody.innerHTML = '';
  $('btab').hidden = true;
  $('bprog').hidden = false;
  const bar = $('bprog').firstElementChild;
  const WARM = 60;
  const MEASURE = 300;
  const modes = Object.keys(MODES);
  const totalSteps = modes.length * Math.round((WARM + MEASURE) / DT);
  let done = 0;
  const results = [];
  try {
    for (const mode of modes) {
      $('bstat').textContent = `Running ${MODES[mode].name}…`;
      const s = new Simulation({ ...settings, mode, timing: { ...settings.timing } });
      let snap = null;
      const steps = Math.round((WARM + MEASURE) / DT);
      for (let k = 0; k < steps; ) {
        const t0 = performance.now();
        while (k < steps && performance.now() - t0 < 12) {
          s.step(DT);
          k++;
          done++;
          if (!snap && s.t >= WARM - 1e-9) snap = s.snapshot();
        }
        bar.style.width = `${((done / totalSteps) * 100).toFixed(1)}%`;
        await new Promise((r) => setTimeout(r, 0));
      }
      results.push({ mode, w: windowMetrics(snap, s.snapshot()) });
    }
    const best = (k, low) => {
      const v = results.map((r) => r.w[k]).filter((x) => x != null);
      return low ? Math.min(...v) : Math.max(...v);
    };
    const bd = best('avgDelay', true);
    const bs = best('avgStopped', true);
    const bt = best('throughput', false);
    const bp = best('avgPedWait', true);
    const cell = (v, b, d = 1) => `<td class="${v === b ? 'best' : ''}">${fmt(v, d)}</td>`;
    for (const r of results) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${MODES[r.mode].name}</td>${cell(r.w.avgDelay, bd)}${cell(r.w.avgStopped, bs)}${cell(r.w.throughput, bt)}${cell(r.w.avgPedWait, bp)}`;
      tbody.appendChild(tr);
    }
    $('btab').hidden = false;
    const winner = results.slice().sort((a, b) => a.w.avgDelay - b.w.avgDelay)[0];
    const base = results.find((r) => r.mode === 'fixed');
    const gain = base && winner.mode !== 'fixed' ? ` (${(100 * (1 - winner.w.avgDelay / base.w.avgDelay)).toFixed(0)}% less delay than fixed)` : '';
    const coll = results.reduce((n, r) => n + r.w.collisions, 0);
    $('bstat').textContent = `Lowest delay: ${MODES[winner.mode].name}${gain}. ${settings.demand} veh/min, seed ${settings.seed}, ${coll} collisions.`;
  } catch (err) {
    $('bstat').textContent = `Benchmark failed: ${err.message}`;
  } finally {
    $('bprog').hidden = true;
    bar.style.width = '0';
    btn.disabled = false;
    benchRunning = false;
  }
}

/* ---------------- main loop ---------------- */

function showError(err) {
  console.error(err);
  const box = $('error');
  box.hidden = false;
  box.textContent = `Simulation stopped: ${err.message}. Press Reset to start again.`;
}

function safely(fn) {
  try {
    fn();
    return true;
  } catch (err) {
    setRunState('paused');
    showError(err);
    return false;
  }
}

let last = performance.now();
let acc = 0;
let frames = 0;
let fpsT = 0;
let statT = 0;

function frame(now) {
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  frames++;
  fpsT += real;
  if (fpsT >= 1) {
    $('fps').textContent = frames;
    frames = 0;
    fpsT = 0;
  }
  if (runState === 'running') {
    acc += real * speed;
    let n = 0;
    safely(() => {
      while (acc >= DT && n < 400) {
        sim.step(DT);
        acc -= DT;
        n++;
      }
    });
    if (n >= 400) acc = 0;
  }
  renderer.draw(sim, { heat: $('heat').checked, selected });
  statT += real;
  if (statT > 0.25) {
    statT = 0;
    updateStats();
  }
  requestAnimationFrame(frame);
}

function init() {
  icons();
  build();
  try {
    renderer = new Renderer($('world'), sim.net);
  } catch (err) {
    showError(err);
    return;
  }
  wireControls();
  setMode(settings.mode);
  setRunState('ready');
  $('error').hidden = true;
  // Hook for automated browser tests.
  window.__gridlock = {
    get sim() {
      return sim;
    },
    get runState() {
      return runState;
    },
    settings,
    axisOf,
  };
  requestAnimationFrame(frame);
}

init();
