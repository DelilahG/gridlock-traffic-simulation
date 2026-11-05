import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Path, arcPoints, boxesOverlap } from '../../src/sim/geometry.js';
import { buildNetwork, destinationsFor, findRoute } from '../../src/sim/network.js';
import { createRng } from '../../src/sim/rng.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Path measures length and interpolates position and heading', () => {
  const p = new Path([
    [0, 0],
    [10, 0],
    [10, 5],
  ]);
  close(p.len, 15);
  const a = p.pointAt(4);
  close(a.x, 4);
  close(a.y, 0);
  close(a.ang, 0);
  const b = p.pointAt(12);
  close(b.x, 10);
  close(b.y, 2);
  close(b.ang, Math.PI / 2);
  // extrapolates past the ends along the end tangents
  close(p.pointAt(-3).x, -3);
  close(p.pointAt(18).y, 8);
});

test('arcPoints traces a quarter circle with constant radius', () => {
  const pts = arcPoints([0, 0], [10, 0], [0, 10], 12);
  for (const [x, y] of pts) close(Math.hypot(x, y), 10);
  const arc = new Path(pts);
  close(arc.len, (Math.PI / 2) * 10, 0.05);
});

test('boxesOverlap detects rotated overlaps and separation', () => {
  const A = { x: 0, y: 0, ang: 0, hl: 5, hw: 2 };
  assert.equal(boxesOverlap(A, { x: 9, y: 0, ang: 0, hl: 5, hw: 2 }), true);
  assert.equal(boxesOverlap(A, { x: 11, y: 0, ang: 0, hl: 5, hw: 2 }), false);
  assert.equal(boxesOverlap(A, { x: 6, y: 4, ang: Math.PI / 2, hl: 5, hw: 2 }), true);
  assert.equal(boxesOverlap(A, { x: 0, y: 4.5, ang: 0, hl: 5, hw: 2 }), false);
});

test('rng is deterministic per seed', () => {
  const a = createRng(42);
  const b = createRng(42);
  const c = createRng(43);
  const xs = Array.from({ length: 5 }, a);
  assert.deepEqual(xs, Array.from({ length: 5 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, c));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test('network has the expected topology', () => {
  const net = buildNetwork();
  assert.equal(net.junctions.length, 9);
  assert.equal(net.links.length, 48); // 6 roads x 4 segments x 2 directions
  assert.equal(net.connectors.length, 9 * 12);
  assert.equal(net.entries.length, 12);
  assert.equal(net.exits.length, 12);
  for (const J of net.junctions) {
    for (let d = 0; d < 4; d++) {
      assert.ok(J.approach[d], `${J.label} approach ${d}`);
      assert.ok(J.exit[d], `${J.label} exit ${d}`);
    }
  }
});

test('conflict table is symmetric and matches junction geometry', () => {
  const net = buildNetwork();
  const J = net.junctions[4];
  const find = (dIn, turn) => J.connectors.find((c) => c.dIn === dIn && c.turn === turn);
  for (const a of J.connectors) for (const b of a.conflicts) assert.ok(b.conflicts.includes(a));
  const ebStraight = find(0, 'straight');
  const wbStraight = find(2, 'straight');
  const wbLeft = find(2, 'left');
  const sbStraight = find(1, 'straight');
  const ebRight = find(0, 'right');
  assert.ok(!ebStraight.conflicts.includes(wbStraight), 'opposing through movements are separate');
  assert.ok(ebStraight.conflicts.includes(wbLeft), 'left turn crosses opposing through traffic');
  assert.ok(ebStraight.conflicts.includes(sbStraight), 'crossing through movements conflict');
  assert.ok(ebRight.conflicts.includes(wbLeft), 'right turn and opposing left merge into the same exit');
  assert.equal(ebStraight.siblings.length, 2);
});

test('routes exist for every origin-destination pair and are contiguous', () => {
  const net = buildNetwork();
  let count = 0;
  for (const entry of net.entries) {
    const dests = destinationsFor(net, entry);
    assert.equal(dests.length, 11, 'every exit except the U-turn');
    for (const exit of dests) {
      const r = findRoute(net, entry, exit);
      assert.ok(r, `route ${entry.id} -> ${exit.id}`);
      assert.equal(r[0], entry);
      assert.equal(r[r.length - 1], exit);
      for (let k = 1; k < r.length; k += 2) {
        assert.equal(r[k].kind, 'conn');
        assert.equal(r[k].from, r[k - 1]);
        assert.equal(r[k].to, r[k + 1]);
      }
      count++;
    }
  }
  assert.equal(count, 132);
});

test('routing prefers fewer turns and reacts to congestion costs', () => {
  const net = buildNetwork();
  const entry = net.entries.find((l) => l.dir === 0 && l.path.pts[0][1] > 300 && l.path.pts[0][1] < 320);
  const exit = net.exits.find((l) => l.dir === 0 && l.path.pts[0][1] === entry.path.pts[0][1]);
  const direct = findRoute(net, entry, exit);
  assert.equal(direct.filter((p) => p.kind === 'conn' && p.turn !== 'straight').length, 0);
  // make the direct links very expensive: the router should detour
  const avoid = new Set(direct.filter((p) => p.kind === 'link').map((l) => l.id));
  avoid.delete(entry.id);
  avoid.delete(exit.id);
  const detour = findRoute(net, entry, exit, (l) => (avoid.has(l.id) ? 500 : 0));
  assert.ok(detour.length > direct.length);
});
