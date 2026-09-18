const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('pvz3_decode_solver.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, 'decoder script not found');

// Expose top-level state to the VM test harness without changing browser code.
const code = scriptMatch[1].replace(/^(let|const) /gm, 'var ');
const elements = new Map();

function mockElement(id) {
  return {
    id,
    className: '',
    classList: { add() {}, remove() {}, toggle() {}, replace() {} },
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: '',
    appendChild() {},
    addEventListener() {},
    querySelectorAll() { return []; },
    setAttribute() {},
    getBoundingClientRect() { return { left: 0, width: 100 }; }
  };
}

const sandbox = {
  console,
  URL,
  URLSearchParams,
  document: {
    documentElement: { lang: 'zh-CN' },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, mockElement(id));
      return elements.get(id);
    },
    createElement: mockElement,
    querySelectorAll() { return []; }
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  history: { replaceState() {} },
  location: { href: 'https://example.test/pvz3_decode_solver.html' },
  window: {
    location: { href: 'https://example.test/pvz3_decode_solver.html', search: '' },
    addEventListener() {},
    onload: null
  },
  alert() {},
  setTimeout() { return 0; },
  clearTimeout() {}
};

const context = vm.createContext(sandbox);
vm.runInContext(code, context);

function setCurrentGuess(guess, feedback) {
  context.currentGuess = guess.map((fusion, index) => ({
    p1: fusion[0],
    p2: fusion[1],
    fb: feedback[index]
  }));
}

function addLocks(locks, guess, feedback) {
  const next = locks.slice();
  feedback.forEach((value, index) => {
    if (value === 'CORRECT') next[index] = guess[index];
  });
  return next;
}

function configure(rounds, locks, pool, guess, feedback) {
  context.historyRounds = rounds.map(round => ({
    guess: round.guess.slice(),
    fb: round.fb.slice(),
    candsAfter: round.candsAfter
  }));
  context.lockedSlots = locks.slice();
  context.candidates = pool.slice();
  context.activeFeedbackMode = 'strict_exact';
  setCurrentGuess(guess, feedback);
}

function playInformationRound(state, guess, secret) {
  const feedback = context.evaluateFeedback(guess, secret, 'strict_exact');
  const pool = context.filterCandidatesByRound(state.pool, guess, feedback, 'strict_exact');
  const locks = addLocks(state.locks, guess, feedback);
  const rounds = state.rounds.concat([{ guess, fb: feedback, candsAfter: pool.length }]);
  return { pool, locks, rounds, guess, feedback };
}

const allSecrets = context.buildCandidateSpace();
const allProbes = context.buildProbeSpace();
assert.strictEqual(allSecrets.length, 11880);
assert.strictEqual(allProbes.length, 20736);
assert(allSecrets.every(secret => new Set(Array.from(secret)).size === 4));

const opening = Array.from(context.GUARANTEED_OPENING_GUESS);
const screenshotFeedback = ['ALL_WRONG', 'PARTIAL', 'CORRECT', 'WRONG_SLOT'];
const screenshotBranch = context.filterCandidatesByRound(allSecrets, opening, screenshotFeedback, 'strict_exact');
const screenshotLocks = addLocks([null, null, null, null], opening, screenshotFeedback);
const screenshotRounds = [{ guess: opening, fb: screenshotFeedback, candsAfter: screenshotBranch.length }];

configure(screenshotRounds, screenshotLocks, screenshotBranch, opening, screenshotFeedback);
const repairedSecondGuess = Array.from(context.calculateNextBestGuess(screenshotBranch, opening));
assert.deepStrictEqual(repairedSecondGuess, ['CC', 'WW', 'PC', 'PP']);
assert.strictEqual(screenshotBranch.length, 56);
assert.strictEqual(Object.keys(context.LOCK_AWARE_SECOND_GUESS_OVERRIDES).length, 76);

function replayReportedHistory(rounds) {
  let pool = allSecrets;
  for (const round of rounds) {
    pool = context.filterCandidatesByRound(pool, round.guess, round.feedback, 'strict_exact');
  }
  return Array.from(pool, secret => Array.from(secret));
}

// The first reported fifth-round collision only existed because the old model
// admitted the impossible duplicate answer [CW, WK, PC, PC].
const firstReportedPool = replayReportedHistory([
  { guess: ['SP', 'SW', 'PC', 'CW'], feedback: ['ALL_WRONG', 'PARTIAL', 'CORRECT', 'WRONG_SLOT'] },
  { guess: ['CC', 'WW', 'PC', 'WK'], feedback: ['PARTIAL', 'PARTIAL', 'CORRECT', 'WRONG_SLOT'] },
  { guess: ['SS', 'PP', 'PC', 'PW'], feedback: ['ALL_WRONG', 'ALL_WRONG', 'CORRECT', 'PARTIAL'] }
]);
assert.deepStrictEqual(firstReportedPool, [['CW', 'WK', 'PC', 'PK']]);

