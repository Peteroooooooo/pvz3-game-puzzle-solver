'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('./water_solver_engine.js');

const projectDir = __dirname;
const htmlPath = path.join(projectDir, 'pvz3_water_sort_solver.html');
const html = fs.readFileSync(htmlPath, 'utf8');

assert.ok(html.includes('<script src="./water_solver_engine.js"></script>'));
assert.ok(html.includes('value="exact_refill" selected'));
assert.ok(html.includes('value="static_optimal"'));
assert.ok(html.includes('id="solverCertificate"'));
assert.ok(html.includes('id="btnAutoPlay"'));
assert.ok(html.includes('id="inputAutoPlaySeconds"'));
assert.ok(html.includes('value="2" min="0.1" max="60" step="0.1"'));
assert.ok(html.includes('function runAutoPlayStep()'));
assert.ok(html.includes('completedMove.clearedColor'));

const autoPlayStart = html.indexOf('function runAutoPlayStep()');
const autoPlayEnd = html.indexOf('function updateNavButtonStates()', autoPlayStart);
assert.ok(autoPlayStart >= 0 && autoPlayEnd > autoPlayStart);
assert.ok(
  !html.slice(autoPlayStart, autoPlayEnd).includes('executeRandomRefill'),
  'automatic step playback must never trigger refill simulation'
);

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(inlineScripts.length > 0);
for (const [, source] of inlineScripts) {
  assert.doesNotThrow(() => new Function(source));
}

const sampleBoard = [
  ['G', 'B', 'O', 'R'],
  ['B', 'O', 'R', 'G'],
  ['O', 'R', 'G', 'B'],
  ['R', 'G', 'B', 'O'],
  [], [], []
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
assert.strictEqual(staticResult.plan.length, 13);
assert.strictEqual(staticResult.certificate.provenOptimal, true);

const fastResult = engine.solveNextClearFast(sampleBoard, sampleTargets, {
  timeLimitMs: 150,
  maxStageNodes: 10000,
  maxStageCandidates: 30,
  stageDepthSlack: 4
});
assert.ok(fastResult.plan.length > 0);
assert.ok(fastResult.plan[fastResult.plan.length - 1].clearedColor);

const policyResult = engine.solveRefillPolicy(sampleBoard, sampleTargets, {
  timeLimitMs: 1000,
  maxStageNodes: 7000,
  maxStageCandidates: 24,
  maxCandidatesEvaluated: { 4: 3, 3: 3, 2: 5 },
  finalNodeLimit: 80000,
  greedyNodeLimit: 5000,
  greedyCandidateLimit: 10,
  upperFraction: 0.7
});
assert.ok(policyResult.plan.length > 0);
assert.ok(policyResult.certificate.lowerBound > 0);

console.log(JSON.stringify({
  staticShortest: staticResult.plan.length,
  staticProven: staticResult.certificate.provenOptimal,
  nextClearSteps: policyResult.plan.length,
  deliberateSetupSteps: policyResult.certificate.deliberateSetupSteps,
  fullShields: policyResult.certificate.fullShieldCount,
  refillOutcomes: policyResult.certificate.refillOutcomeCount,
  guaranteed: policyResult.certificate.guaranteed,
  expectedLower: policyResult.certificate.lowerBound,
  expectedUpper: Number.isFinite(policyResult.certificate.upperBound)
    ? policyResult.certificate.upperBound
    : null
}, null, 2));
console.log('smoke_test: PASS');
