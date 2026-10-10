'use strict';
const assert = require('assert');
const engine = require('./water_solver_engine');
const { verifyPolicy, searchOptions } = require('./water_solver_batch_verify');

// Independent exhaustive minimax oracle for small three-recipe games.
// This does not use the engine's moves, clears, refills, pruning or bounds.
function key(board, goals) {
  const active = new Set(goals.map(g => g.tubeIdx));
  return goals.map(g => `${g.tubeIdx}:${g.color}:${board[g.tubeIdx].join('')}`).join('|')
    + '#' + board.filter((_, i) => !active.has(i)).map(t => t.join('')).sort().join('|');
}
function normalize(board, goals) {
  const tubes = board.map(t => [...t]);
  const targets = goals.filter(g => {
    if (tubes[g.tubeIdx].length === 2 && tubes[g.tubeIdx].every(c => c === g.color)) {
      tubes[g.tubeIdx] = []; return false;
    }
    return true;
  });
  return { board: tubes, goals: targets };
}
function moves(board, goals) {
  const result = [];
  for (let from = 0; from < board.length; from++) {
    const source = board[from];
    if (!source.length) continue;
    const color = source[source.length - 1];
    let run = 1;
    while (run < source.length && source[source.length - 1 - run] === color) run++;
    for (let to = 0; to < board.length; to++) {
      const dest = board[to];
      if (to === from || dest.length === 2 || (dest.length && dest[dest.length - 1] !== color)) continue;
      const amount = Math.min(run, 2 - dest.length);
      const next = board.map(t => [...t]);
      next[from].splice(-amount); next[to].push(...Array(amount).fill(color));
      const clear = goals.find(g => g.tubeIdx === to && g.color === color && next[to].length === 2);
      if (clear) next[to] = [];
      result.push({ board: next, goals: clear ? goals.filter(g => g !== clear) : goals,
        clearedTube: to, clearedColor: clear ? color : null });
    }
  }
  return result;
}
function refills(board, color, excluded, goals) {
  const seen = new Map();
  function visit(tubes, count) {
    const eligible = tubes.flatMap((t, i) => i !== excluded && t.length < 2 ? [i] : []);
    if (!count || !eligible.length) { seen.set(key(tubes, goals), tubes); return; }
    const needed = Math.min(count, eligible.length);
    function choose(start, picked) {
      if (picked.length === needed) {
        const next = tubes.map(t => [...t]); picked.forEach(i => next[i].push(color));
        visit(next, count - needed); return;
      }
      for (let i = start; i <= eligible.length - (needed - picked.length); i++) {
        choose(i + 1, [...picked, eligible[i]]);
      }
    }
    choose(0, []);
  }
  visit(board, 2); return [...seen.values()];
}
const memo = new Map();
function exactWorst(board, goals) {
  const start = normalize(board, goals);
  if (!start.goals.length) return 0;
  const rootKey = key(start.board, start.goals);
  if (memo.has(rootKey)) return memo.get(rootKey);
  const queue = [{ ...start, depth: 0 }];
  const seen = new Set([rootKey]);
  let best = Infinity;
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head];
    if (state.depth + 1 >= best) continue;
    for (const next of moves(state.board, state.goals)) {
      if (next.clearedColor) {
        let worst = 0;
        if (next.goals.length) for (const outcome of refills(next.board, next.clearedColor,
          next.clearedTube, next.goals)) {
          worst = Math.max(worst, exactWorst(outcome, next.goals));
        }
        best = Math.min(best, state.depth + 1 + worst);
      } else {
        const stateKey = key(next.board, next.goals);
        if (!seen.has(stateKey)) {
          seen.add(stateKey); queue.push({ ...next, depth: state.depth + 1 });
        }
      }
    }
  }
  memo.set(rootKey, best); return best;
}
const compactOptions = { capacity: 2, refillCount: 2, objective: 'worst-case', includePolicy: true,
  timeLimitMs: 0, maxStageNodes: 100000, maxStageCandidates: 1,
  maxLockedCandidates: 0, maxCandidatesEvaluated: { 3: 0, 2: 0 },
  maxLockedCandidatesEvaluated: 0, stageDepthSlack: 0,
  greedyNodeLimit: 1, greedyCandidateLimit: 1, finalNodeLimit: 100000 };
const goals = ['A', 'B', 'C'].map((color, tubeIdx) => ({ color, tubeIdx }));
let searches = 0;
for (const order of ['ABACBC', 'ABCABC', 'ABCCBA', 'BACACB', 'BCAABC', 'BCACAB', 'CABABC', 'CBAACB']) {
  const board = [order.slice(0, 2).split(''), order.slice(2, 4).split(''), order.slice(4).split(''), [], []];
  const exact = exactWorst(board, goals);
  for (const budget of [exact, exact - 1]) {
    const result = engine.solveRefillPolicy(board, goals, { ...compactOptions, moveBudget: budget });
    if (budget === exact) {
      assert.strictEqual(result.certificate.worstCaseUpper, exact, order);
      assert.strictEqual(result.certificate.budgetStatus, 'guaranteed', order);
    } else {
      assert.strictEqual(result.certificate.budgetStatus, 'impossible', order);
      assert.strictEqual(result.certificate.worstCaseLower, exact, order);
    }
    searches += result.stats.budgetStates || 0;
  }
}
assert.ok(searches > 0, 'must exercise the budget search rather than only the legacy shortlist');

const board = [['G','B','O','R'],['B','O','R','G'],['O','R','G','B'],['R','G','B','O'],[],[],[]];
const targets = ['G','B','O','R'].map((color,tubeIdx)=>({color,tubeIdx}));
const incumbent = engine.solveRefillPolicy(board, targets, {
  ...searchOptions('fast', 4000), budgetSearch: false });
const interrupted = engine.solveRefillPolicy(board, targets, {
  ...searchOptions('fast', 4000), timeLimitMs: 0, maxStageNodes: 1,
  greedyNodeLimit: 1, initialIncumbent: incumbent });
assert.strictEqual(interrupted.stats.budgetAttempts.at(-1).status, 'unknown');
assert.strictEqual(interrupted.certificate.worstCaseUpper, incumbent.certificate.worstCaseUpper);
assert.strictEqual(interrupted.certificate.worstCaseLower, incumbent.certificate.worstCaseLower);
assert.ok(verifyPolicy({ board, targets }, interrupted).worst <= incumbent.certificate.worstCaseUpper);
console.log(JSON.stringify({ compactGames: 8, budgetChecks: 16, budgetStates: searches,
  retainedWorstOnExhaustion: interrupted.certificate.worstCaseUpper }));
console.log('water_solver_budget_search_test: PASS');
