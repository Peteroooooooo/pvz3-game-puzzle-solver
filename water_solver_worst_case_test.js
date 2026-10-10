'use strict';

const assert = require('assert');
const engine = require('./water_solver_engine');

// Independent breadth-first oracle: enumerate every first-clear layout, then
// take the maximum exact final distance over all of that layout's refills.
function shortestFinal(board, targets, capacity) {
  const start = engine.normalizeState(board, targets, capacity);
  const queue = [{ ...start, depth: 0 }];
  const seen = new Set([engine.orderedStateKey(start.tubes, start.targets)]);
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head];
    if (!state.targets.length) return state.depth;
    for (const move of engine.generateLegalMoves(state.tubes, state.targets, capacity)) {
      const next = engine.applyMoveAndClear(state.tubes, state.targets, move, capacity);
      const key = engine.orderedStateKey(next.tubes, next.targets);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ ...next, depth: state.depth + 1 });
      }
    }
  }
  return Infinity;
}

function bruteWorst(board, targets) {
  const start = engine.normalizeState(board, targets, 2);
  if (start.targets.length < 2) return shortestFinal(start.tubes, start.targets, 2);
  const queue = [{ ...start, depth: 0 }];
  const seen = new Set([engine.orderedStateKey(start.tubes, start.targets)]);
  let best = Infinity;
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head];
    if (state.depth + 1 >= best) continue;
    for (const move of engine.generateLegalMoves(state.tubes, state.targets, 2)) {
      const next = engine.applyMoveAndClear(state.tubes, state.targets, move, 2);
      if (next.record.clearedColor) {
        let worst = 0;
        for (const outcome of engine.enumerateRefillOutcomes(next.tubes, next.record.clearedColor,
          next.record.clearedTube, { capacity: 2, refillCount: 2, targets: next.targets })) {
          worst = Math.max(worst, shortestFinal(outcome.tubes, next.targets, 2));
        }
        best = Math.min(best, state.depth + 1 + worst);
      } else {
        const key = engine.orderedStateKey(next.tubes, next.targets);
        if (!seen.has(key)) {
          seen.add(key);
          queue.push({ ...next, depth: state.depth + 1 });
        }
      }
    }
  }
  return best;
}

const options = {
  capacity: 2, refillCount: 2, objective: 'worst-case', includePolicy: true,
  timeLimitMs: 0, maxStageNodes: 100000, maxStageCandidates: Infinity,
  maxLockedCandidates: Infinity, maxCandidatesEvaluated: Infinity,
  maxLockedCandidatesEvaluated: Infinity, stageDepthSlack: Infinity,
  finalNodeLimit: 100000, greedyNodeLimit: 1000
};
const orders = ['AABB', 'ABAB', 'ABBA', 'BAAB', 'BABA', 'BBAA'];
let checked = 0;
for (let a = 0; a <= 2; a++) for (let b = 0; b <= 2; b++) for (let c = 0; c <= 2; c++) {
  const d = 4 - a - b - c;
  if (d < 0 || d > 2) continue;
  for (const order of orders) {
    let offset = 0;
    const board = [a, b, c, d].map(length => {
      const tube = [...order.slice(offset, offset + length)];
      offset += length;
      return tube;
    });
    const targets = [{ tubeIdx: 0, color: 'A' }, { tubeIdx: 1, color: 'B' }];
    const exact = bruteWorst(board, targets);
    const result = engine.solveRefillPolicy(board, targets, options);
    assert.strictEqual(result.certificate.worstCaseUpper, exact, JSON.stringify(board));
    assert.strictEqual(result.certificate.provenOptimal, true);
    assert.strictEqual(result.certificate.objectiveLowerBound, exact);
    if (result.plan.length) {
      const continuation = engine.getPolicyContinuation(result.policy, board, targets, { capacity: 2 });
      assert.ok(continuation);
      assert.strictEqual(continuation.certificate.worstCaseUpper, exact);
    }
    checked++;
  }
}

const mixed = [['A', 'B'], ['B', 'A'], [], []];
const targets = [{ tubeIdx: 0, color: 'A' }, { tubeIdx: 1, color: 'B' }];
const impossibleBudget = engine.solveRefillPolicy(mixed, targets, { ...options, moveBudget: 1 });
assert.strictEqual(impossibleBudget.certificate.budgetStatus, 'impossible');
const timedOut = engine.solveRefillPolicy(mixed, targets, { ...options, timeLimitMs: 0.000001 });
assert.strictEqual(timedOut.certificate.budgetStatus, 'unproven');
assert.notStrictEqual(timedOut.certificate.guaranteed, true);

// A legal editor configuration refutes an unconditional 20-move promise:
// all five target tubes have four wrong runs above a zero-length correct
// prefix. All 20 runs must leave, and the last clear needs a separate pour.
const fiveColors = ['G', 'B', 'O', 'R', 'P'];
const overTwenty = fiveColors.map((_, tubeIdx) =>
  Array.from({ length: 4 }, (_, layer) => fiveColors[(tubeIdx + layer + 1) % 5]));
