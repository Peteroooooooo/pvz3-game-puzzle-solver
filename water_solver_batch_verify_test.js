'use strict';
const assert = require('assert');
const engine = require('./water_solver_engine');
const fs = require('fs');
const {generateCase,independentRefills,verifyPolicy,stateKey,searchOptions} = require('./water_solver_batch_verify');

// Keep the batch's balanced profile identical to the actual website options.
const html = fs.readFileSync('pvz3_water_sort_solver.html','utf8');
const optionStart = html.indexOf('function getAdvancedSearchOptions()');
const optionEnd = html.indexOf('\nfunction cancelActiveSolver()',optionStart);
const uiOptions = new Function('document','REFILL_MOVE_BUDGET',
  html.slice(optionStart,optionEnd)+'\nreturn getAdvancedSearchOptions();')(
    {getElementById:()=>({value:'balanced'})},25);
assert.deepStrictEqual(searchOptions('balanced',4000),uiOptions);

const keys = new Set();
for (let i = 0; i < 40; i++) {
  const fixture = generateCase(i,250310);
  assert.deepStrictEqual(fixture,generateCase(i,250310));
  const totals = {};
  fixture.board.flat().forEach(c=>totals[c]=(totals[c]||0)+1);
  assert.strictEqual(Object.keys(totals).length,fixture.colorCount);
  assert.ok(Object.values(totals).every(n=>n===4));
  assert.strictEqual(fixture.targets.length,4);
  assert.strictEqual(new Set(fixture.targets.map(t=>t.color)).size,4);
  assert.strictEqual(new Set(fixture.targets.map(t=>t.tubeIdx)).size,4);
  if(fixture.kind==='fragmented-wrong-bottom') {
    for(const target of fixture.targets) {
      const tube=fixture.board[target.tubeIdx];
      assert.strictEqual(tube.length,4);
      assert.notStrictEqual(tube[0],target.color);
      assert.ok(tube.every((c,j)=>!j||c!==tube[j-1]));
    }
  }
  keys.add(stateKey(fixture.board,fixture.targets));
}
assert.strictEqual(keys.size,40);

const targets = [{tubeIdx:1,color:'G'},{tubeIdx:2,color:'B'},{tubeIdx:3,color:'O'}];
// Two eligible tubes (repeated drops), three eligible tubes (second-round
// choice), four eligible tubes (locked refill), and five/six eligible tubes.
for (const lengths of [[0,4,4,4,4,0,0],[0,4,4,4,3,0,0],
  [0,4,4,3,3,0,0],[0,4,3,3,3,0,0],[0,3,3,3,3,0,0]]) {
  const board = lengths.map((n,i)=>Array(n).fill(i%2?'R':'P'));
  const independent = independentRefills(board,'R',0,targets);
  const modeled = engine.enumerateRefillOutcomes(board,'R',0,{targets});
  assert.deepStrictEqual(independent.map(b=>stateKey(b,targets)).sort(),
    modeled.map(o=>stateKey(o.tubes,targets)).sort());
  assert.ok(independent.every(b=>b[0].length===0 && b.flat().length===board.flat().length+4));
}

const board = [['G','B','O','R'],['B','O','R','G'],['O','R','G','B'],['R','G','B','O'],[],[],[]];
const goals = ['G','B','O','R'].map((color,tubeIdx)=>({color,tubeIdx}));
const result = engine.solveRefillPolicy(board,goals,{
  objective:'worst-case',includePolicy:true,timeLimitMs:2500,
  maxStageNodes:8000,maxStageCandidates:30,stageDepthSlack:4,
  maxCandidatesEvaluated:{4:2,3:2,2:3},finalNodeLimit:180000,
  greedyNodeLimit:3000,greedyCandidateLimit:10,greedyDepthSlack:3,upperFraction:0.7});
const proof = verifyPolicy({board,targets:goals},result);
assert.strictEqual(proof.worst,17);
assert.strictEqual(proof.refillRounds,3);
const tampered = JSON.parse(JSON.stringify(result));
const root = tampered.policy.entries.find(e=>e.canonicalKey===engine.canonicalStateKey(board,goals));
root.worstCaseUpper=16;
assert.throws(()=>verifyPolicy({board,targets:goals},tampered));
for (const index of [24,575,177,235,935]) {
  const fixture = generateCase(index,250310);
  // Allow enough time for this correctness gate on busy CI machines. The
  // production four-second limit is checked by the batch's balanced profile.
  const solved = engine.solveRefillPolicy(fixture.board,fixture.targets,{...uiOptions,timeLimitMs:15000});
  assert.strictEqual(solved.certificate.budgetStatus,'guaranteed',`missed recovery for case ${index}`);
  assert.ok(verifyPolicy(fixture,solved).worst <= 25);
}
console.log('water_solver_batch_verify_test: PASS');
