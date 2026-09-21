'use strict';

const assert = require('assert');
const engine = require('./water_solver_engine.js');

function probabilitySum(outcomes) {
  return outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
}

function assertProbabilityDistribution(tubes, expectedCount, targets = []) {
  const outcomes = engine.enumerateRefillOutcomes(tubes, 'R', 6, {
    capacity: 4,
    refillCount: 4,
    targets
  });
  assert.strictEqual(outcomes.length, expectedCount);
  assert.ok(Math.abs(probabilitySum(outcomes) - 1) < 1e-12);
  for (const outcome of outcomes) {
    assert.deepStrictEqual(outcome.tubes[6], []);
    for (let index = 0; index < 6; index++) {
      assert.ok(outcome.tubes[index].length <= 4);
    }
  }
}

assertProbabilityDistribution([
  ['G', 'G'], ['B', 'B'], ['O', 'O'], ['P', 'P'], ['G', 'B'], ['O', 'P'], []
], 15);

assertProbabilityDistribution([
  ['G', 'G', 'G', 'G'], ['B', 'B'], ['O', 'O'], ['P', 'P'], ['G'], ['B'], []
], 5);

assertProbabilityDistribution([
  ['G', 'G', 'G', 'G'], ['B', 'B', 'B', 'B'], ['O'], ['P'], ['G'], ['B'], []
], 1);

assertProbabilityDistribution([
  ['G', 'G', 'G', 'G'], ['B', 'B', 'B', 'B'], ['O', 'O', 'O', 'O'], [], [], [], []
], 3, [
  { tubeIdx: 3, color: 'G' },
  { tubeIdx: 4, color: 'B' },
  { tubeIdx: 5, color: 'O' }
]);

const sampleBoard = [
  ['G', 'B', 'O', 'R'],
  ['B', 'O', 'R', 'G'],
  ['O', 'R', 'G', 'B'],
  ['R', 'G', 'B', 'O'],
  [],
  [],
  []
];
const sampleTargets = [
  { tubeIdx: 0, color: 'G' },
  { tubeIdx: 1, color: 'B' },
  { tubeIdx: 2, color: 'O' },
  { tubeIdx: 3, color: 'R' }
];

const staticResult = engine.solveStaticOptimal(sampleBoard, sampleTargets, {
  timeLimitMs: 10000,
  finalNodeLimit: 1000000
});
assert.strictEqual(staticResult.certificate.provenOptimal, true);
assert.strictEqual(staticResult.plan.length, 13);
assert.strictEqual(staticResult.certificate.lowerBound, 13);
assert.strictEqual(staticResult.certificate.upperBound, 13);

let replayTubes = sampleBoard.map(tube => [...tube]);
let replayTargets = sampleTargets.map(target => ({ ...target }));
for (const move of staticResult.plan) {
  const legal = engine.generateLegalMoves(replayTubes, replayTargets);
  assert.ok(legal.some(candidate => (
    candidate.from === move.from
    && candidate.to === move.to
    && candidate.color === move.color
    && candidate.amount === move.amount
  )));
  const next = engine.applyMoveAndClear(replayTubes, replayTargets, move);
  replayTubes = next.tubes;
  replayTargets = next.targets;
}
assert.strictEqual(replayTargets.length, 0);

const refillResult = engine.solveRefillPolicy(sampleBoard, sampleTargets, {
  timeLimitMs: 6000,
  maxStageNodes: 20000,
  maxStageCandidates: 60,
  maxCandidatesEvaluated: { 4: 6, 3: 5, 2: 10 },
  finalNodeLimit: 180000,
  greedyNodeLimit: 7000,
  greedyCandidateLimit: 14,
  upperFraction: 0.7
});
assert.ok(refillResult.plan.length > 0);
assert.ok(refillResult.plan[refillResult.plan.length - 1].clearedColor);
assert.ok(refillResult.certificate.lowerBound > 0);
assert.ok(refillResult.certificate.shortestClearDepth > 0);
assert.strictEqual(refillResult.certificate.guaranteed, true);
assert.ok(Number.isFinite(refillResult.certificate.upperBound));

let refillReplayTubes = sampleBoard.map(tube => [...tube]);
let refillReplayTargets = sampleTargets.map(target => ({ ...target }));
for (const move of refillResult.plan) {
  const legal = engine.generateLegalMoves(refillReplayTubes, refillReplayTargets);
  assert.ok(legal.some(candidate => (
    candidate.from === move.from
    && candidate.to === move.to
    && candidate.color === move.color
    && candidate.amount === move.amount
  )));
  const next = engine.applyMoveAndClear(refillReplayTubes, refillReplayTargets, move);
  refillReplayTubes = next.tubes;
  refillReplayTargets = next.targets;
}
assert.strictEqual(refillReplayTargets.length, sampleTargets.length - 1);

console.log(JSON.stringify({
  static: {
    steps: staticResult.plan.length,
    proven: staticResult.certificate.provenOptimal,
    nodes: staticResult.stats.staticNodes,
    elapsedMs: staticResult.stats.elapsedMs
  },
  refill: {
    nextClearSteps: refillResult.plan.length,
    certificate: refillResult.certificate,
    stats: refillResult.stats
  }
}, null, 2));
console.log('water_solver_engine_test: PASS');