overTwenty.push([], []);
const overTwentyTargets = fiveColors.map((color, tubeIdx) => ({ tubeIdx, color }));
const refuted = engine.solveRefillPolicy(overTwenty, overTwentyTargets, {
  objective: 'worst-case', moveBudget: 20, timeLimitMs: 0.000001
});
assert.strictEqual(refuted.certificate.worstCaseLower, 21);
assert.strictEqual(refuted.certificate.budgetStatus, 'impossible');

const sample = [['G', 'B', 'O', 'R'], ['B', 'O', 'R', 'G'], ['O', 'R', 'G', 'B'],
  ['R', 'G', 'B', 'O'], [], [], []];
const sampleTargets = ['G', 'B', 'O', 'R'].map((color, tubeIdx) => ({ tubeIdx, color }));
const solved = engine.solveRefillPolicy(sample, sampleTargets, {
  objective: 'worst-case', includePolicy: true, timeLimitMs: 4000,
  maxStageNodes: 8000, maxStageCandidates: 30, stageDepthSlack: 4,
  maxCandidatesEvaluated: { 4: 2, 3: 2, 2: 3 }, finalNodeLimit: 180000,
  greedyNodeLimit: 3000, greedyCandidateLimit: 10, greedyDepthSlack: 3, upperFraction: 0.7
});
assert.strictEqual(solved.certificate.budgetStatus, 'guaranteed');

let branches = 0;
const verified = new Map();
function replayEveryBranch(board, targets, policy = solved.policy) {
  if (!targets.length) return { worst: 0, expected: 0 };
  const key = engine.canonicalStateKey(board, targets);
  if (verified.has(key)) return verified.get(key);
  const continuation = engine.getPolicyContinuation(policy, board, targets);
  assert.ok(continuation, `missing continuation ${key}`);
  let next = { tubes: board, targets };
  let clear;
  for (const move of continuation.plan) {
    assert.ok(engine.generateLegalMoves(next.tubes, next.targets).some(legal =>
      legal.from === move.from && legal.to === move.to && legal.amount === move.amount));
    next = engine.applyMoveAndClear(next.tubes, next.targets, move);
    if (next.record.clearedColor) clear = next.record;
  }
  assert.ok(clear);
  let worst = continuation.plan.length;
  let expected = continuation.plan.length;
  if (next.targets.length) {
    for (const outcome of engine.enumerateRefillOutcomes(next.tubes, clear.clearedColor,
      clear.clearedTube, { targets: next.targets })) {
      branches++;
      const child = replayEveryBranch(outcome.tubes, next.targets, policy);
      worst = Math.max(worst, continuation.plan.length + child.worst);
      expected += outcome.probability * child.expected;
    }
  }
  assert.ok(worst <= continuation.certificate.worstCaseUpper);
  assert.ok(expected <= continuation.certificate.upperBound + 1e-9);
  const value = { worst, expected };
  verified.set(key, value);
  return value;
}
const actual = replayEveryBranch(sample, sampleTargets);
assert.ok(actual.worst <= 17);
assert.strictEqual(engine.getPolicyContinuation(solved.policy, [['X'], [], [], [], [], [], []], sampleTargets), null);
const screenshotBoard = [['P', 'O', 'B', 'G'], ['O', 'R', 'G', 'O'], [], ['R', 'R', 'R', 'G'],
  [], ['P', 'G', 'P', 'B'], ['B', 'O', 'B', 'P']];
const screenshotTargets = [{ tubeIdx: 3, color: 'P' }, { tubeIdx: 4, color: 'R' },
  { tubeIdx: 5, color: 'O' }, { tubeIdx: 6, color: 'B' }];
const screenshot = engine.solveRefillPolicy(screenshotBoard, screenshotTargets, {
  objective: 'worst-case', includePolicy: true, timeLimitMs: 4000,
  maxStageNodes: 8000, maxStageCandidates: 30, stageDepthSlack: 4,
  maxCandidatesEvaluated: { 4: 2, 3: 2, 2: 3 }, finalNodeLimit: 180000,
  greedyNodeLimit: 3000, greedyCandidateLimit: 10, greedyDepthSlack: 3, upperFraction: 0.7
});
verified.clear();
const screenshotActual = replayEveryBranch(screenshotBoard, screenshotTargets, screenshot.policy);
assert.ok(screenshotActual.worst <= 21);
assert.strictEqual(screenshot.certificate.budgetStatus, 'unproven');
assert.strictEqual(screenshot.certificate.provenOptimal, false);
assert.ok(screenshot.certificate.worstCaseLower < 20);

const warmOptions = { ...options, timeLimitMs: 50, maxStageNodes: 1000, maxStageCandidates: 20 };
const warm = engine.solveRefillPolicy(mixed, targets, warmOptions);
const portfolio = engine.solveRefillPolicy(mixed, targets, {
  ...warmOptions, timeLimitMs: 200, warmStartOptions: warmOptions
});
assert.ok(portfolio.certificate.worstCaseUpper <= warm.certificate.worstCaseUpper);
assert.strictEqual(portfolio.certificate.objective, 'worst-case');
console.log(JSON.stringify({ compactBoards: checked, allRefillBranches: branches,
  sampleWorst: actual.worst, sampleExpected: actual.expected, unconditionalCounterexampleLower: 21,
  suppliedScreenshotWorst: screenshotActual.worst,
  elapsedMs: solved.stats.elapsedMs }));
console.log('water_solver_worst_case_test: PASS');
