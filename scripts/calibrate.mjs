// Prints the model's queue-discharge statistics next to the Addis Ababa targets.
// Usage: node scripts/calibrate.mjs
import { queueDischarge } from '../src/sim/calibration.js';

const q = queueDischarge();
console.log('Queue-discharge experiment (12 cars, HCM method)');
console.log(`  headways (s):        ${q.headways.map((h) => h.toFixed(2)).join(' ')}`);
console.log(`  start-up lost time:  ${q.startUpLostTime.toFixed(2)} s   target 2.51 s (Addis Ababa, AAU thesis)`);
console.log(`  saturation headway:  ${q.saturationHeadway.toFixed(2)} s   target 1.89 s`);
console.log(`  saturation flow:     ${q.saturationFlow.toFixed(0)} veh/h  target 1900 veh/h (Addis Ababa studies)`);