// The later old-strategy history still has two legal answers. The regenerated
// strategy must take a different path and distinguish both after three feedbacks.
const latestReportedPool = replayReportedHistory([
  { guess: ['SP', 'SW', 'PC', 'CW'], feedback: ['CORRECT', 'WRONG_SLOT', 'PARTIAL', 'PARTIAL'] },
  { guess: ['SP', 'PW', 'PP', 'PK'], feedback: ['CORRECT', 'WRONG_SLOT', 'PARTIAL', 'ALL_WRONG'] },
  { guess: ['SP', 'SS', 'CC', 'WW'], feedback: ['CORRECT', 'ALL_WRONG', 'ALL_WRONG', 'PARTIAL'] }
]);
assert.deepStrictEqual(
  latestReportedPool.map(secret => secret.join('|')).sort(),
  ['SP|KK|PW|SW', 'SP|WK|PW|SW'].sort()
);

for (const secret of latestReportedPool) {
  let state = { pool: allSecrets, locks: [null, null, null, null], rounds: [] };
  state = playInformationRound(state, opening, secret);

  configure(state.rounds, state.locks, state.pool, opening, state.feedback);
  const secondGuess = Array.from(context.calculateNextBestGuess(state.pool, opening));

  state = playInformationRound(state, secondGuess, secret);
  configure(state.rounds, state.locks, state.pool, secondGuess, state.feedback);
  const thirdGuess = Array.from(context.calculateNextBestGuess(state.pool, secondGuess));

  state = playInformationRound(state, thirdGuess, secret);
  assert.strictEqual(state.pool.length, 1);
  assert.deepStrictEqual(Array.from(state.pool[0]), secret);
}

// Every generated override must preserve slots already made permanent by the
// opening feedback. This catches accidental table edits immediately.
for (const [key, guess] of Object.entries(context.LOCK_AWARE_SECOND_GUESS_OVERRIDES)) {
  key.split('|').forEach((feedback, index) => {
    if (feedback === 'CORRECT') assert.strictEqual(guess[index], opening[index], key);
  });
}

function partitionByFeedback(pool, guess) {
  const branches = new Map();
  for (const secret of pool) {
    const feedback = Array.from(context.evaluateFeedback(guess, secret, 'strict_exact'));
    const key = feedback.join('|');
    if (!branches.has(key)) branches.set(key, { feedback, pool: [] });
    branches.get(key).pool.push(secret);
  }
  return Array.from(branches.values());
}

function isSolvedFeedback(feedback) {
  return feedback.every(value => value === 'CORRECT');
}

// Exhaust the complete decision tree. There are three information rounds; a
// singleton after the third feedback is submitted as the answer in round four.
const completedAt = { 1: 0, 2: 0, 3: 0, 4: 0 };
let afterOpening = [];
for (const branch of partitionByFeedback(allSecrets, opening)) {
  const locks = addLocks([null, null, null, null], opening, branch.feedback);
  const rounds = [{ guess: opening, fb: branch.feedback, candsAfter: branch.pool.length }];
  if (isSolvedFeedback(branch.feedback)) completedAt[1] += branch.pool.length;
  else if (branch.pool.length === 1) completedAt[2] += 1;
  else afterOpening.push({ pool: branch.pool, locks, rounds });
}

const afterSecondProbe = [];
for (const state of afterOpening) {
  const last = state.rounds[state.rounds.length - 1];
  configure(state.rounds, state.locks, state.pool, last.guess, last.fb);
  const secondGuess = Array.from(context.calculateNextBestGuess(state.pool, last.guess));

  for (const branch of partitionByFeedback(state.pool, secondGuess)) {
    const locks = addLocks(state.locks, secondGuess, branch.feedback);
    const rounds = state.rounds.concat([{
      guess: secondGuess,
      fb: branch.feedback,
      candsAfter: branch.pool.length
    }]);
    if (isSolvedFeedback(branch.feedback)) completedAt[2] += branch.pool.length;
    else if (branch.pool.length === 1) completedAt[3] += 1;
    else afterSecondProbe.push({ pool: branch.pool, locks, rounds });
  }
}

for (const state of afterSecondProbe) {
  const last = state.rounds[state.rounds.length - 1];
  configure(state.rounds, state.locks, state.pool, last.guess, last.fb);
  const separator = Array.from(context.calculateNextBestGuess(state.pool, last.guess));

  for (const branch of partitionByFeedback(state.pool, separator)) {
    assert.strictEqual(branch.pool.length, 1, 'Third-round probe did not identify a unique answer');
    if (isSolvedFeedback(branch.feedback)) completedAt[3] += 1;
    else completedAt[4] += 1;
  }
}

assert.strictEqual(Object.values(completedAt).reduce((sum, count) => sum + count, 0), 11880);
assert.deepStrictEqual(completedAt, { 1: 1, 2: 47, 3: 5451, 4: 6381 });

console.log('Decoder regression and exhaustive 11,880-secret tests passed.');
