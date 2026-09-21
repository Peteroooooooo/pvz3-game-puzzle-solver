(function attachWaterSolverEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PVZ3WaterSolverEngine = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createWaterSolverEngine() {
  'use strict';

  const DEFAULT_CAPACITY = 4;
  const DEFAULT_REFILL_COUNT = 4;
  const EPSILON = 1e-9;

  function nowMs() {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  }

  function cloneTubes(tubes) {
    return tubes.map(tube => [...tube]);
  }

  function cloneTargets(targets) {
    return targets.map(target => ({ tubeIdx: target.tubeIdx, color: target.color }));
  }

  function cloneMovePlan(plan) {
    return (plan || []).map(move => ({
      from: move.from,
      to: move.to,
      color: move.color,
      amount: move.amount
    }));
  }

  function normalizeTargets(targets) {
    return cloneTargets(targets)
      .filter(target => Number.isInteger(target.tubeIdx) && target.color)
      .sort((a, b) => a.tubeIdx - b.tubeIdx || String(a.color).localeCompare(String(b.color)));
  }

  function normalizeState(tubes, targets, capacity = DEFAULT_CAPACITY) {
    const nextTubes = cloneTubes(tubes);
    const nextTargets = [];

    for (const target of normalizeTargets(targets)) {
      const tube = nextTubes[target.tubeIdx] || [];
      if (tube.length === capacity && tube.every(color => color === target.color)) {
        nextTubes[target.tubeIdx] = [];
      } else {
        nextTargets.push(target);
      }
    }

    return { tubes: nextTubes, targets: nextTargets };
  }

  function tubeCode(tube) {
    return tube.join('');
  }

  function orderedStateKey(tubes, targets) {
    const targetPart = normalizeTargets(targets)
      .map(target => `${target.tubeIdx}:${target.color}`)
      .join(',');
    return `${tubes.map(tubeCode).join('|')}#${targetPart}`;
  }

  function canonicalStateKey(tubes, targets) {
    const normalizedTargets = normalizeTargets(targets);
    const targetByTube = new Map(normalizedTargets.map(target => [target.tubeIdx, target.color]));
    const fixed = [];
    const free = [];

    for (let index = 0; index < tubes.length; index++) {
      if (targetByTube.has(index)) {
        fixed.push(`${index}:${targetByTube.get(index)}:${tubeCode(tubes[index])}`);
      } else {
        free.push(tubeCode(tubes[index]));
      }
    }

    free.sort();
    return `${fixed.join('|')}#${free.join('|')}`;
  }

  function remapPolicyPlan(entry, tubes, targets, capacity = DEFAULT_CAPACITY) {
    if (!entry || !Array.isArray(entry.plan)) return null;
    const state = normalizeState(tubes, targets, capacity);
    if (canonicalStateKey(state.tubes, state.targets) !== entry.canonicalKey) return null;
    if (orderedStateKey(state.tubes, state.targets) === entry.orderedKey) {
      return cloneMovePlan(entry.plan);
    }

    const activeTargetTubes = new Set(state.targets.map(target => target.tubeIdx));
    const indexMap = new Map();
    for (const tubeIdx of activeTargetTubes) indexMap.set(tubeIdx, tubeIdx);

    const storedGroups = new Map();
    const currentGroups = new Map();
    for (let index = 0; index < state.tubes.length; index++) {
      if (activeTargetTubes.has(index)) continue;
      const storedCode = tubeCode(entry.tubes[index]);
      const currentCode = tubeCode(state.tubes[index]);
      if (!storedGroups.has(storedCode)) storedGroups.set(storedCode, []);
      if (!currentGroups.has(currentCode)) currentGroups.set(currentCode, []);
      storedGroups.get(storedCode).push(index);
      currentGroups.get(currentCode).push(index);
    }

    for (const [code, storedIndices] of storedGroups) {
      const currentIndices = currentGroups.get(code);
      if (!currentIndices || currentIndices.length !== storedIndices.length) return null;
      storedIndices.sort((a, b) => a - b);
      currentIndices.sort((a, b) => a - b);
      for (let index = 0; index < storedIndices.length; index++) {
        indexMap.set(storedIndices[index], currentIndices[index]);
      }
    }

    return entry.plan.map(move => ({
      from: indexMap.get(move.from),
      to: indexMap.get(move.to),
      color: move.color,
      amount: move.amount
    }));
  }

  function getTopRun(tube) {
    if (!tube || tube.length === 0) return null;
    const color = tube[tube.length - 1];
    let amount = 0;
    for (let index = tube.length - 1; index >= 0 && tube[index] === color; index--) {
      amount++;
    }
    return { color, amount };
  }

  function generateLegalMoves(tubes, targets, capacity = DEFAULT_CAPACITY) {
    const moves = [];
    const targetByTube = new Map(normalizeTargets(targets).map(target => [target.tubeIdx, target.color]));

    for (let from = 0; from < tubes.length; from++) {
      const source = tubes[from];
      const run = getTopRun(source);
      if (!run) continue;

      const equivalentDestinations = new Set();
      for (let to = 0; to < tubes.length; to++) {
        if (to === from) continue;
        const destination = tubes[to];
        if (destination.length >= capacity) continue;
        if (destination.length > 0 && destination[destination.length - 1] !== run.color) continue;

        const role = targetByTube.has(to) ? `target:${to}:${targetByTube.get(to)}` : 'free';
        const symmetryKey = `${role}:${tubeCode(destination)}`;
        if (equivalentDestinations.has(symmetryKey)) continue;
        equivalentDestinations.add(symmetryKey);

        const amount = Math.min(run.amount, capacity - destination.length);
        if (amount > 0) moves.push({ from, to, color: run.color, amount });
      }
    }

    return moves;
  }

  function applyMoveAndClear(tubes, targets, move, capacity = DEFAULT_CAPACITY) {
    const nextTubes = cloneTubes(tubes);
    const nextTargets = normalizeTargets(targets);

    for (let count = 0; count < move.amount; count++) {
      nextTubes[move.from].pop();
      nextTubes[move.to].push(move.color);
    }

    let clearedTube = null;
    let clearedColor = null;
    for (let index = nextTargets.length - 1; index >= 0; index--) {
      const target = nextTargets[index];
      const targetTube = nextTubes[target.tubeIdx];
      if (targetTube.length === capacity && targetTube.every(color => color === target.color)) {
        nextTubes[target.tubeIdx] = [];
        nextTargets.splice(index, 1);
        clearedTube = target.tubeIdx;
        clearedColor = target.color;
        break;
      }
    }

    const record = {
      ...move,
      note: '',
      clearedTube,
      clearedColor,
      remainingTargets: cloneTargets(nextTargets),
      afterState: cloneTubes(nextTubes)
    };

    return { tubes: nextTubes, targets: nextTargets, record };
  }

  function getRefillAvailableTubes(tubes, excludedTubeIdx, capacity = DEFAULT_CAPACITY) {
    const available = [];
    for (let index = 0; index < tubes.length; index++) {
      if (index === excludedTubeIdx) continue;
      if (tubes[index].length < capacity) available.push(index);
    }
    return available;
  }

  function combinationCount(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    let result = 1;
    for (let index = 1; index <= k; index++) {
      result = result * (n - k + index) / index;
    }
    return result;
  }

  function forEachCombination(items, size, callback, start = 0, picked = []) {
    if (picked.length === size) {
      callback([...picked]);
      return;
    }

    for (let index = start; index <= items.length - (size - picked.length); index++) {
      picked.push(items[index]);
      forEachCombination(items, size, callback, index + 1, picked);
      picked.pop();
    }
  }

  function enumerateRefillOutcomes(
    tubesAfterClear,
    refillColor,
    excludedTubeIdx,
    options = {}
  ) {
    const capacity = options.capacity || DEFAULT_CAPACITY;
    const refillCount = options.refillCount || DEFAULT_REFILL_COUNT;
    const targets = options.targets || [];
    const byState = new Map();

    function addOutcome(tubes, weight) {
      const key = canonicalStateKey(tubes, targets);
      const previous = byState.get(key);
      if (previous) {
        previous.probability += weight;
      } else {
        byState.set(key, { tubes: cloneTubes(tubes), probability: weight });
      }
    }

    function visit(tubes, dropsLeft, weight) {
      if (dropsLeft <= 0) {
        addOutcome(tubes, weight);
        return;
      }

      const available = getRefillAvailableTubes(tubes, excludedTubeIdx, capacity);
      if (available.length === 0) {
        addOutcome(tubes, weight);
        return;
      }

      const pickCount = Math.min(available.length, dropsLeft);
      const combinations = combinationCount(available.length, pickCount);
      forEachCombination(available, pickCount, picked => {
        const next = cloneTubes(tubes);
        for (const tubeIdx of picked) next[tubeIdx].push(refillColor);
        visit(next, dropsLeft - picked.length, weight / combinations);
      });
    }

    visit(cloneTubes(tubesAfterClear), refillCount, 1);
    return [...byState.values()];
  }

  function countColorTransitions(tubes) {
    let transitions = 0;
    for (const tube of tubes) {
      for (let index = 1; index < tube.length; index++) {
        if (tube[index] !== tube[index - 1]) transitions++;
      }
    }
    return transitions;
  }

  function minimumDecisionMoves(targets, pendingRefillColor = null) {
    const colors = new Set();
    for (const target of targets) {
      if (target.color && target.color !== pendingRefillColor) colors.add(target.color);
    }
    return colors.size;
  }

  function structuralScore(tubes, targets, capacity = DEFAULT_CAPACITY) {
    const targetByTube = new Map(normalizeTargets(targets).map(target => [target.tubeIdx, target.color]));
    let score = countColorTransitions(tubes) * 5;

    for (let index = 0; index < tubes.length; index++) {
      const tube = tubes[index];
      const targetColor = targetByTube.get(index);
      if (targetColor) {
        for (const color of tube) {
          if (color !== targetColor) score += 12;
        }
        if (tube.length > 0 && tube[tube.length - 1] !== targetColor) score += 8;
      } else if (tube.length === capacity) {
        score -= 3;
      } else if (tube.length === 0) {
        score -= 1;
      }
    }

    return score;
  }

  function analyzeClearLayout(candidate, options = {}) {
    const capacity = options.capacity || DEFAULT_CAPACITY;
    const refillCount = options.refillCount || DEFAULT_REFILL_COUNT;
    const fullShieldCount = candidate.tubes.reduce((count, tube, index) => (
      index !== candidate.clearedTube && tube.length === capacity ? count + 1 : count
    ), 0);
    const eligibleCount = getRefillAvailableTubes(
      candidate.tubes,
      candidate.clearedTube,
      capacity
    ).length;

    if (candidate.targets.length === 0) {
      return {
        fullShieldCount,
        eligibleCount,
        outcomeCount: 0,
        expectedStructure: 0,
        rank: candidate.depth * 10
      };
    }

    if (options.quick) {
      const estimatedOutcomeCount = eligibleCount >= refillCount
        ? combinationCount(eligibleCount, refillCount)
        : Math.max(1, eligibleCount);
      const currentStructure = structuralScore(candidate.tubes, candidate.targets, capacity);
      return {
        fullShieldCount,
        eligibleCount,
        outcomeCount: estimatedOutcomeCount,
        expectedStructure: currentStructure,
        rank: candidate.depth * 9 + currentStructure + estimatedOutcomeCount * 1.5 - fullShieldCount * 2
      };
    }

    const outcomes = enumerateRefillOutcomes(
      candidate.tubes,
      candidate.clearedColor,
      candidate.clearedTube,
      { capacity, refillCount, targets: candidate.targets }
    );
    const expectedStructure = outcomes.reduce(
      (sum, outcome) => sum + outcome.probability * structuralScore(outcome.tubes, candidate.targets, capacity),
      0
    );

    return {
      fullShieldCount,
      eligibleCount,
      outcomeCount: outcomes.length,
      expectedStructure,
      rank: candidate.depth * 9 + expectedStructure + outcomes.length * 1.5 - fullShieldCount * 2
    };
  }

  function reconstructPath(endNode) {
    const records = [];
    let current = endNode;
    while (current && current.record) {
      records.push(current.record);
      current = current.parent;
    }
    records.reverse();
    return records;
  }

  function makeSearchContext(options = {}) {
    const startedAt = nowMs();
    const timeLimitMs = Number.isFinite(options.timeLimitMs) ? options.timeLimitMs : 4000;
    return {
      options: {
        capacity: options.capacity || DEFAULT_CAPACITY,
        refillCount: options.refillCount || DEFAULT_REFILL_COUNT,
        timeLimitMs,
        maxStageNodes: options.maxStageNodes || 30000,
        maxStageCandidates: options.maxStageCandidates || 80,
        stageDepthSlack: Number.isFinite(options.stageDepthSlack) ? options.stageDepthSlack : 5,
        maxCandidatesEvaluated: options.maxCandidatesEvaluated || { 4: 10, 3: 7, 2: 14 },
        finalNodeLimit: options.finalNodeLimit || 250000,
        greedyNodeLimit: options.greedyNodeLimit || 9000,
        greedyCandidateLimit: options.greedyCandidateLimit || 18,
        greedyDepthSlack: Number.isFinite(options.greedyDepthSlack) ? options.greedyDepthSlack : 4,
        upperFraction: Number.isFinite(options.upperFraction) ? options.upperFraction : 0.55,
        includePolicy: options.includePolicy === true
      },
      startedAt,
      deadline: timeLimitMs > 0 ? startedAt + timeLimitMs : Infinity,
      upperDeadline: timeLimitMs > 0
        ? startedAt + timeLimitMs * (Number.isFinite(options.upperFraction) ? options.upperFraction : 0.55)
        : Infinity,
      stats: {
        deterministicNodes: 0,
        staticNodes: 0,
        macroCandidates: 0,
        chanceOutcomes: 0,
        policyStates: 0,
        cacheHits: 0,
        greedyStates: 0
      },
      valueMemo: new Map(),
      greedyMemo: new Map(),
      finalMemo: new Map(),
      policyEntries: new Map()
    };
  }

  function rememberPolicyEntry(context, key, state, result, source) {
    if (!context.options.includePolicy
      || !result
      || !Number.isFinite(result.upper)
      || !Array.isArray(result.plan)
      || result.plan.length === 0) {
      return;
    }

    const entry = {
      canonicalKey: key,
      orderedKey: orderedStateKey(state.tubes, state.targets),
      tubes: cloneTubes(state.tubes),
      targets: cloneTargets(state.targets),
      plan: cloneMovePlan(result.plan),
      upperBound: result.upper,
      worstCaseUpper: result.worstUpper,
      source
    };
    const previous = context.policyEntries.get(key);
    if (!previous
      || entry.upperBound < previous.upperBound - EPSILON
      || (Math.abs(entry.upperBound - previous.upperBound) <= EPSILON
        && entry.worstCaseUpper < previous.worstCaseUpper)) {
      context.policyEntries.set(key, entry);
    }
  }

  function isExpired(context, deadline = context.deadline) {
    return nowMs() >= deadline;
  }

  function insertRankedCandidate(candidates, candidate, limit, truncation) {
    if (!Number.isFinite(limit) || candidates.length < limit) {
      candidates.push(candidate);
      return;
    }

    let worstIndex = 0;
    for (let index = 1; index < candidates.length; index++) {
      if (candidates[index].layout.rank > candidates[worstIndex].layout.rank) worstIndex = index;
    }

    if (candidate.layout.rank < candidates[worstIndex].layout.rank) {
      truncation.minDiscardedDepth = Math.min(
        truncation.minDiscardedDepth,
        candidates[worstIndex].depth
      );
      candidates[worstIndex] = candidate;
    } else {
      truncation.minDiscardedDepth = Math.min(truncation.minDiscardedDepth, candidate.depth);
    }
    truncation.discardedCandidates++;
  }

  function enumerateFirstClearCandidates(tubes, targets, context, overrides = {}) {
    const capacity = context.options.capacity;
    const refillCount = context.options.refillCount;
    const maxNodes = overrides.maxNodes || context.options.maxStageNodes;
    const maxCandidates = overrides.maxCandidates || context.options.maxStageCandidates;
    const depthSlack = Number.isFinite(overrides.depthSlack)
      ? overrides.depthSlack
      : context.options.stageDepthSlack;
    const deadline = overrides.deadline || context.deadline;

    const start = normalizeState(tubes, targets, capacity);
    const rootNode = {
      tubes: start.tubes,
      targets: start.targets,
      depth: 0,
      parent: null,
      record: null
    };
    const queue = [rootNode];
    const seen = new Map([[canonicalStateKey(start.tubes, start.targets), 0]]);
    const terminalSeen = new Map();
    const candidates = [];
    const truncation = {
      minDiscardedDepth: Infinity,
      minUnexpandedClearDepth: Infinity,
      discardedCandidates: 0,
      reason: null
    };

    let head = 0;
    let expanded = 0;
    let shortestClearDepth = Infinity;

    while (head < queue.length) {
      if (expanded >= maxNodes) {
        truncation.reason = 'node-limit';
        truncation.minUnexpandedClearDepth = Math.min(
          truncation.minUnexpandedClearDepth,
          queue[head].depth + 1
        );
        break;
      }
      if (isExpired(context, deadline)) {
        truncation.reason = 'time-limit';
        truncation.minUnexpandedClearDepth = Math.min(
          truncation.minUnexpandedClearDepth,
          queue[head].depth + 1
        );
        break;
      }

      const current = queue[head++];
      if (Number.isFinite(shortestClearDepth) && current.depth + 1 > shortestClearDepth + depthSlack) {
        truncation.reason = truncation.reason || 'depth-slack';
        truncation.minUnexpandedClearDepth = Math.min(
          truncation.minUnexpandedClearDepth,
          current.depth + 1
        );
        continue;
      }

      expanded++;
      context.stats.deterministicNodes++;
      const moves = generateLegalMoves(current.tubes, current.targets, capacity);
      for (const move of moves) {
        const next = applyMoveAndClear(current.tubes, current.targets, move, capacity);
        const depth = current.depth + 1;
        const nextNode = {
          tubes: next.tubes,
          targets: next.targets,
          depth,
          parent: current,
          record: next.record
        };

        if (next.record.clearedColor) {
          shortestClearDepth = Math.min(shortestClearDepth, depth);
          const terminalKey = `${next.record.clearedTube}:${next.record.clearedColor}#${orderedStateKey(next.tubes, next.targets)}`;
          const previousDepth = terminalSeen.get(terminalKey);
          if (previousDepth !== undefined && previousDepth <= depth) continue;
          terminalSeen.set(terminalKey, depth);

          const candidate = {
            depth,
            moves: reconstructPath(nextNode),
            tubes: next.tubes,
            targets: next.targets,
            clearedTube: next.record.clearedTube,
            clearedColor: next.record.clearedColor
          };
          candidate.layout = analyzeClearLayout(candidate, { capacity, refillCount, quick: true });
          insertRankedCandidate(candidates, candidate, maxCandidates, truncation);
          context.stats.macroCandidates++;
          continue;
        }

        const key = canonicalStateKey(next.tubes, next.targets);
        const previousDepth = seen.get(key);
        if (previousDepth !== undefined && previousDepth <= depth) continue;
        seen.set(key, depth);
        queue.push(nextNode);
      }
    }

    for (const candidate of candidates) {
      candidate.layout = analyzeClearLayout(candidate, { capacity, refillCount });
    }
    candidates.sort((a, b) => a.layout.rank - b.layout.rank || a.depth - b.depth);
    const exhaustive = head >= queue.length
      && !truncation.reason
      && truncation.discardedCandidates === 0;
    let unseenClearLower = Infinity;
    if (!exhaustive) {
      unseenClearLower = Math.min(
        truncation.minDiscardedDepth,
        truncation.minUnexpandedClearDepth
      );
      if (!Number.isFinite(unseenClearLower)) {
        unseenClearLower = Number.isFinite(shortestClearDepth)
          ? shortestClearDepth
          : 1;
      }
    }

    return {
      candidates,
      shortestClearDepth,
      exhaustive,
      unseenClearLower,
      expanded,
      truncation
    };
  }

  function shortestFinalClear(tubes, targets, context, deadline = context.deadline) {
    const capacity = context.options.capacity;
    const start = normalizeState(tubes, targets, capacity);
    const key = canonicalStateKey(start.tubes, start.targets);
    const cached = context.finalMemo.get(key);
    if (cached) {
      context.stats.cacheHits++;
      return cached;
    }
    if (start.targets.length === 0) {
      const complete = { found: true, distance: 0, moves: [], proven: true, lower: 0 };
      context.finalMemo.set(key, complete);
      return complete;
    }

    const rootNode = {
      tubes: start.tubes,
      targets: start.targets,
      depth: 0,
      parent: null,
      record: null
    };
    const queue = [rootNode];
    const seen = new Set([key]);
    let head = 0;
    let expanded = 0;

    while (head < queue.length) {
      if (expanded >= context.options.finalNodeLimit || isExpired(context, deadline)) {
        const lower = head < queue.length ? queue[head].depth + 1 : start.targets.length;
        return { found: false, distance: Infinity, moves: null, proven: false, lower };
      }

      const current = queue[head++];
      expanded++;
      context.stats.staticNodes++;
      const moves = generateLegalMoves(current.tubes, current.targets, capacity);
      for (const move of moves) {
        const next = applyMoveAndClear(current.tubes, current.targets, move, capacity);
        const nextNode = {
          tubes: next.tubes,
          targets: next.targets,
          depth: current.depth + 1,
          parent: current,
          record: next.record
        };
        if (next.targets.length === 0) {
          const result = {
            found: true,
            distance: nextNode.depth,
            moves: reconstructPath(nextNode),
            proven: true,
            lower: nextNode.depth
          };
          context.finalMemo.set(key, result);
          return result;
        }

        const nextKey = canonicalStateKey(next.tubes, next.targets);
        if (seen.has(nextKey)) continue;
        seen.add(nextKey);
        queue.push(nextNode);
      }
    }

    const impossible = { found: false, distance: Infinity, moves: null, proven: true, lower: Infinity };
    context.finalMemo.set(key, impossible);
    return impossible;
  }

  function getCandidateEvaluationLimit(targetCount, context) {
    const configured = context.options.maxCandidatesEvaluated;
    if (typeof configured === 'number') return configured;
    return configured[targetCount] || configured.default || 8;
  }

  function greedyPolicyValue(tubes, targets, context, wantPlan = false) {
    const capacity = context.options.capacity;
    const refillCount = context.options.refillCount;
    const state = normalizeState(tubes, targets, capacity);
    const key = canonicalStateKey(state.tubes, state.targets);
    const orderedKey = orderedStateKey(state.tubes, state.targets);
    const cached = context.greedyMemo.get(key);
    if (cached && (!wantPlan || cached.orderedKey === orderedKey)) {
      context.stats.cacheHits++;
      return cached;
    }

    if (state.targets.length === 0) {
      return { upper: 0, worstUpper: 0, plan: [], orderedKey, complete: true };
    }
    if (isExpired(context, context.upperDeadline)) {
      return { upper: Infinity, worstUpper: Infinity, plan: null, orderedKey, complete: false };
    }

    context.stats.greedyStates++;
    if (state.targets.length === 1) {
      const final = shortestFinalClear(state.tubes, state.targets, context, context.upperDeadline);
      const value = {
        upper: final.found ? final.distance : Infinity,
        worstUpper: final.found ? final.distance : Infinity,
        plan: final.moves,
        orderedKey,
        complete: final.found
      };
      if (value.complete) {
        rememberPolicyEntry(context, key, state, value, 'greedy-final');
        context.greedyMemo.set(key, value);
      }
      return value;
    }

    const enumeration = enumerateFirstClearCandidates(state.tubes, state.targets, context, {
      maxNodes: context.options.greedyNodeLimit,
      maxCandidates: context.options.greedyCandidateLimit,
      depthSlack: context.options.greedyDepthSlack,
      deadline: context.upperDeadline
    });

    let best = null;
    const tryLimit = Math.min(4, enumeration.candidates.length);
    for (let candidateIndex = 0; candidateIndex < tryLimit; candidateIndex++) {
      if (isExpired(context, context.upperDeadline)) break;
      const candidate = enumeration.candidates[candidateIndex];
      const outcomes = enumerateRefillOutcomes(
        candidate.tubes,
        candidate.clearedColor,
        candidate.clearedTube,
        { capacity, refillCount, targets: candidate.targets }
      );
      context.stats.chanceOutcomes += outcomes.length;

      let expected = candidate.depth;
      let worst = candidate.depth;
      let complete = true;
      for (const outcome of outcomes) {
        const child = greedyPolicyValue(outcome.tubes, candidate.targets, context, false);
        if (!child.complete || !Number.isFinite(child.upper)) {
          complete = false;
          break;
        }
        expected += outcome.probability * child.upper;
        worst = Math.max(worst, candidate.depth + child.worstUpper);
      }

      if (complete && (!best || expected < best.upper - EPSILON || (
        Math.abs(expected - best.upper) <= EPSILON && worst < best.worstUpper
      ))) {
        best = {
          upper: expected,
          worstUpper: worst,
          plan: candidate.moves,
          selectedCandidate: candidate,
          orderedKey,
          complete: true
        };
      }
    }

    const result = best || {
      upper: Infinity,
      worstUpper: Infinity,
      plan: enumeration.candidates[0] ? enumeration.candidates[0].moves : null,
      selectedCandidate: enumeration.candidates[0] || null,
      orderedKey,
      complete: false
    };
    if (result.complete) {
      rememberPolicyEntry(context, key, state, result, 'greedy');
      context.greedyMemo.set(key, result);
    }
    return result;
  }

  function solvePolicyState(tubes, targets, context, wantPlan = false) {
    const capacity = context.options.capacity;
    const refillCount = context.options.refillCount;
    const state = normalizeState(tubes, targets, capacity);
    const key = canonicalStateKey(state.tubes, state.targets);
    const orderedKey = orderedStateKey(state.tubes, state.targets);
    const cached = context.valueMemo.get(key);
    if (cached && (!wantPlan || cached.orderedKey === orderedKey)) {
      context.stats.cacheHits++;
      return cached;
    }

    context.stats.policyStates++;
    const targetCount = state.targets.length;
    if (targetCount === 0) {
      return {
        lower: 0,
        upper: 0,
        worstUpper: 0,
        plan: [],
        proven: true,
        guaranteed: true,
        orderedKey
      };
    }

    if (targetCount === 1) {
      const final = shortestFinalClear(state.tubes, state.targets, context);
      const result = {
        lower: final.found ? final.distance : final.lower,
        upper: final.found ? final.distance : Infinity,
        worstUpper: final.found ? final.distance : Infinity,
        plan: final.moves,
        proven: final.found && final.proven,
        guaranteed: final.found ? true : null,
        orderedKey
      };
      if (result.proven) {
        rememberPolicyEntry(context, key, state, result, 'exact-final');
        context.valueMemo.set(key, result);
      }
      return result;
    }

    if (isExpired(context)) {
      return {
        lower: minimumDecisionMoves(state.targets),
        upper: Infinity,
        worstUpper: Infinity,
        plan: null,
        proven: false,
        guaranteed: null,
        orderedKey
      };
    }

    const greedy = context.greedyMemo.get(key);
    let bestUpper = greedy && greedy.complete ? greedy.upper : Infinity;
    let bestWorst = greedy && greedy.complete ? greedy.worstUpper : Infinity;
    let bestPlan = greedy && greedy.orderedKey === orderedKey ? greedy.plan : null;
    let bestCandidate = greedy ? greedy.selectedCandidate : null;

    const enumeration = enumerateFirstClearCandidates(state.tubes, state.targets, context);
    const evaluationLimit = getCandidateEvaluationLimit(targetCount, context);
    let evaluated = 0;
    let evaluatedLower = Infinity;
    let unevaluatedLower = Infinity;
    let allEvaluatedCandidatesExact = true;

    for (let candidateIndex = 0; candidateIndex < enumeration.candidates.length; candidateIndex++) {
      const candidate = enumeration.candidates[candidateIndex];
      if (evaluated >= evaluationLimit || isExpired(context)) {
        unevaluatedLower = Math.min(
          unevaluatedLower,
          candidate.depth + minimumDecisionMoves(candidate.targets, candidate.clearedColor)
        );
        allEvaluatedCandidatesExact = false;
        continue;
      }

      evaluated++;
      const outcomes = enumerateRefillOutcomes(
        candidate.tubes,
        candidate.clearedColor,
        candidate.clearedTube,
        { capacity, refillCount, targets: candidate.targets }
      );
      context.stats.chanceOutcomes += outcomes.length;

      let candidateLower = candidate.depth;
      let candidateUpper = candidate.depth;
      let candidateWorst = candidate.depth;
      let completeUpper = true;
      let exactChildren = true;

      for (const outcome of outcomes) {
        const child = solvePolicyState(outcome.tubes, candidate.targets, context, false);
        candidateLower += outcome.probability * child.lower;
        exactChildren = exactChildren && child.proven;
        if (Number.isFinite(child.upper)) {
          candidateUpper += outcome.probability * child.upper;
          candidateWorst = Math.max(candidateWorst, candidate.depth + child.worstUpper);
        } else {
          completeUpper = false;
        }
      }

      evaluatedLower = Math.min(evaluatedLower, candidateLower);
      allEvaluatedCandidatesExact = allEvaluatedCandidatesExact && exactChildren;
      if (completeUpper && (
        candidateUpper < bestUpper - EPSILON
        || (Math.abs(candidateUpper - bestUpper) <= EPSILON && candidateWorst < bestWorst)
      )) {
        bestUpper = candidateUpper;
        bestWorst = candidateWorst;
        bestPlan = candidate.moves;
        bestCandidate = candidate;
      }
    }

    let unseenLower = Infinity;
    if (!enumeration.exhaustive) {
      const distinctTargetColors = new Set(state.targets.map(target => target.color)).size;
      unseenLower = enumeration.unseenClearLower + Math.max(0, distinctTargetColors - 1);
    }
    let lower = Math.min(evaluatedLower, unevaluatedLower, unseenLower);
    if (!Number.isFinite(lower)) {
      lower = Number.isFinite(bestUpper) ? bestUpper : minimumDecisionMoves(state.targets);
    }
    if (Number.isFinite(bestUpper)) lower = Math.min(lower, bestUpper);

    const proven = Number.isFinite(bestUpper)
      && Math.abs(bestUpper - lower) <= EPSILON
      && (enumeration.exhaustive || unseenLower >= bestUpper - EPSILON)
      && (allEvaluatedCandidatesExact || unevaluatedLower >= bestUpper - EPSILON);
    const result = {
      lower,
      upper: bestUpper,
      worstUpper: bestWorst,
      plan: bestPlan || (enumeration.candidates[0] ? enumeration.candidates[0].moves : null),
      selectedCandidate: bestCandidate || enumeration.candidates[0] || null,
      proven,
      guaranteed: Number.isFinite(bestUpper) ? true : null,
      shortestClearDepth: enumeration.shortestClearDepth,
      exhaustiveFirstClear: enumeration.exhaustive,
      orderedKey
    };

    if (bestPlan && Number.isFinite(bestUpper)) {
      rememberPolicyEntry(context, key, state, {
        plan: bestPlan,
        upper: bestUpper,
        worstUpper: bestWorst
      }, 'bounded-policy');
    }

    if (proven || (!wantPlan && Number.isFinite(bestUpper))) context.valueMemo.set(key, result);
    return result;
  }

  function solveRefillPolicy(initialTubes, initialTargets, options = {}) {
    const context = makeSearchContext(options);
    const capacity = context.options.capacity;
    const start = normalizeState(initialTubes, initialTargets, capacity);

    const greedy = greedyPolicyValue(start.tubes, start.targets, context, true);
    if (greedy.complete) {
      context.greedyMemo.set(canonicalStateKey(start.tubes, start.targets), greedy);
    }
    const solved = solvePolicyState(start.tubes, start.targets, context, true);
    const plan = solved.plan || greedy.plan || [];
    const selected = solved.selectedCandidate || greedy.selectedCandidate || null;
    const elapsedMs = nowMs() - context.startedAt;
    const gap = Number.isFinite(solved.upper)
      ? Math.max(0, solved.upper - solved.lower)
      : Infinity;
    const layout = selected
      ? selected.layout
      : (plan.length > 0 && plan[plan.length - 1].clearedColor
        ? analyzeClearLayout({
          depth: plan.length,
          tubes: plan[plan.length - 1].afterState,
          targets: plan[plan.length - 1].remainingTargets,
          clearedTube: plan[plan.length - 1].clearedTube,
          clearedColor: plan[plan.length - 1].clearedColor
        }, context.options)
        : null);

    const result = {
      kind: 'refill-policy',
      plan,
      certificate: {
        guaranteed: solved.guaranteed,
        provenOptimal: solved.proven,
        lowerBound: solved.lower,
        upperBound: solved.upper,
        worstCaseUpper: solved.worstUpper,
        absoluteGap: gap,
        relativeGap: Number.isFinite(gap) && solved.lower > EPSILON ? gap / solved.lower : null,
        nextClearSteps: plan.length,
        shortestClearDepth: solved.shortestClearDepth || null,
        deliberateSetupSteps: Number.isFinite(solved.shortestClearDepth)
          ? Math.max(0, plan.length - solved.shortestClearDepth)
          : null,
        fullShieldCount: layout ? layout.fullShieldCount : null,
        eligibleRefillTubes: layout ? layout.eligibleCount : null,
        refillOutcomeCount: layout ? layout.outcomeCount : null
      },
      stats: { ...context.stats, elapsedMs }
    };
    if (context.options.includePolicy) {
      result.policy = {
        entries: [...context.policyEntries.values()]
          .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey))
      };
    }
    return result;
  }

  function solveStaticOptimal(initialTubes, initialTargets, options = {}) {
    const context = makeSearchContext({
      ...options,
      timeLimitMs: Number.isFinite(options.timeLimitMs) ? options.timeLimitMs : 15000,
      finalNodeLimit: options.finalNodeLimit || 1000000
    });
    const capacity = context.options.capacity;
    const start = normalizeState(initialTubes, initialTargets, capacity);
    if (start.targets.length === 0) {
      return {
        kind: 'static-optimal',
        plan: [],
        certificate: {
          provenOptimal: true,
          lowerBound: 0,
          upperBound: 0,
          absoluteGap: 0
        },
        stats: { ...context.stats, elapsedMs: nowMs() - context.startedAt }
      };
    }

    const rootNode = {
      tubes: start.tubes,
      targets: start.targets,
      depth: 0,
      parent: null,
      record: null
    };
    const queue = [rootNode];
    const seen = new Set([canonicalStateKey(start.tubes, start.targets)]);
    let head = 0;
    let expanded = 0;
    let lowerBound = minimumDecisionMoves(start.targets);

    while (head < queue.length) {
      if (expanded >= context.options.finalNodeLimit || isExpired(context)) {
        if (head < queue.length) {
          lowerBound = Infinity;
          for (let index = head; index < queue.length; index++) {
            lowerBound = Math.min(
              lowerBound,
              queue[index].depth + Math.max(1, minimumDecisionMoves(queue[index].targets))
            );
          }
          if (!Number.isFinite(lowerBound)) lowerBound = minimumDecisionMoves(start.targets);
        }
        break;
      }

      const current = queue[head++];
      expanded++;
      context.stats.staticNodes++;
      const moves = generateLegalMoves(current.tubes, current.targets, capacity);
      for (const move of moves) {
        const next = applyMoveAndClear(current.tubes, current.targets, move, capacity);
        const node = {
          tubes: next.tubes,
          targets: next.targets,
          depth: current.depth + 1,
          parent: current,
          record: next.record
        };
        if (next.targets.length === 0) {
          const plan = reconstructPath(node);
          return {
            kind: 'static-optimal',
            plan,
            certificate: {
              provenOptimal: true,
              lowerBound: plan.length,
              upperBound: plan.length,
              absoluteGap: 0
            },
            stats: { ...context.stats, elapsedMs: nowMs() - context.startedAt }
          };
        }

        const key = canonicalStateKey(next.tubes, next.targets);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(node);
      }
    }

    return {
      kind: 'static-optimal',
      plan: [],
      certificate: {
        provenOptimal: false,
        lowerBound,
        upperBound: Infinity,
        absoluteGap: Infinity
      },
      stats: { ...context.stats, elapsedMs: nowMs() - context.startedAt },
      error: head >= queue.length ? 'no-solution' : 'search-limit'
    };
  }

  function solveNextClearFast(initialTubes, initialTargets, options = {}) {
    const context = makeSearchContext({
      ...options,
      timeLimitMs: Number.isFinite(options.timeLimitMs) ? options.timeLimitMs : 80,
      maxStageNodes: options.maxStageNodes || 5000,
      maxStageCandidates: options.maxStageCandidates || 20,
      stageDepthSlack: Number.isFinite(options.stageDepthSlack) ? options.stageDepthSlack : 3
    });
    const state = normalizeState(initialTubes, initialTargets, context.options.capacity);
    const enumeration = enumerateFirstClearCandidates(state.tubes, state.targets, context);
    const selected = enumeration.candidates[0] || null;
    return {
      kind: 'fast-next-clear',
      plan: selected ? selected.moves : [],
      certificate: {
        provenOptimal: false,
        shortestClearDepth: enumeration.shortestClearDepth,
        nextClearSteps: selected ? selected.depth : null,
        fullShieldCount: selected ? selected.layout.fullShieldCount : null,
        refillOutcomeCount: selected ? selected.layout.outcomeCount : null
      },
      stats: { ...context.stats, elapsedMs: nowMs() - context.startedAt }
    };
  }

  return {
    DEFAULT_CAPACITY,
    DEFAULT_REFILL_COUNT,
    normalizeState,
    orderedStateKey,
    canonicalStateKey,
    generateLegalMoves,
    applyMoveAndClear,
    getRefillAvailableTubes,
    enumerateRefillOutcomes,
    analyzeClearLayout,
    remapPolicyPlan,
    solveStaticOptimal,
    solveRefillPolicy,
    solveNextClearFast
  };
}));
