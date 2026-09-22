'use strict';

const assert = require('assert');
const engine = require('./water_solver_engine.js');

function permutations(values) {
  const result = [];
  const visit = index => {
    if (index === values.length) {
      result.push([...values]);
      return;
    }
    for (let other = index; other < values.length; other++) {
      [values[index], values[other]] = [values[other], values[index]];
      visit(index + 1);
      [values[index], values[other]] = [values[other], values[index]];
    }
  };
  visit(0);
  return result;
}

function bruteForceShortest(tubes, targets, capacity) {
  const start = engine.normalizeState(tubes, targets, capacity);
  if (start.targets.length === 0) return 0;
  const queue = [{ tubes: start.tubes, targets: start.targets, depth: 0 }];
  const seen = new Set([engine.canonicalStateKey(start.tubes, start.targets)]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const move of engine.generateLegalMoves(current.tubes, current.targets, capacity)) {
      const next = engine.applyMoveAndClear(current.tubes, current.targets, move, capacity);
      if (next.targets.length === 0) return current.depth + 1;
      const key = engine.canonicalStateKey(next.tubes, next.targets);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ tubes: next.tubes, targets: next.targets, depth: current.depth + 1 });
    }
  }
  return Infinity;
}

function bruteForceFirstClear(tubes, targets, capacity) {
  const start = engine.normalizeState(tubes, targets, capacity);
  if (start.targets.length === 0) return 0;
  const queue = [{ tubes: start.tubes, targets: start.targets, depth: 0 }];
  const seen = new Set([engine.canonicalStateKey(start.tubes, start.targets)]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const move of engine.generateLegalMoves(current.tubes, current.targets, capacity)) {
      const next = engine.applyMoveAndClear(current.tubes, current.targets, move, capacity);
      if (next.targets.length < current.targets.length) return current.depth + 1;
      const key = engine.canonicalStateKey(next.tubes, next.targets);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ tubes: next.tubes, targets: next.targets, depth: current.depth + 1 });
    }
  }
  return Infinity;
}

const capacity = 3;
const colors = ['A', 'B'];
const arrangements = new Map();
const uniqueOrders = new Map();
for (const order of permutations(['A', 'A', 'A', 'B', 'B', 'B'])) {
  uniqueOrders.set(order.join(''), order);
}

function addCompositions(remaining, parts, prefix = []) {
  if (parts === 1) {
    if (remaining <= capacity) {
      const lengths = [...prefix, remaining];
      for (const order of uniqueOrders.values()) {
        const board = [];
        let offset = 0;
        for (const length of lengths) {
          board.push(order.slice(offset, offset + length));
          offset += length;
        }
        arrangements.set(engine.orderedStateKey(board, []), board);
      }
    }
    return;
  }
  for (let length = 0; length <= Math.min(capacity, remaining); length++) {
    addCompositions(remaining - length, parts - 1, [...prefix, length]);
  }
}
addCompositions(6, 4);

let checked = 0;
for (const board of arrangements.values()) {
  for (const targetOrder of [colors, [...colors].reverse()]) {
    const targets = targetOrder.map((color, tubeIdx) => ({ tubeIdx, color }));
    const expected = bruteForceShortest(board, targets, capacity);
    const actual = engine.solveStaticOptimal(board, targets, {
      capacity,
      timeLimitMs: 0,
      finalNodeLimit: 1000000
    });
    assert.strictEqual(actual.certificate.provenOptimal, true);
    assert.strictEqual(actual.plan.length, expected);
    if (expected > 0 && Number.isFinite(expected)) {
      const expectedFirstClear = bruteForceFirstClear(board, targets, capacity);
      const fast = engine.solveNextClearFast(board, targets, {
        capacity,
        timeLimitMs: 0,
        maxStageNodes: 100000,
        maxStageCandidates: 1000,
        stageDepthSlack: 6
      });
      assert.strictEqual(fast.certificate.shortestClearDepth, expectedFirstClear);
      assert.ok(fast.plan.length >= expectedFirstClear);
      assert.ok(fast.plan[fast.plan.length - 1].clearedColor);
    }
    checked++;
  }
}

const portfolioBoard = [['A', 'B'], ['B', 'A'], [], []];
const portfolioTargets = [
  { tubeIdx: 0, color: 'A' },
  { tubeIdx: 1, color: 'B' }
];
const warmOptions = {
  capacity: 2,
  refillCount: 2,
  timeLimitMs: 50,
  maxStageNodes: 1000,
  maxStageCandidates: 20,
  maxCandidatesEvaluated: 10,
  finalNodeLimit: 10000,
  greedyNodeLimit: 500,
  greedyCandidateLimit: 10,
  upperFraction: 0.7
};
const warmResult = engine.solveRefillPolicy(portfolioBoard, portfolioTargets, warmOptions);
const portfolioResult = engine.solveRefillPolicy(portfolioBoard, portfolioTargets, {
  ...warmOptions,
  timeLimitMs: 200,
  maxStageNodes: 5000,
  maxStageCandidates: 80,
  maxCandidatesEvaluated: 40,
  warmStartOptions: warmOptions
});
assert.ok(
  portfolioResult.certificate.upperBound <= warmResult.certificate.upperBound,
  'a larger portfolio budget must never replace its warm-start route with a worse route'
);
assert.ok(portfolioResult.stats.warmStartElapsedMs >= 0);

console.log(
  `exhaustive compact-board equivalence: ${checked} cases; monotonic portfolio: PASS`
);
