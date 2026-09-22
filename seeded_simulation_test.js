'use strict';

const assert = require('assert');
const engine = require('./water_solver_engine.js');

const CAPACITY = 4;
const REFILL_COUNT = 4;
const MAX_STEPS = 80;
const SAMPLE_BOARD = [
  ['G', 'B', 'O', 'R'],
  ['B', 'O', 'R', 'G'],
  ['O', 'R', 'G', 'B'],
  ['R', 'G', 'B', 'O'],
  [],
  [],
  []
];
const SAMPLE_TARGETS = [
  { tubeIdx: 0, color: 'G' },
  { tubeIdx: 1, color: 'B' },
  { tubeIdx: 2, color: 'O' },
  { tubeIdx: 3, color: 'R' }
];
const TEST_SEEDS = Array.from({ length: 2048 }, (_, index) => 0x5eed0000 + index * 0x9e37);

function cloneTubes(tubes) {
  return tubes.map(tube => [...tube]);
}

function cloneTargets(targets) {
  return targets.map(target => ({ ...target }));
}

function mixSeed(seed, stage) {
  let value = (seed ^ Math.imul(stage + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function applySeededRefill(tubes, color, excludedTube, seed, stage) {
  const random = mulberry32(mixSeed(seed, stage));
  let drops = 0;

  while (drops < REFILL_COUNT) {
    const available = engine.getRefillAvailableTubes(tubes, excludedTube, CAPACITY);
    if (available.length === 0) break;
    shuffle(available, random);
    const picked = available.slice(0, Math.min(available.length, REFILL_COUNT - drops));
    for (const tubeIdx of picked) {
      tubes[tubeIdx].push(color);
      drops++;
    }
  }

  return drops;
}

function strategyOptions(strategy) {
  const shielding = strategy === 'shield';
  return {
    timeLimitMs: 0,
    maxStageNodes: shielding ? 30000 : 120000,
    maxStageCandidates: shielding ? 80 : 160,
    stageDepthSlack: shielding ? 5 : 0
  };
}

function solveStage(tubes, targets, strategy, cache, policyByKey) {
  if (strategy === 'policy') {
    const key = engine.canonicalStateKey(tubes, targets);
    const entry = policyByKey.get(key);
    assert.ok(entry, `missing contingent policy entry for ${key}`);
    const plan = engine.remapPolicyPlan(entry, tubes, targets, CAPACITY);
    assert.ok(plan && plan.length > 0, `could not remap contingent policy entry for ${key}`);
    return { plan, certificate: {} };
  }

  const key = `${strategy}:${engine.orderedStateKey(tubes, targets)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const result = engine.solveNextClearFast(tubes, targets, strategyOptions(strategy));
  cache.set(key, result);
  return result;
}

function replayUntilClear(tubes, targets, plan) {
  let nextTubes = cloneTubes(tubes);
  let nextTargets = cloneTargets(targets);

  for (let index = 0; index < plan.length; index++) {
    const legal = engine.generateLegalMoves(nextTubes, nextTargets, CAPACITY);
    const move = plan[index];
    assert.ok(
      legal.some(candidate => candidate.from === move.from
        && candidate.to === move.to
        && candidate.color === move.color
        && candidate.amount === move.amount),
      `illegal move ${move.from}->${move.to}`
    );

    const applied = engine.applyMoveAndClear(nextTubes, nextTargets, move, CAPACITY);
    nextTubes = applied.tubes;
    nextTargets = applied.targets;
    if (applied.record.clearedColor) {
      return {
        tubes: nextTubes,
        targets: nextTargets,
        steps: index + 1,
        clearedTube: applied.record.clearedTube,
        clearedColor: applied.record.clearedColor
      };
    }
  }

  return null;
}

function simulate(seed, strategy, cache, policyByKey = new Map()) {
  let tubes = cloneTubes(SAMPLE_BOARD);
  let targets = cloneTargets(SAMPLE_TARGETS);
  let steps = 0;
  let refillDrops = 0;
  let refillBranches = 0;
  let fullShields = 0;
  let stage = 0;

  while (targets.length > 0 && steps < MAX_STEPS) {
    const solved = solveStage(tubes, targets, strategy, cache, policyByKey);
    if (!solved.plan || solved.plan.length === 0) break;

    const replayed = replayUntilClear(tubes, targets, solved.plan);
    assert.ok(replayed, `${strategy} seed ${seed} plan did not clear a target`);
    assert.strictEqual(replayed.steps, solved.plan.length);

    tubes = replayed.tubes;
    targets = replayed.targets;
    steps += replayed.steps;
    fullShields += tubes.reduce((count, tube, tubeIdx) => (
      tubeIdx !== replayed.clearedTube && tube.length === CAPACITY ? count + 1 : count
    ), 0);

    if (targets.length > 0) {
      const outcomes = engine.enumerateRefillOutcomes(
        tubes,
        replayed.clearedColor,
        replayed.clearedTube,
        { capacity: CAPACITY, refillCount: REFILL_COUNT, targets }
      );
      refillBranches += outcomes.length;
      refillDrops += applySeededRefill(
        tubes,
        replayed.clearedColor,
        replayed.clearedTube,
        seed,
        stage
      );
    }
    stage++;
  }

  return {
    seed,
    won: targets.length === 0,
    steps,
    clears: SAMPLE_TARGETS.length - targets.length,
    refillDrops,
    refillBranches,
    fullShields
  };
}

function summarize(results) {
  const wins = results.filter(result => result.won);
  const average = (field, rows = wins) => rows.length === 0
    ? null
    : rows.reduce((sum, row) => sum + row[field], 0) / rows.length;

  return {
    games: results.length,
    wins: wins.length,
    winRate: wins.length / results.length,
    averageSteps: average('steps'),
    averageRefillDrops: average('refillDrops'),
    averageRefillBranches: average('refillBranches'),
    averageFullShields: average('fullShields'),
    maxSteps: wins.length === 0 ? null : Math.max(...wins.map(result => result.steps))
  };
}

function comparePaired(reference, candidate) {
  let better = 0;
  let equal = 0;
  let worse = 0;
  let totalDelta = 0;
  const deltas = [];
  for (let index = 0; index < reference.length; index++) {
    const delta = candidate[index].steps - reference[index].steps;
    deltas.push(delta);
    totalDelta += delta;
    if (delta < 0) better++;
    else if (delta > 0) worse++;
    else equal++;
  }
  const averageStepDelta = totalDelta / reference.length;
  const deltaVariance = deltas.reduce(
    (sum, delta) => sum + (delta - averageStepDelta) ** 2,
    0
  ) / (deltas.length - 1);
  const standardError = Math.sqrt(deltaVariance / deltas.length);
  const referenceMean = reference.reduce((sum, result) => sum + result.steps, 0)
    / reference.length;
  return {
    better,
    equal,
    worse,
    averageStepDelta,
    relativeStepChangePercent: averageStepDelta / referenceMean * 100,
    paired95PercentInterval: [
      averageStepDelta - 1.96 * standardError,
      averageStepDelta + 1.96 * standardError
    ]
  };
}

function runSuite() {
  const cache = new Map();
  const policyResult = engine.solveRefillPolicy(SAMPLE_BOARD, SAMPLE_TARGETS, {
    timeLimitMs: 0,
    maxStageNodes: 8000,
    maxStageCandidates: 30,
    stageDepthSlack: 4,
    maxCandidatesEvaluated: { 4: 2, 3: 2, 2: 3 },
    finalNodeLimit: 100000,
    greedyNodeLimit: 3000,
    greedyCandidateLimit: 10,
    greedyDepthSlack: 3,
    includePolicy: true
  });
  assert.strictEqual(policyResult.certificate.guaranteed, true);
  assert.ok(policyResult.policy && policyResult.policy.entries.length > 0);
  const policyByKey = new Map(
    policyResult.policy.entries.map(entry => [entry.canonicalKey, entry])
  );
  const baseline = TEST_SEEDS.map(seed => simulate(seed, 'baseline', cache));
  const shield = TEST_SEEDS.map(seed => simulate(seed, 'shield', cache));
  const policy = TEST_SEEDS.map(seed => simulate(seed, 'policy', cache, policyByKey));
  return {
    seeds: TEST_SEEDS.length,
    baseline: summarize(baseline),
    shield: summarize(shield),
    policy: summarize(policy),
    policyCertificate: policyResult.certificate,
    policyEntries: policyResult.policy.entries.length,
    shieldVsBaseline: comparePaired(baseline, shield),
    policyVsBaseline: comparePaired(baseline, policy)
  };
}

const report = runSuite();
assert.strictEqual(report.baseline.wins, TEST_SEEDS.length, 'baseline must clear every seed');
assert.strictEqual(report.shield.wins, TEST_SEEDS.length, 'shield strategy must clear every seed');
assert.strictEqual(report.policy.wins, TEST_SEEDS.length, 'bounded policy must clear every seed');
assert.strictEqual(
  report.policyCertificate.refillOutcomeCount,
  1,
  'policy should lock the first refill to one possible outcome'
);
assert.strictEqual(
  report.policyCertificate.eligibleRefillTubes,
  REFILL_COUNT,
  'locked refill should leave exactly one eligible tube per refill drop'
);
assert.strictEqual(report.policyCertificate.nextClearSteps, 10);
assert.ok(report.shield.averageRefillBranches < report.baseline.averageRefillBranches);
assert.ok(
  report.policy.averageSteps < report.baseline.averageSteps,
  'bounded policy should beat the immediate-clear baseline on the fixed seed corpus'
);
assert.ok(
  report.policyVsBaseline.better > report.policyVsBaseline.worse,
  'bounded policy should win more paired seeds than it loses'
);
assert.ok(
  report.policyVsBaseline.paired95PercentInterval[1] < 0,
  'paired seed improvement should remain below zero across the 95% interval'
);
assert.ok(
  report.policy.maxSteps <= report.policyCertificate.worstCaseUpper,
  'observed policy path exceeded its certified worst-case upper bound'
);
assert.ok(
  report.policy.averageSteps <= report.policyCertificate.upperBound + 0.05,
  'seeded mean is inconsistent with the certified expected upper bound'
);
assert.ok(report.policy.averageSteps < 19.25, 'locked-refill policy regressed on fixed seeds');
assert.ok(report.policy.maxSteps <= 20, 'locked-refill worst case regressed on fixed seeds');

console.log(JSON.stringify(report, null, 2));
console.log('seeded_simulation_test: PASS');
