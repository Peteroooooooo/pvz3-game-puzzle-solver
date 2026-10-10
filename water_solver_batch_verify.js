'use strict';

// Offline verification only. This file is never loaded by the website.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const engine = require('./water_solver_engine');

const FAST_OPTIONS = {
  objective: 'worst-case', moveBudget: 25, includePolicy: true,
  maxStageNodes: 8000, maxStageCandidates: 30, stageDepthSlack: 4,
  maxCandidatesEvaluated: { 4: 2, 3: 2, 2: 3 }, finalNodeLimit: 180000,
  greedyNodeLimit: 3000, greedyCandidateLimit: 10, greedyDepthSlack: 3, upperFraction: 0.7
};
const DEEP_OPTIONS = {
  ...FAST_OPTIONS, maxStageNodes: 70000, maxStageCandidates: 240, stageDepthSlack: 8,
  maxCandidatesEvaluated: { 4: 24, 3: 30, 2: 60 }, finalNodeLimit: 600000,
  greedyNodeLimit: 16000, greedyCandidateLimit: 36, greedyDepthSlack: 6, upperFraction: 0.5
};
function searchOptions(profile, timeLimitMs) {
  if (profile === 'fast') return {...FAST_OPTIONS, timeLimitMs};
  if (profile !== 'balanced') throw new Error(`Unknown profile: ${profile}`);
  const budgetRecoveryOptions = {maxStageNodes:250000,maxStageCandidates:1200,stageDepthSlack:24,
    maxCandidatesEvaluated:{4:120,3:160,2:300},finalNodeLimit:1500000};
  return {
    ...FAST_OPTIONS, timeLimitMs, maxStageNodes:32000, maxStageCandidates:120,
    stageDepthSlack:8, maxCandidatesEvaluated:{4:12,3:12,2:24},finalNodeLimit:300000,
    upperFraction:0.5, warmStartOptions:{...FAST_OPTIONS,timeLimitMs:1000,budgetRecoveryOptions},
    budgetRecoveryOptions
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function shuffle(values, random) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function generateCase(index, seed) {
  const random = seededRandom((seed + Math.imul(index + 1, 2654435761)) >>> 0);
  const colorCount = index % 2 === 0 ? 4 : 5;
  const colors = ['G', 'B', 'O', 'R', 'P'].slice(0, colorCount);
  const hard = index % 4 >= 2;
  for (;;) {
    const units = shuffle(colors.flatMap(color => Array(4).fill(color)), random);
    const board = shuffle(Array.from({ length: 7 }, (_, i) =>
      i < colorCount ? units.slice(i * 4, i * 4 + 4) : []), random);
    const goalColors = shuffle([...colors], random).slice(0, 4);
    const slots = shuffle(hard
      ? board.flatMap((tube, i) => tube.length ? [i] : [])
      : [0, 1, 2, 3, 4, 5, 6], random);
    const targets = goalColors.map((color, i) => ({ tubeIdx: slots[i], color }));
    if (targets.some(target => board[target.tubeIdx].every(c => c === target.color)
      && board[target.tubeIdx].length === 4)) continue;
    // Hard cases begin with all four recipes in full, fragmented tubes, with
    // the wrong bottom color. Each target must remove all four original runs.
    if (hard && targets.some(target => {
      const tube = board[target.tubeIdx];
      return tube[0] === target.color || tube.some((c, i) => i && c === tube[i - 1]);
    })) continue;
    return { index, colorCount, kind: hard ? 'fragmented-wrong-bottom' : 'uniform', board, targets };
  }
}

// These transitions and refill combinations are independent of the search
// engine's move generator, state normalization, and refill implementation.
function stateKey(board, targets) {
  const fixed = [...targets].sort((a,b) => a.tubeIdx - b.tubeIdx);
  const slots = new Set(fixed.map(t => t.tubeIdx));
  return fixed.map(t => `${t.tubeIdx}:${t.color}:${board[t.tubeIdx].join('')}`).join('|')
    + '#' + board.filter((_, i) => !slots.has(i)).map(t => t.join('')).sort().join('|');
}

function independentRefills(board, color, excluded, targets) {
  const outcomes = new Map();
  function visit(tubes, remaining) {
    const available = tubes.flatMap((tube, i) => i !== excluded && tube.length < 4 ? [i] : []);
    if (!remaining || !available.length) { outcomes.set(stateKey(tubes, targets), tubes); return; }
    const count = Math.min(remaining, available.length);
    function choose(start, picked) {
      if (picked.length === count) {
        const next = tubes.map(t => [...t]);
        picked.forEach(i => next[i].push(color));
        visit(next, remaining - count);
        return;
      }
      for (let j = start; j <= available.length - (count - picked.length); j++) {
        choose(j + 1, [...picked, available[j]]);
      }
    }
    choose(0, []);
  }
  visit(board, 4);
  return [...outcomes.values()];
}

function verifyPolicy(fixture, result) {
  assert.ok(result.policy && result.certificate.guaranteed === true);
  const seen = new Map();
  let refillEdges = 0;
  function visit(initial, goals) {
    if (!goals.length) return { worst: 0, refillRounds: 0 };
    const key = stateKey(initial, goals);
    if (seen.has(key)) return seen.get(key);
    const continuation = engine.getPolicyContinuation(result.policy, initial, goals);
    assert.ok(continuation && continuation.plan.length, 'missing policy continuation');
    const board = initial.map(t => [...t]);
    let targets = goals.map(t => ({...t}));
    let clear = null;
    for (const move of continuation.plan) {
      assert.strictEqual(clear, null, 'a stage must stop at its first clear');
      assert.notStrictEqual(move.from, move.to);
      const source = board[move.from], destination = board[move.to];
      assert.ok(source && destination && source.length && destination.length < 4);
      const color = source[source.length - 1];
      assert.ok(!destination.length || destination[destination.length - 1] === color);
      let run = 0;
      for (let i = source.length - 1; i >= 0 && source[i] === color; i--) run++;
      const amount = Math.min(run, 4 - destination.length);
      assert.strictEqual(move.color, color);
      assert.strictEqual(move.amount, amount);
      for (let i = 0; i < amount; i++) destination.push(source.pop());
      const goal = targets.find(t => t.tubeIdx === move.to);
      if (goal && destination.length === 4 && destination.every(c => c === goal.color)) {
        clear = { color: goal.color, tube: move.to };
        board[move.to] = [];
        targets = targets.filter(t => t !== goal);
      }
    }
    assert.ok(clear, 'stage did not complete a recipe');
    let worst = continuation.plan.length, refillRounds = 0;
    if (targets.length) {
      const outcomes = independentRefills(board, clear.color, clear.tube, targets);
      assert.ok(outcomes.length);
      for (const next of outcomes) {
        refillEdges++;
        const child = visit(next, targets);
        assert.strictEqual(child.refillRounds, targets.length - 1);
        worst = Math.max(worst, continuation.plan.length + child.worst);
        refillRounds = 1 + child.refillRounds;
      }
    }
    assert.strictEqual(refillRounds, goals.length - 1);
    assert.ok(worst <= continuation.certificate.worstCaseUpper);
    const value = { worst, refillRounds };
    seen.set(key, value);
    return value;
  }
  const verified = visit(fixture.board, fixture.targets);
  assert.strictEqual(verified.refillRounds, 3);
  assert.strictEqual(verified.worst, result.certificate.worstCaseUpper);
  return { ...verified, policyStates: seen.size, refillEdges };
}

function solveAndVerify(task) {
  const start = performance.now();
  const fixture = task.fixture;
  let result = engine.solveRefillPolicy(fixture.board, fixture.targets, searchOptions(task.profile,task.fastMs));
  const initialWorst = result.certificate.worstCaseUpper;
  let retried = false;
  if (result.certificate.budgetStatus !== 'guaranteed' && task.retryMs > 0) {
    retried = true;
    const deeper = engine.solveRefillPolicy(fixture.board, fixture.targets,
      {...DEEP_OPTIONS, timeLimitMs:task.retryMs, initialIncumbent:result});
    if (deeper.certificate.worstCaseUpper < result.certificate.worstCaseUpper
      || deeper.certificate.budgetStatus === 'guaranteed') result = deeper;
  }
  const verification = result.certificate.guaranteed === true ? verifyPolicy(fixture, result) : null;
  return {
    index:fixture.index, colorCount:fixture.colorCount, kind:fixture.kind,
    status:verification && verification.worst <= 25 ? 'verified' : result.certificate.budgetStatus === 'impossible' ? 'refuted' : 'unresolved',
    initialWorst:Number.isFinite(initialWorst) ? initialWorst : null,
    worst:verification ? verification.worst : null, lower:result.certificate.objectiveLowerBound,
    provenOptimal:result.certificate.provenOptimal, retried,
    budgetRecovery:result.stats.budgetRecoveryElapsedMs > 0,
    budgetSearchElapsedMs:Math.round(result.stats.budgetSearchElapsedMs || 0),
    budgetNodes:result.stats.budgetNodes || 0,
    budgetPeakStates:result.stats.budgetPeakStates || 0,
    budgetAttempts:result.stats.budgetAttempts || [],
    verification, elapsedMs:Math.round(performance.now()-start),
    ...(verification && verification.worst <= 25 ? {} : {board:fixture.board, targets:fixture.targets})
  };
}

if (!isMainThread) {
  parentPort.on('message', task => {
    try { parentPort.postMessage({ result:solveAndVerify(task) }); }
    catch (error) { parentPort.postMessage({ error:error.stack, index:task.fixture.index }); }
  });
} else if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index+1]]);
    return pairs;
  }, []));
  const number = (name, fallback) => {
    const n = args[name] === undefined ? fallback : Number(args[name]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid --${name}`);
    return n;
  };
  const count = number('cases', 1000), seed = number('seed', 250310);
  const profile = args.profile || 'fast';
  const concurrency = number('workers', 2), fastMs = number('fast-ms', profile === 'balanced' ? 4000 : 2500), retryMs = number('retry-ms', 4000);
  searchOptions(profile,fastMs);
  assert.ok(count > 0 && concurrency > 0 && concurrency <= 4);
  const output = path.resolve(args.output || '.codex-water-budget-verification.json');
  const selected = args.indices ? args.indices.split(',').map(Number) : null;
  const fixtures = selected ? selected.map(i => generateCase(i, seed))
    : Array.from({length:count}, (_,i) => generateCase(i,seed));
  assert.strictEqual(new Set(fixtures.map(f=>stateKey(f.board,f.targets))).size,fixtures.length,'duplicate initial boards');
  const results = [], workers = [];
  const started = Date.now();
  let next = 0;
  function report() {
    const histogram = {};
    for (const r of results.filter(r=>r.status === 'verified')) histogram[r.worst] = (histogram[r.worst] || 0) + 1;
    return {
      rules:{tubes:7,capacity:4,recipes:4,initialColors:[4,5],unitsPerColor:4,
        initiallyFilledTubes:[4,5],refillCount:4,refillRounds:3,excluded:'just-cleared tube',moveBudget:25},
      generator:'LCG per case; alternating 4/5 colors; half uniform, half fragmented wrong-bottom goals; no initially completed recipe',
      scope:'Random initial boards; every refill branch of each selected policy is exhaustively checked. Not enumeration of all initial boards.',
      seed, requested:fixtures.length, completed:results.length, workers:concurrency, profile, fastMs,retryMs,
      elapsedMs:Date.now()-started, verified:results.filter(r=>r.status === 'verified').length,
      unresolved:results.filter(r=>r.status === 'unresolved').length, refuted:results.filter(r=>r.status === 'refuted').length,
      retried:results.filter(r=>r.retried).length,
      budgetRecoveries:results.filter(r=>r.budgetRecovery).length,
      policyStates:results.reduce((n,r)=>n+(r.verification?.policyStates || 0),0),
      refillEdges:results.reduce((n,r)=>n+(r.verification?.refillEdges || 0),0),
      histogram, results:[...results].sort((a,b)=>a.index-b.index)
    };
  }
  function checkpoint() {
    const data = report();
    fs.mkdirSync(path.dirname(output), {recursive:true});
    fs.writeFileSync(output,JSON.stringify(data,null,2)+'\n');
    console.log(JSON.stringify({completed:data.completed,requested:data.requested,verified:data.verified,
      unresolved:data.unresolved,refuted:data.refuted,retried:data.retried,elapsedSeconds:Math.round(data.elapsedMs/1000)}));
  }
  try {
    await Promise.all(Array.from({length:Math.min(concurrency,fixtures.length)}, () => new Promise((resolve,reject) => {
      const worker = new Worker(__filename); workers.push(worker);
      function dispatch() {
        if (next >= fixtures.length) { resolve(); return; }
        worker.postMessage({fixture:fixtures[next++],profile,fastMs,retryMs});
      }
      worker.on('error',reject);
      worker.on('message',message => {
        if (message.error) { reject(new Error(`Case ${message.index}: ${message.error}`)); return; }
        results.push(message.result);
        if (results.length % 20 === 0 || results.length === fixtures.length) checkpoint();
        dispatch();
      });
      dispatch();
    })));
    checkpoint();
    if (results.some(r=>r.status !== 'verified')) process.exitCode = 2;
  } finally {
    await Promise.all(workers.map(w=>w.terminate()));
  }
}

module.exports = { generateCase, independentRefills, verifyPolicy, stateKey, searchOptions };
