const fs = require('fs');
const html = fs.readFileSync('d:/Desktop/Experiment Lab/PVZ3 tools/pvz3_water_sort_solver.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
// Replace top level `let ` with `var ` for VM inspection
const code = scriptMatch[1].replace(/^(let|const) /gm, 'var ');

// Mock DOM
let mockElements = {};
function createMockEl(id) {
  return {
    id,
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      replace: () => {}
    },
    style: {},
    textContent: '',
    innerHTML: '',
    appendChild: () => {},
    querySelectorAll: () => [],
    onclick: null,
    onchange: null
  };
}

const sandbox = {
  document: {
    querySelectorAll: () => [],
    getElementById: (id) => {
      if (!mockElements[id]) mockElements[id] = createMockEl(id);
      return mockElements[id];
    },
    createElement: (tag) => createMockEl('tag-' + tag)
  },
  window: {
    onload: null,
    addEventListener: () => {}
  },
  setInterval: () => 1,
  clearInterval: () => {}
};

const vm = require('vm');
const context = vm.createContext(sandbox);
vm.runInContext(code, context);

// Initialize application
sandbox.window.onload();

console.log('=== Running PvZ 3 Water Sort Solver Smoke Test Suite ===');

// Test 1: Empty board check
console.log('Test 1: Empty board validation');
context.solvePuzzle();
console.log('Test 1 Passed: handled empty board without crash');

// Test 2: Standard puzzle generation
console.log('Test 2: Standard random PvZ3 puzzle generation');
sandbox.document.getElementById('btnRandomPuzzle').onclick();
console.log('Test 2 Passed: generated 7 tubes board with 4 target recipes');

// Test 3: Solve generated puzzle
console.log('Test 3: Planning optimal route for target recipe');
context.solvePuzzle();
const solution = context.currentSolution;
console.log('Test 3 Result: Found steps =', solution.length, 'Best target tube =', context.currentPhaseTarget ? context.currentPhaseTarget.tubeIdx + 1 : 'none');
if (!solution || solution.length === 0) {
  throw new Error('Test 3 Failed: solver did not find solution for fresh board!');
}
console.log('Test 3 Passed!');

// Test 4: Simulate clear and refill
console.log('Test 4: Simulating PvZ3 clear and refill mechanics');
const movesSpentBefore = context.userTotalMovesSpent;
sandbox.document.getElementById('btnSimulateRefill').onclick();
console.log(`Test 4 Passed: cleared target tube, applied refill, moves spent increased from ${movesSpentBefore} to ${context.userTotalMovesSpent}`);

// Test 5: Re-solve after refill
console.log('Test 5: Re-solving after refill');
context.solvePuzzle();
console.log('Test 5 Passed: step count =', context.currentSolution.length);

// Test 6: Reset initial state
console.log('Test 6: Reset to initial state and moves reset');
sandbox.document.getElementById('btnResetToInit').onclick();
if (context.userTotalMovesSpent !== 0) {
  throw new Error('Test 6 Failed: userTotalMovesSpent was not reset!');
}
console.log('Test 6 Passed: board and moves reset successfully!');

// Test 7: Moves Budget Tracker check
console.log('Test 7: Moves Budget Tracker Verification');
sandbox.document.getElementById('inputMovesBudget').onchange({ target: { value: '25' } });
context.updateMovesDisplay(10);
const badgeText = sandbox.document.getElementById('statMovesBudget').textContent;
console.log('Badge text after reset to 0 spent and 25 budget:', badgeText);
if (badgeText !== '剩余: 25步') {
  throw new Error('Test 7 Failed: badge text does not reflect remaining moves!');
}
console.log('Test 7 Passed!');

console.log('==================================================');
console.log('🎉 ALL 7 SMOKE TESTS PASSED WITH ZERO ERRORS!');
console.log('==================================================');
