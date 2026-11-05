// World geometry and physical parameters.
// The world is measured in pixels; 1 px = 0.25 m, so a 16 px car is 4 m long.

export const PX_PER_M = 4;
export const WORLD = { w: 900, h: 600 };

export const ROAD_HALF = 22; // half road width (two 2.75 m lanes)
export const LANE_OFF = 11; // lane centre offset from road centre line
export const CROSSWALK = 9; // crosswalk depth, between box edge and stop line
export const STOP_OFF = ROAD_HALF + CROSSWALK; // stop line distance from junction centre
export const BOUNDARY_PAD = 40; // vehicles spawn / despawn this far outside the world

export const COLS = [200, 450, 700];
export const ROWS = [150, 300, 450];

// Direction indices, clockwise in screen space (y grows downwards).
export const E = 0;
export const S = 1;
export const W = 2;
export const N = 3;
export const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
export const DIR_NAMES = ['E', 'S', 'W', 'N'];
export const axisOf = (d) => d % 2; // 0 = east-west, 1 = north-south
export const rightOf = (d) => (d + 1) % 4;
export const leftOf = (d) => (d + 3) % 4;
export const opposite = (d) => (d + 2) % 4;

export const SPEED_LIMIT = (50 / 3.6) * PX_PER_M; // 50 km/h in px/s

// Intelligent Driver Model parameters (Treiber, Hennecke & Helbing, 2000).
export const IDM = {
  a: 2.0 * PX_PER_M, // max acceleration
  b: 3.0 * PX_PER_M, // comfortable deceleration
  bMax: 9.0 * PX_PER_M, // physical braking limit
  s0: 2.0 * PX_PER_M, // jam distance
  T: 1.2, // desired time headway (s)
  delta: 4,
  sLine: 1.5, // standstill gap to a stop line
};

// A driver commits to crossing once stopping would need more than this deceleration.
export const COMMIT_DECEL = 3.5 * PX_PER_M;
export const LEFT_TURN_GAP = 5; // s, critical gap for permissive left turns
export const STOPPED_SPEED = 0.5 * PX_PER_M; // below 0.5 m/s a vehicle counts as stopped

export const PED = {
  speedMin: 1.2 * PX_PER_M,
  speedMax: 1.6 * PX_PER_M,
  walkWindow: 5, // s after a green starts during which pedestrians may step out
  span: ROAD_HALF + 4, // curb-to-curb half length of a crosswalk
  maxWaiting: 30,
  callAfter: 10, // s a pedestrian waits before their push-button call counts as demand
};

export const DT = 0.05; // fixed simulation timestep (s)

export const toKmh = (pxPerSec) => (pxPerSec / PX_PER_M) * 3.6;
