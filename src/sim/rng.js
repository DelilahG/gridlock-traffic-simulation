// Small deterministic PRNG (mulberry32) so runs with the same seed are reproducible.
export function createRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Draw from an exponential distribution (inter-arrival times of a Poisson process).
export function exponential(rand, ratePerSec) {
  return -Math.log(1 - rand()) / ratePerSec;
}
