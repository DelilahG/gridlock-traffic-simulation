import { COLS, SPEED_LIMIT } from './constants.js';

export const MODES = {
  fixed: {
    name: 'Fixed timer',
    short: 'Fixed',
    desc: 'Every junction runs the same pre-timed cycle, blind to demand. The classic baseline.',
  },
  wave: {
    name: 'Green wave',
    short: 'Wave',
    desc: 'Same fixed cycle, but each column is offset by the travel time between junctions so east-west platoons meet consecutive greens.',
  },
  actuated: {
    name: 'Actuated',
    short: 'Actuated',
    desc: 'Loop detectors near each stop line. Green is extended while vehicles keep arriving and ends after a gap, or at max green, when the cross street is waiting.',
  },
  pressure: {
    name: 'Max-pressure',
    short: 'Pressure',
    desc: 'Each junction compares the queues it could serve against the space downstream and gives green to the phase that relieves the most pressure.',
  },
};

export const DEFAULT_TIMING = {
  greenEW: 18,
  greenNS: 18,
  amber: 3,
  allRed: 1,
  minGreen: 5,
  maxGreen: 25,
  gap: 2,
};

// Two-phase controller: phase 0 serves east-west, phase 1 north-south.
// Stages: G (green), Y (amber), R (all-red clearance before the other phase).
export class SignalController {
  constructor(junction, mode, timing) {
    this.j = junction;
    this.mode = mode;
    this.timing = timing; // shared, live-editable object
    this.phase = 0;
    this.stage = 'G';
    this.t = 0;
    this.pedHold = 0; // green must last at least this long (pedestrian clearance)
    this.gapTimer = 0;
    this.switches = 0;
    if (mode === 'wave') {
      const offset = (COLS[junction.i] - COLS[0]) / (SPEED_LIMIT * 0.9);
      // Column i starts its green `offset` seconds after column 0.
      this.seek(-offset);
    }
  }

  green(phase) {
    return phase === 0 ? this.timing.greenEW : this.timing.greenNS;
  }

  cycleLength() {
    const t = this.timing;
    return t.greenEW + t.greenNS + 2 * (t.amber + t.allRed);
  }

  // Place a fixed-time controller `offset` seconds into its cycle.
  seek(offset) {
    const t = this.timing;
    const C = this.cycleLength();
    let tau = ((offset % C) + C) % C;
    const stages = [
      [0, 'G', t.greenEW],
      [0, 'Y', t.amber],
      [0, 'R', t.allRed],
      [1, 'G', t.greenNS],
      [1, 'Y', t.amber],
      [1, 'R', t.allRed],
    ];
    for (const [phase, stage, dur] of stages) {
      if (tau < dur) {
        this.phase = phase;
        this.stage = stage;
        this.t = tau;
        return;
      }
      tau -= dur;
    }
  }

  // Signal shown to traffic on the given axis: 'g', 'y' or 'r'.
  light(axis) {
    if (this.stage === 'R' || axis !== this.phase) return 'r';
    return this.stage === 'G' ? 'g' : 'y';
  }

  // True when a fixed-time plan has room for a pedestrian to finish crossing.
  pedFits(crossTime) {
    if (this.mode === 'fixed' || this.mode === 'wave') return this.t + crossTime <= this.green(this.phase);
    return true;
  }

  update(dt, sim) {
    this.t += dt;
    const tm = this.timing;
    if (this.stage === 'G') {
      if (this.t >= this.pedHold && this.shouldEndGreen(dt, sim)) this.enter('Y');
    } else if (this.stage === 'Y') {
      if (this.t >= tm.amber) this.enter('R');
    } else if (this.t >= tm.allRed && sim.crosswalksClearForAxis(this.j, 1 - this.phase)) {
      this.phase = 1 - this.phase;
      this.switches++;
      this.enter('G');
    }
  }

  enter(stage) {
    this.stage = stage;
    this.t = 0;
    this.pedHold = 0;
    this.gapTimer = 0;
  }

  shouldEndGreen(dt, sim) {
    const tm = this.timing;
    const cur = this.phase;
    const other = 1 - cur;
    switch (this.mode) {
      case 'fixed':
      case 'wave':
        return this.t >= this.green(cur);
      case 'actuated': {
        if (sim.detectorOccupied(this.j, cur)) this.gapTimer = 0;
        else this.gapTimer += dt;
        if (this.t < tm.minGreen) return false;
        if (!sim.hasDemand(this.j, other)) return false; // rest in green
        return this.gapTimer >= tm.gap || this.t >= tm.maxGreen;
      }
      case 'pressure': {
        if (this.t < tm.minGreen) return false;
        const pc = sim.pressure(this.j, cur);
        const po = sim.pressure(this.j, other);
        if (this.t >= tm.maxGreen && po > 0) return true;
        // Serve an empty green's waiting cross street at once; otherwise require a clear margin.
        return (pc < 0.5 && po > 0) || po > pc + 1;
      }
      default:
        return this.t >= this.green(cur);
    }
  }
}
