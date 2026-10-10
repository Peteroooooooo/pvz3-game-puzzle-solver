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
  const SEARCH_TUBE_CODE = Symbol('searchTubeCode');
  const SEARCH_TARGET_COLORS = Symbol('searchTargetColors');

  function nowMs() {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  }

  function cloneTubes(tubes) {
    return tubes.map(tube => [...tube]);
  }

  function tagSearchTube(tube) {
    tube[SEARCH_TUBE_CODE] = tube.join('');
    return tube;
  }

  function tagSearchTubes(tubes) {
    for (const tube of tubes) {
      if (tube[SEARCH_TUBE_CODE] === undefined) tagSearchTube(tube);
    }
    return tubes;
  }

  function cloneTargets(targets) {
    return targets.map(target => ({ tubeIdx: target.tubeIdx, color: target.color }));
  }

  function targetColorsByTube(targets, tubeCount, cache = false) {
    if (targets[SEARCH_TARGET_COLORS]) return targets[SEARCH_TARGET_COLORS];
    const colors = new Array(tubeCount).fill(null);
    for (const target of targets) colors[target.tubeIdx] = target.color;
    if (cache) targets[SEARCH_TARGET_COLORS] = colors;
    return colors;
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

  // Search states are immutable. Reuse them when no target is already complete,
  // and copy only the outer tube array when normalization must clear a target.
  function normalizeSearchState(tubes, targets, capacity = DEFAULT_CAPACITY) {
    tagSearchTubes(tubes);
    targetColorsByTube(targets, tubes.length, true);
    let completed = null;
    for (const target of targets) {
      const tube = tubes[target.tubeIdx] || [];
      if (tube.length === capacity && tube.every(color => color === target.color)) {
        if (!completed) completed = new Set();
        completed.add(target.tubeIdx);
      }
    }
    if (!completed) return { tubes, targets };

    const nextTubes = tubes.slice();
    for (const tubeIdx of completed) nextTubes[tubeIdx] = tagSearchTube([]);
    const nextTargets = targets.filter(target => !completed.has(target.tubeIdx));
    targetColorsByTube(nextTargets, tubes.length, true);
    return {
      tubes: nextTubes,
      targets: nextTargets
    };
  }

  function tubeCode(tube) {
    return tube[SEARCH_TUBE_CODE] === undefined
      ? tube.join('')
      : tube[SEARCH_TUBE_CODE];
  }

  function orderedStateKeyNormalized(tubes, targets) {
    const targetPart = targets
      .map(target => `${target.tubeIdx}:${target.color}`)
      .join(',');
    return `${tubes.map(tubeCode).join('|')}#${targetPart}`;
  }

  function orderedStateKey(tubes, targets) {
    return orderedStateKeyNormalized(tubes, normalizeTargets(targets));
  }

  function canonicalStateKeyNormalized(tubes, targets) {
    const fixed = [];
    const free = [];
    let targetIndex = 0;

    for (let index = 0; index < tubes.length; index++) {
      while (targetIndex < targets.length && targets[targetIndex].tubeIdx < index) targetIndex++;
      if (targetIndex < targets.length && targets[targetIndex].tubeIdx === index) {
        let targetColor = targets[targetIndex].color;
        while (targetIndex + 1 < targets.length && targets[targetIndex + 1].tubeIdx === index) {
          targetIndex++;
          targetColor = targets[targetIndex].color;
        }
        fixed.push(`${index}:${targetColor}:${tubeCode(tubes[index])}`);
        targetIndex++;
      } else {
        free.push(tubeCode(tubes[index]));
      }
    }

    free.sort();
    return `${fixed.join('|')}#${free.join('|')}`;
  }

  function canonicalStateKey(tubes, targets) {
    return canonicalStateKeyNormalized(tubes, normalizeTargets(targets));
  }

  // At a clear boundary the just-cleared tube has a special refill role, while
  // every other non-target tube remains interchangeable. Pin only that tube and
  // canonicalize the rest so equivalent terminal layouts are evaluated once.
  function refillTerminalStateKey(tubes, targets, excludedTubeIdx) {
    const fixed = [];
    const free = [];
    let targetIndex = 0;

    for (let index = 0; index < tubes.length; index++) {
      while (targetIndex < targets.length && targets[targetIndex].tubeIdx < index) targetIndex++;
      if (targetIndex < targets.length && targets[targetIndex].tubeIdx === index) {
        fixed.push(`${index}:${targets[targetIndex].color}:${tubeCode(tubes[index])}`);
        targetIndex++;
      } else if (index === excludedTubeIdx) {
        fixed.push(`x:${index}:${tubeCode(tubes[index])}`);
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

  function generateLegalMovesNormalized(
    tubes,
    targets,
    capacity = DEFAULT_CAPACITY,
    pruneSymmetricNoOps = false,
    previousMove = null
  ) {
    const moves = [];
    const targetColors = targetColorsByTube(
      targets,
      tubes.length,
      pruneSymmetricNoOps
    );

    for (let from = 0; from < tubes.length; from++) {
      const source = tubes[from];
      const run = getTopRun(source);
      if (!run) continue;

      const equivalentDestinations = [];
      for (let to = 0; to < tubes.length; to++) {
        if (to === from) continue;
        const destination = tubes[to];
        if (destination.length >= capacity) continue;
        if (destination.length > 0 && destination[destination.length - 1] !== run.color) continue;

        // Moving an entire monochrome free tube into an empty free tube only
        // swaps two interchangeable tube identities. Its canonical state is
        // unchanged, so the search can skip constructing that child entirely.
        if (pruneSymmetricNoOps
          && targetColors[from] === null
          && targetColors[to] === null
          && destination.length === 0
          && run.amount === source.length) {
          continue;
        }

        const role = targetColors[to] !== null
          ? `target:${to}:${targetColors[to]}`
          : 'free';
        const symmetryKey = `${role}:${tubeCode(destination)}`;
        if (equivalentDestinations.includes(symmetryKey)) continue;
        equivalentDestinations.push(symmetryKey);

        const amount = Math.min(run.amount, capacity - destination.length);
        if (pruneSymmetricNoOps
          && previousMove
          && from === previousMove.to
          && to === previousMove.from
          && run.color === previousMove.color
          && amount === previousMove.amount) {
          continue;
        }
        if (amount > 0) moves.push({ from, to, color: run.color, amount });
      }
    }

    return moves;
  }

  function generateLegalMoves(tubes, targets, capacity = DEFAULT_CAPACITY) {
    return generateLegalMovesNormalized(tubes, normalizeTargets(targets), capacity, false);
  }

  // Lean immutable transition for the search hot path. It copies only the two
  // changed tubes and does not allocate animation snapshots for discarded nodes.
  function applySearchMove(tubes, targets, move, capacity = DEFAULT_CAPACITY) {
    const source = tubes[move.from];
    const destination = tubes[move.to];
    const nextTubes = tubes.slice();
    nextTubes[move.from] = tagSearchTube(source.slice(0, source.length - move.amount));
    const nextDestination = destination.slice();
    for (let count = 0; count < move.amount; count++) nextDestination.push(move.color);
    nextTubes[move.to] = tagSearchTube(nextDestination);

    let clearedColor = null;
    const targetColor = targetColorsByTube(targets, tubes.length, true)[move.to];
    if (targetColor !== null) {
      if (nextDestination.length === capacity
        && nextDestination.every(color => color === targetColor)) {
        clearedColor = targetColor;
      }
    }

    if (!clearedColor) {
      return { tubes: nextTubes, targets, clearedTube: null, clearedColor: null };
    }

    nextTubes[move.to] = tagSearchTube([]);
    const nextTargets = targets.filter(target => target.tubeIdx !== move.to);
    targetColorsByTube(nextTargets, tubes.length, true);
    return {
      tubes: nextTubes,
      targets: nextTargets,
      clearedTube: move.to,
      clearedColor
    };
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
    const rawTargets = options.targets || [];
    const targets = options.targetsNormalized === true
      ? rawTargets
      : normalizeTargets(rawTargets);
    const searchOptimized = options.searchOptimized === true;
    const byState = new Map();

    function addOutcome(tubes, weight) {
      const key = canonicalStateKeyNormalized(tubes, targets);
      const previous = byState.get(key);
      if (previous) {
        previous.probability += weight;
      } else {
        const storedTubes = searchOptimized ? tubes.slice() : cloneTubes(tubes);
        if (searchOptimized) tagSearchTubes(storedTubes);
        byState.set(key, { tubes: storedTubes, probability: weight });
      }
    }

    function appendDrops(tubes, picked) {
      const next = tubes.slice();
      for (const tubeIdx of picked) {
        const nextTube = [...tubes[tubeIdx], refillColor];
        next[tubeIdx] = searchOptimized ? tagSearchTube(nextTube) : nextTube;
      }
      return next;
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

      if (available.length >= dropsLeft) {
        const combinations = combinationCount(available.length, dropsLeft);
        forEachCombination(available, dropsLeft, picked => {
          addOutcome(appendDrops(tubes, picked), weight / combinations);
        });
        return;
      }

      // Every available tube must receive one drop before any can receive a
      // second one, so this round has exactly one possible choice.
      visit(
        appendDrops(tubes, available),
        dropsLeft - available.length,
        weight
      );
    }

    visit(tubesAfterClear, refillCount, 1);
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

  function targetCompletionLowerBound(tubes, target, capacity, includeBlockers) {
    const tube = tubes[target.tubeIdx] || [];
    let correctPrefix = 0;
    while (correctPrefix < tube.length && tube[correctPrefix] === target.color) {
      correctPrefix++;
    }

    let runsToRemove = 0;
    let previousColor = null;
    for (let index = correctPrefix; index < tube.length; index++) {
      if (tube[index] !== previousColor) {
        runsToRemove++;
        previousColor = tube[index];
      }
    }
    const finalFill = correctPrefix < capacity ? 1 : 0;
    if (!includeBlockers) return runsToRemove + finalFill;

    const needed = Math.max(0, capacity - correctPrefix);
    let freeTargetColor = 0;
    for (let index = correctPrefix; index < tube.length; index++) {
      if (tube[index] === target.color) freeTargetColor++;
    }

    const exposureCost = new Array(needed + 1).fill(Infinity);
    exposureCost[Math.min(needed, freeTargetColor)] = 0;
    for (let tubeIdx = 0; tubeIdx < tubes.length; tubeIdx++) {
      if (tubeIdx === target.tubeIdx) continue;
      const source = tubes[tubeIdx];
      const options = [{ units: 0, blockers: 0 }];
      let exposedUnits = 0;
      let blockerRuns = 0;
      let targetRuns = 0;
      for (let index = source.length - 1; index >= 0;) {
        const color = source[index];
        let runLength = 0;
        while (index >= 0 && source[index] === color) {
          runLength++;
          index--;
        }
        if (color === target.color) {
          exposedUnits += runLength;
          targetRuns++;
          options.push({ units: exposedUnits, blockers: blockerRuns + targetRuns });
        } else {
          blockerRuns++;
        }
      }

      const previousCosts = [...exposureCost];
      for (let have = 0; have <= needed; have++) {
        if (!Number.isFinite(previousCosts[have])) continue;
        for (const option of options) {
          const nextHave = Math.min(needed, have + option.units);
          exposureCost[nextHave] = Math.min(
            exposureCost[nextHave],
            previousCosts[have] + option.blockers
          );
        }
      }
    }

    const blockerLower = Number.isFinite(exposureCost[needed])
      ? exposureCost[needed]
      : 0;
    // Each selected color run must leave its original source at least once;
    // consolidating it elsewhere cannot eliminate that departure. One such
    // transfer can also be the final fill, so these costs are not added twice.
    return runsToRemove + Math.max(blockerLower, finalFill);
  }

  function admissibleNextClearLowerBound(tubes, targets, capacity = DEFAULT_CAPACITY) {
    if (targets.length === 0) return 0;
    let best = Infinity;
    for (const target of targets) {
      best = Math.min(
        best,
        targetCompletionLowerBound(tubes, target, capacity, true)
      );
    }
    return Number.isFinite(best) ? best : 1;
  }

  // Admissible lower bound: a target tube must remove every color run above
  // its correct bottom prefix, then receive at least one final target-color
  // pour if that prefix is not already full. Taking the maximum across targets
  // never overestimates because a single pour may help two targets at once.
  function admissibleMoveLowerBound(tubes, targets, capacity = DEFAULT_CAPACITY) {
    let bound = minimumDecisionMoves(targets);
    let requiredDepartures = 0;
    for (const target of targets) {
      const tube = tubes[target.tubeIdx] || [];
      let prefix = 0;
      while (prefix < tube.length && tube[prefix] === target.color) prefix++;
      for (let index = prefix; index < tube.length; index++) {
        if (index === prefix || tube[index] !== tube[index - 1]) requiredDepartures++;
      }
      bound = Math.max(
        bound,
        targetCompletionLowerBound(tubes, target, capacity, true)
      );
    }
    // Every run above a target's correct bottom prefix must leave that tube.
    // One pour has only one source, so these departures add across targets.
    // A refill of a distinct, already-cleared color cannot remove any of them.
    // The final clear pours into the last active target. Its source cannot be
    // another still-unfinished target, so it is not one of these departures.
    return Math.max(bound, requiredDepartures + (targets.length ? 1 : 0));
  }

  function policyCost(value, context) {
    return context.options.objective === 'worst-case' ? value.worstUpper : value.upper;
  }

  function betterPolicy(upper, worst, bestUpper, bestWorst, context) {
    const primary = context.options.objective === 'worst-case' ? worst : upper;
    const bestPrimary = context.options.objective === 'worst-case' ? bestWorst : bestUpper;
    const secondary = context.options.objective === 'worst-case' ? upper : worst;
    const bestSecondary = context.options.objective === 'worst-case' ? bestUpper : bestWorst;
    return primary < bestPrimary - EPSILON
      || (Math.abs(primary - bestPrimary) <= EPSILON && secondary < bestSecondary - EPSILON);
  }

  function preparePolicyOutcomes(outcomes, targets, capacity, context) {
    const prepared = outcomes.map(outcome => {
      const state = normalizeSearchState(outcome.tubes, targets, capacity);
      return { ...outcome, state, lower: admissibleMoveLowerBound(state.tubes, state.targets, capacity) };
    });
    // Evaluate the hardest branch first; a bad branch can reject the entire
    // worst-case candidate before spending time on its easier siblings.
    if (context.options.objective === 'worst-case') prepared.sort((a, b) => b.lower - a.lower);
    const suffix = new Array(prepared.length + 1).fill(0);
    for (let index = prepared.length - 1; index >= 0; index--) {
      suffix[index] = context.options.objective === 'worst-case'
        ? Math.max(suffix[index + 1], prepared[index].lower)
        : suffix[index + 1] + prepared[index].probability * prepared[index].lower;
    }
    return { prepared, suffix };
  }

  function compareSearchNodes(left, right) {
    return left.priority - right.priority
      || left.depth - right.depth
      || left.order - right.order;
  }

  function heapPush(heap, node) {
    let index = heap.length;
    heap.push(node);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareSearchNodes(heap[parent], node) <= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = node;
  }

  function heapPop(heap) {
    if (heap.length === 0) return null;
    const first = heap[0];
    const last = heap.pop();
    if (heap.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      let best = left;
      if (right < heap.length && compareSearchNodes(heap[right], heap[left]) < 0) {
        best = right;
      }
      if (compareSearchNodes(last, heap[best]) <= 0) break;
      heap[index] = heap[best];
      index = best;
    }
    heap[index] = last;
    return first;
  }

  function structuralScore(
    tubes,
    targets,
    capacity = DEFAULT_CAPACITY,
    cacheTargets = false
  ) {
    const targetColors = targetColorsByTube(targets, tubes.length, cacheTargets);
    let score = countColorTransitions(tubes) * 5;

    for (let index = 0; index < tubes.length; index++) {
      const tube = tubes[index];
      const targetColor = targetColors[index];
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
      const currentStructure = structuralScore(
        candidate.tubes,
        candidate.targets,
        capacity,
        options.searchOptimized === true
      );
      return {
        fullShieldCount,
        eligibleCount,
        outcomeCount: estimatedOutcomeCount,
        expectedStructure: currentStructure,
        rank: options.objective === 'worst-case'
          ? candidate.depth + admissibleMoveLowerBound(candidate.tubes, candidate.targets, capacity)
            + currentStructure * 0.03 + estimatedOutcomeCount * 0.1
          : candidate.depth * 9 + currentStructure + estimatedOutcomeCount * 1.5 - fullShieldCount * 2
      };
    }

    const outcomes = enumerateRefillOutcomes(
      candidate.tubes,
      candidate.clearedColor,
      candidate.clearedTube,
      {
        capacity,
        refillCount,
        targets: candidate.targets,
        targetsNormalized: options.targetsNormalized === true,
        searchOptimized: options.searchOptimized === true
      }
    );
    const expectedStructure = outcomes.reduce(
      (sum, outcome) => sum + outcome.probability * structuralScore(
        outcome.tubes,
        candidate.targets,
        capacity,
        options.searchOptimized === true
      ),
      0
    );
    const worstLower = options.objective === 'worst-case' ? outcomes.reduce((worst, outcome) =>
      Math.max(worst, admissibleMoveLowerBound(outcome.tubes, candidate.targets, capacity)), 0) : 0;

    return {
      fullShieldCount,
      eligibleCount,
      outcomeCount: outcomes.length,
      expectedStructure,
      rank: options.objective === 'worst-case'
        ? candidate.depth + worstLower + expectedStructure * 0.03 + outcomes.length * 0.1
        : candidate.depth * 9 + expectedStructure + outcomes.length * 1.5 - fullShieldCount * 2
    };
  }

  function reconstructRawPath(endNode) {
    const moves = [];
    let current = endNode;
    while (current && current.move) {
      moves.push(current.move);
      current = current.parent;
    }
    moves.reverse();
    return moves;
  }

  function materializeMovePlan(tubes, targets, rawMoves, capacity = DEFAULT_CAPACITY) {
    let state = normalizeState(tubes, targets, capacity);
    const records = [];
    for (const move of rawMoves) {
      const next = applyMoveAndClear(state.tubes, state.targets, move, capacity);
      records.push(next.record);
      state = { tubes: next.tubes, targets: next.targets };
    }
    return records;
  }

  function makeSearchContext(options = {}) {
    const startedAt = nowMs();
    const timeLimitMs = Number.isFinite(options.timeLimitMs) ? options.timeLimitMs : 4000;
    const context = {
      options: {
        objective: options.objective === 'worst-case' ? 'worst-case' : 'expected',
        moveBudget: Number.isInteger(options.moveBudget) ? Math.max(0, options.moveBudget) : 20,
        capacity: options.capacity || DEFAULT_CAPACITY,
        refillCount: options.refillCount || DEFAULT_REFILL_COUNT,
        timeLimitMs,
        maxStageNodes: options.maxStageNodes || 30000,
        maxStageCandidates: options.maxStageCandidates || 80,
        maxLockedCandidates: Number.isFinite(options.maxLockedCandidates)
          ? Math.max(0, Math.floor(options.maxLockedCandidates))
          : 16,
        stageDepthSlack: Number.isFinite(options.stageDepthSlack) ? options.stageDepthSlack : 5,
        maxCandidatesEvaluated: options.maxCandidatesEvaluated || { 4: 10, 3: 7, 2: 14 },
        maxLockedCandidatesEvaluated: Number.isFinite(options.maxLockedCandidatesEvaluated)
          ? Math.max(0, Math.floor(options.maxLockedCandidatesEvaluated))
          : 4,
        finalNodeLimit: options.finalNodeLimit || 250000,
        greedyNodeLimit: options.greedyNodeLimit || 9000,
        greedyCandidateLimit: options.greedyCandidateLimit || 18,
        greedyLockedCandidateLimit: Number.isFinite(options.greedyLockedCandidateLimit)
          ? Math.max(0, Math.floor(options.greedyLockedCandidateLimit))
          : 4,
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

    const incumbentEntries = options.initialIncumbent
      && options.initialIncumbent.policy
      && Array.isArray(options.initialIncumbent.policy.entries)
      ? options.initialIncumbent.policy.entries
      : [];
    for (const entry of incumbentEntries) {
      if (!entry || !entry.canonicalKey || !Number.isFinite(entry.upperBound)) continue;
      context.greedyMemo.set(entry.canonicalKey, {
        upper: entry.upperBound,
        worstUpper: entry.worstCaseUpper,
        plan: cloneMovePlan(entry.plan),
        orderedKey: entry.orderedKey,
        complete: true
      });
    }
    return context;
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
      orderedKey: orderedStateKeyNormalized(state.tubes, state.targets),
      tubes: cloneTubes(state.tubes),
      targets: cloneTargets(state.targets),
      plan: cloneMovePlan(result.plan),
      upperBound: result.upper,
      worstCaseUpper: result.worstUpper,
      source
    };
    const previous = context.policyEntries.get(key);
    if (!previous || betterPolicy(entry.upperBound, entry.worstCaseUpper,
      previous.upperBound, previous.worstCaseUpper, context)) {
      context.policyEntries.set(key, entry);
    }
  }

  function isExpired(context, deadline = context.deadline) {
    return Number.isFinite(deadline) && nowMs() >= deadline;
  }

  function insertRankedCandidate(candidates, candidate, limit, truncation) {
    if (!Number.isFinite(limit)) {
      candidates.push(candidate);
      return;
    }
    if (limit <= 0) {
      truncation.minDiscardedDepth = Math.min(truncation.minDiscardedDepth, candidate.depth);
      truncation.discardedCandidates++;
      return;
    }

    if (candidates.length < limit) {
      let index = candidates.length;
      candidates.push(candidate);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (candidates[parent].layout.rank >= candidate.layout.rank) break;
        candidates[index] = candidates[parent];
        index = parent;
      }
      candidates[index] = candidate;
      return;
    }

    if (candidate.layout.rank < candidates[0].layout.rank) {
      truncation.minDiscardedDepth = Math.min(
        truncation.minDiscardedDepth,
        candidates[0].depth
      );
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= candidates.length) break;
        const right = left + 1;
        let worstChild = left;
        if (right < candidates.length
          && candidates[right].layout.rank > candidates[left].layout.rank) {
          worstChild = right;
        }
        if (candidates[worstChild].layout.rank <= candidate.layout.rank) break;
        candidates[index] = candidates[worstChild];
        index = worstChild;
      }
      candidates[index] = candidate;
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
    const maxLockedCandidates = Number.isFinite(overrides.maxLockedCandidates)
      ? Math.max(0, Math.floor(overrides.maxLockedCandidates))
      : context.options.maxLockedCandidates;
    const depthSlack = Number.isFinite(overrides.depthSlack)
      ? overrides.depthSlack
      : context.options.stageDepthSlack;
    const deadline = overrides.deadline || context.deadline;
    const maxClearDepth = Number.isFinite(overrides.maxClearDepth) ? overrides.maxClearDepth : Infinity;

    const start = normalizeSearchState(tubes, targets, capacity);
    const rootNode = {
      tubes: start.tubes,
      targets: start.targets,
      depth: 0,
      parent: null,
      move: null,
      key: canonicalStateKeyNormalized(start.tubes, start.targets),
      priority: admissibleNextClearLowerBound(start.tubes, start.targets, capacity),
      order: 0
    };
    const frontier = [rootNode];
    const seen = new Map([[rootNode.key, 0]]);
    const terminalSeen = new Map();
    const candidates = [];
    const lockedCandidates = [];
    const truncation = {
      minDiscardedDepth: Infinity,
      minUnexpandedClearDepth: Infinity,
      discardedCandidates: 0,
      reason: null
    };

    let expanded = 0;
    let order = 1;
    let shortestClearDepth = Infinity;

    while (frontier.length > 0) {
      if (expanded >= maxNodes) {
        truncation.reason = 'node-limit';
        truncation.minUnexpandedClearDepth = Math.min(
          truncation.minUnexpandedClearDepth,
          frontier[0].priority
        );
        break;
      }
      if (isExpired(context, deadline)) {
        truncation.reason = 'time-limit';
        truncation.minUnexpandedClearDepth = Math.min(
          truncation.minUnexpandedClearDepth,
          frontier[0].priority
        );
        break;
      }

      const current = heapPop(frontier);
      if (seen.get(current.key) !== current.depth) continue;
      if (current.priority > maxClearDepth) {
        truncation.reason = 'incumbent-bound';
        truncation.minUnexpandedClearDepth = current.priority;
        break;
      }
      if (Number.isFinite(shortestClearDepth)
        && current.priority > shortestClearDepth + depthSlack) {
        truncation.reason = truncation.reason || 'depth-slack';
        truncation.minUnexpandedClearDepth = Math.min(
          truncation.minUnexpandedClearDepth,
          current.priority
        );
        break;
      }

      expanded++;
      context.stats.deterministicNodes++;
      const moves = generateLegalMovesNormalized(
        current.tubes,
        current.targets,
        capacity,
        true,
        current.move
      );
      for (const move of moves) {
        const next = applySearchMove(current.tubes, current.targets, move, capacity);
        const depth = current.depth + 1;
        const nextNode = {
          tubes: next.tubes,
          targets: next.targets,
          depth,
          parent: current,
          move,
          key: null,
          priority: 0,
          order: order++
        };

        if (next.clearedColor) {
          shortestClearDepth = Math.min(shortestClearDepth, depth);
          const terminalKey = `${next.clearedTube}:${next.clearedColor}#${refillTerminalStateKey(
            next.tubes,
            next.targets,
            next.clearedTube
          )}`;
          const previousDepth = terminalSeen.get(terminalKey);
          if (previousDepth !== undefined && previousDepth <= depth) continue;
          terminalSeen.set(terminalKey, depth);

          const candidate = {
            depth,
            endNode: nextNode,
            tubes: next.tubes,
            targets: next.targets,
            clearedTube: next.clearedTube,
            clearedColor: next.clearedColor
          };
          candidate.layout = analyzeClearLayout(candidate, {
            objective: context.options.objective,
            capacity,
            refillCount,
            quick: true,
            targetsNormalized: true,
            searchOptimized: true
          });
          if (candidate.layout.outcomeCount === 1 && maxLockedCandidates > 0) {
            insertRankedCandidate(
              lockedCandidates,
              candidate,
              maxLockedCandidates,
              truncation
            );
          } else {
            insertRankedCandidate(candidates, candidate, maxCandidates, truncation);
          }
          context.stats.macroCandidates++;
          continue;
        }

        const key = canonicalStateKeyNormalized(next.tubes, next.targets);
        const previousDepth = seen.get(key);
        if (previousDepth !== undefined && previousDepth <= depth) continue;
        seen.set(key, depth);
        nextNode.key = key;
        nextNode.priority = depth + admissibleNextClearLowerBound(
          next.tubes,
          next.targets,
          capacity
        );
        heapPush(frontier, nextNode);
      }
    }

    candidates.push(...lockedCandidates);
    for (const candidate of candidates) {
      candidate.layout = analyzeClearLayout(candidate, {
        objective: context.options.objective,
        capacity,
        refillCount,
        targetsNormalized: true,
        searchOptimized: true
      });
    }
    candidates.sort((a, b) => a.layout.rank - b.layout.rank || a.depth - b.depth);
    for (const candidate of candidates) {
      candidate.moves = reconstructRawPath(candidate.endNode);
      delete candidate.endNode;
    }
    const exhaustive = frontier.length === 0
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
    const start = normalizeSearchState(tubes, targets, capacity);
    const key = canonicalStateKeyNormalized(start.tubes, start.targets);
    const orderedKey = orderedStateKeyNormalized(start.tubes, start.targets);
    const cached = context.finalMemo.get(key);
    if (cached) {
      context.stats.cacheHits++;
      if (!cached.moves || cached.orderedKey === orderedKey) return cached;
      const remappedMoves = remapPolicyPlan({
        canonicalKey: key,
        orderedKey: cached.orderedKey,
        tubes: cached.tubes,
        targets: cached.targets,
        plan: cached.moves
      }, start.tubes, start.targets, capacity);
      if (remappedMoves) return { ...cached, moves: remappedMoves, orderedKey };
    }
    if (start.targets.length === 0) {
      const complete = {
        found: true,
        distance: 0,
        moves: [],
        proven: true,
        lower: 0,
        orderedKey,
        tubes: start.tubes,
        targets: start.targets
      };
      context.finalMemo.set(key, complete);
      return complete;
    }

    const rootNode = {
      tubes: start.tubes,
      targets: start.targets,
      depth: 0,
      parent: null,
      move: null,
      key,
      priority: admissibleMoveLowerBound(start.tubes, start.targets, capacity),
      order: 0
    };
    const frontier = [rootNode];
    const bestDepth = new Map([[key, 0]]);
    let expanded = 0;
    let order = 1;

    while (frontier.length > 0) {
      if (expanded >= context.options.finalNodeLimit || isExpired(context, deadline)) {
        const lower = frontier.length > 0
          ? frontier[0].priority
          : admissibleMoveLowerBound(start.tubes, start.targets, capacity);
        return { found: false, distance: Infinity, moves: null, proven: false, lower };
      }

      const current = heapPop(frontier);
      if (bestDepth.get(current.key) !== current.depth) continue;
      if (current.targets.length === 0) {
        const result = {
          found: true,
          distance: current.depth,
          moves: reconstructRawPath(current),
          proven: true,
          lower: current.depth,
          orderedKey,
          tubes: start.tubes,
          targets: start.targets
        };
        context.finalMemo.set(key, result);
        return result;
      }

      expanded++;
      context.stats.staticNodes++;
      const moves = generateLegalMovesNormalized(
        current.tubes,
        current.targets,
        capacity,
        true,
        current.move
      );
      for (const move of moves) {
        const next = applySearchMove(current.tubes, current.targets, move, capacity);
        const nextNode = {
          tubes: next.tubes,
          targets: next.targets,
          depth: current.depth + 1,
          parent: current,
          move,
          key: null,
          priority: 0,
          order: order++
        };
        const nextKey = canonicalStateKeyNormalized(next.tubes, next.targets);
        const previousDepth = bestDepth.get(nextKey);
        if (previousDepth !== undefined && previousDepth <= nextNode.depth) continue;
        bestDepth.set(nextKey, nextNode.depth);
        nextNode.key = nextKey;
        nextNode.priority = nextNode.depth + admissibleMoveLowerBound(
          next.tubes,
          next.targets,
          capacity
        );
        heapPush(frontier, nextNode);
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
    const state = normalizeSearchState(tubes, targets, capacity);
    const key = canonicalStateKeyNormalized(state.tubes, state.targets);
    const orderedKey = orderedStateKeyNormalized(state.tubes, state.targets);
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
      maxLockedCandidates: context.options.greedyLockedCandidateLimit,
      depthSlack: context.options.greedyDepthSlack,
      deadline: context.upperDeadline
    });

    let best = null;
    const bestLocked = enumeration.candidates.find(candidate => candidate.layout.outcomeCount === 1);
    const greedyCandidates = bestLocked
      ? [bestLocked, ...enumeration.candidates.filter(candidate => candidate !== bestLocked)]
      : enumeration.candidates;
    const tryLimit = Math.min(4, greedyCandidates.length);
    for (let candidateIndex = 0; candidateIndex < tryLimit; candidateIndex++) {
      if (isExpired(context, context.upperDeadline)) break;
      const candidate = greedyCandidates[candidateIndex];
      const outcomes = enumerateRefillOutcomes(
        candidate.tubes,
        candidate.clearedColor,
        candidate.clearedTube,
        {
          capacity,
          refillCount,
          targets: candidate.targets,
          targetsNormalized: true,
          searchOptimized: true
        }
      );
      context.stats.chanceOutcomes += outcomes.length;

      const { prepared: preparedOutcomes, suffix } = preparePolicyOutcomes(
        outcomes, candidate.targets, capacity, context
      );
      if (best && candidate.depth + suffix[0] > policyCost(best, context) + EPSILON) continue;

      let expected = candidate.depth;
      let worst = candidate.depth;
      let complete = true;
      for (let outcomeIndex = 0; outcomeIndex < preparedOutcomes.length; outcomeIndex++) {
        const outcome = preparedOutcomes[outcomeIndex];
        const child = greedyPolicyValue(
          outcome.state.tubes,
          outcome.state.targets,
          context,
          false
        );
        if (!child.complete || !Number.isFinite(child.upper)) {
          complete = false;
          break;
        }
        expected += outcome.probability * child.upper;
        worst = Math.max(worst, candidate.depth + child.worstUpper);
        const runningLower = context.options.objective === 'worst-case'
          ? Math.max(worst, candidate.depth + suffix[outcomeIndex + 1])
          : expected + suffix[outcomeIndex + 1];
        if (best && runningLower > policyCost(best, context) + EPSILON) {
          complete = false;
          break;
        }
      }

      if (complete && (!best || betterPolicy(expected, worst, best.upper, best.worstUpper, context))) {
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

  function solvePolicyState(tubes, targets, context, wantPlan = false, upperLimit = Infinity) {
    const capacity = context.options.capacity;
    const refillCount = context.options.refillCount;
    const state = normalizeSearchState(tubes, targets, capacity);
    const key = canonicalStateKeyNormalized(state.tubes, state.targets);
    const orderedKey = orderedStateKeyNormalized(state.tubes, state.targets);
    const cached = context.valueMemo.get(key);
    if (cached && policyCost(cached, context) <= upperLimit
      && (!wantPlan || cached.orderedKey === orderedKey)) {
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
        lower: admissibleMoveLowerBound(state.tubes, state.targets, capacity),
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

    const incumbentCost = context.options.objective === 'worst-case'
      ? Math.min(bestWorst, upperLimit) : bestUpper;
    const enumeration = enumerateFirstClearCandidates(state.tubes, state.targets, context, {
      maxClearDepth: Number.isFinite(incumbentCost)
        ? Math.floor(incumbentCost - Math.max(0, targetCount - 1))
        : Infinity
    });
    const evaluationLimit = getCandidateEvaluationLimit(targetCount, context);
    const lockedEvaluationLimit = context.options.maxLockedCandidatesEvaluated;
    let evaluated = 0;
    let bonusLockedEvaluated = 0;
    let evaluatedLower = Infinity;
    let unevaluatedLower = Infinity;
    let allEvaluatedCandidatesExact = true;
    const lockedCandidates = enumeration.candidates.filter(
      candidate => candidate.layout.outcomeCount === 1
    );
    const generalCandidates = enumeration.candidates.filter(
      candidate => candidate.layout.outcomeCount !== 1
    );
    const evaluationCandidates = [...lockedCandidates, ...generalCandidates];

    for (let candidateIndex = 0; candidateIndex < evaluationCandidates.length; candidateIndex++) {
      const candidate = evaluationCandidates[candidateIndex];
      const isLocked = candidate.layout.outcomeCount === 1;
      const hasEvaluationSlot = isLocked
        ? bonusLockedEvaluated < lockedEvaluationLimit
        : evaluated < evaluationLimit;
      if (!hasEvaluationSlot || isExpired(context)) {
        unevaluatedLower = Math.min(
          unevaluatedLower,
          candidate.depth + minimumDecisionMoves(candidate.targets, candidate.clearedColor)
        );
        allEvaluatedCandidatesExact = false;
        continue;
      }

      if (isLocked) bonusLockedEvaluated++;
      else evaluated++;
      const outcomes = enumerateRefillOutcomes(
        candidate.tubes,
        candidate.clearedColor,
        candidate.clearedTube,
        {
          capacity,
          refillCount,
          targets: candidate.targets,
          targetsNormalized: true,
          searchOptimized: true
        }
      );
      context.stats.chanceOutcomes += outcomes.length;

      const { prepared: preparedOutcomes, suffix } = preparePolicyOutcomes(
        outcomes, candidate.targets, capacity, context
      );
      const bestCost = context.options.objective === 'worst-case'
        ? Math.min(bestWorst, upperLimit) : bestUpper;
      const initialCandidateLower = candidate.depth + suffix[0];
      if (Number.isFinite(bestCost) && initialCandidateLower > bestCost + EPSILON) {
        unevaluatedLower = Math.min(unevaluatedLower, initialCandidateLower);
        allEvaluatedCandidatesExact = false;
        continue;
      }

      let candidateLower = candidate.depth;
      let candidateUpper = candidate.depth;
      let candidateWorst = candidate.depth;
      let completeUpper = true;
      let exactChildren = true;
      let prunedByBound = false;

      for (let outcomeIndex = 0; outcomeIndex < preparedOutcomes.length; outcomeIndex++) {
        const outcome = preparedOutcomes[outcomeIndex];
        const child = solvePolicyState(
          outcome.state.tubes,
          outcome.state.targets,
          context,
          false,
          context.options.objective === 'worst-case' ? bestCost - candidate.depth : Infinity
        );
        candidateLower = context.options.objective === 'worst-case'
          ? Math.max(candidateLower, candidate.depth + child.lower)
          : candidateLower + outcome.probability * child.lower;
        exactChildren = exactChildren && child.proven;
        if (Number.isFinite(child.upper)) {
          candidateUpper += outcome.probability * child.upper;
          candidateWorst = Math.max(candidateWorst, candidate.depth + child.worstUpper);
        } else {
          completeUpper = false;
        }

        const runningLower = context.options.objective === 'worst-case'
          ? Math.max(candidateLower, candidate.depth + suffix[outcomeIndex + 1])
          : candidateLower + suffix[outcomeIndex + 1];
        if (context.options.objective === 'worst-case'
          && candidate.depth + child.worstUpper > bestCost) {
          // The child's bounded search did not construct a sufficiently short
          // continuation. Keep its rigorous lower bound, but do not mistake a
          // budget-limited miss for an impossibility proof.
          unevaluatedLower = Math.min(unevaluatedLower, runningLower);
          allEvaluatedCandidatesExact = false;
          prunedByBound = true;
          break;
        }
        if (Number.isFinite(bestCost) && runningLower > bestCost + EPSILON) {
          unevaluatedLower = Math.min(unevaluatedLower, runningLower);
          allEvaluatedCandidatesExact = false;
          prunedByBound = true;
          break;
        }
      }

      if (prunedByBound) continue;

      evaluatedLower = Math.min(evaluatedLower, candidateLower);
      allEvaluatedCandidatesExact = allEvaluatedCandidatesExact && exactChildren;
      if (completeUpper && betterPolicy(candidateUpper, candidateWorst, bestUpper, bestWorst, context)) {
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
    const bestCost = context.options.objective === 'worst-case' ? bestWorst : bestUpper;
    let lower = Math.min(evaluatedLower, unevaluatedLower, unseenLower);
    if (!Number.isFinite(lower)) {
      lower = Number.isFinite(bestCost) ? bestCost : admissibleMoveLowerBound(state.tubes, state.targets, capacity);
    }
    lower = Math.max(lower, admissibleMoveLowerBound(state.tubes, state.targets, capacity));
    if (Number.isFinite(bestCost)) lower = Math.min(lower, bestCost);

    const proven = Number.isFinite(bestCost)
      && Math.abs(bestCost - lower) <= EPSILON
      && (enumeration.exhaustive || unseenLower >= bestCost - EPSILON)
      && (allEvaluatedCandidatesExact || unevaluatedLower >= bestCost - EPSILON);
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

  function solveRefillPolicyOnce(initialTubes, initialTargets, options = {}) {
    const context = makeSearchContext(options);
    const capacity = context.options.capacity;
    const start = normalizeState(initialTubes, initialTargets, capacity);

    const greedy = greedyPolicyValue(start.tubes, start.targets, context, true);
    context.stats.greedyElapsedMs = nowMs() - context.startedAt;
    context.stats.greedyUpper = greedy.upper;
    if (greedy.complete) {
      context.greedyMemo.set(canonicalStateKeyNormalized(start.tubes, start.targets), greedy);
    }
    const solved = solvePolicyState(start.tubes, start.targets, context, true);
    const rawPlan = solved.plan || greedy.plan || [];
    const plan = materializeMovePlan(start.tubes, start.targets, rawPlan, capacity);
    const selected = solved.selectedCandidate || greedy.selectedCandidate || null;
    const elapsedMs = nowMs() - context.startedAt;
    const objective = context.options.objective;
    const solvedCost = policyCost(solved, context);
    const gap = Number.isFinite(solvedCost)
      ? Math.max(0, solvedCost - solved.lower)
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
        objective,
        guaranteed: solved.guaranteed,
        provenOptimal: solved.proven,
        lowerBound: objective === 'worst-case'
          ? admissibleMoveLowerBound(start.tubes, start.targets, capacity)
          : solved.lower,
        objectiveLowerBound: solved.lower,
        objectiveUpperBound: solvedCost,
        worstCaseLower: objective === 'worst-case' ? solved.lower : null,
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
    result.certificate.moveBudget = context.options.moveBudget;
    result.certificate.budgetStatus = solved.guaranteed === true
      && solved.worstUpper <= context.options.moveBudget ? 'guaranteed'
      : solved.lower > context.options.moveBudget ? 'impossible' : 'unproven';
    if (context.options.includePolicy) {
      result.policy = {
        objective,
        entries: [...context.policyEntries.values()]
          .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey))
      };
    }
    return finalizePolicyResult(result, start.tubes, start.targets, context.options);
  }

  // Combining independently improved sub-policies may change expected cost:
  // a safer child can have a higher average. Recalculate the actual selected
  // tree before publishing either bound, rather than trusting stale parents.
  function finalizePolicyResult(result, tubes, targets, options) {
    if (!result.policy || result.certificate.guaranteed !== true) return result;
    const started = nowMs();
    const capacity = options.capacity || DEFAULT_CAPACITY;
    const entries = new Map(result.policy.entries.map(entry => [entry.canonicalKey, entry]));
    const memo = new Map();
    function visit(board, goals) {
      const state = normalizeSearchState(board, goals, capacity);
      if (!state.targets.length) return { expected: 0, worst: 0 };
      const key = canonicalStateKeyNormalized(state.tubes, state.targets);
      if (memo.has(key)) return memo.get(key);
      const entry = entries.get(key);
      if (!entry) return null;
      const plan = remapPolicyPlan(entry, state.tubes, state.targets, capacity);
      if (!plan || !plan.length) return null;
      let next = state;
      for (const move of plan) next = applySearchMove(next.tubes, next.targets, move, capacity);
      if (!next.clearedColor || next.targets.length >= state.targets.length) return null;
      let expected = plan.length;
      let worst = plan.length;
      if (next.targets.length) {
        const outcomes = enumerateRefillOutcomes(next.tubes, next.clearedColor, next.clearedTube, {
          capacity, refillCount: options.refillCount || DEFAULT_REFILL_COUNT,
          targets: next.targets, targetsNormalized: true, searchOptimized: true
        });
        for (const outcome of outcomes) {
          const child = visit(outcome.tubes, next.targets);
          if (!child) return null;
          expected += outcome.probability * child.expected;
          worst = Math.max(worst, plan.length + child.worst);
        }
      }
      entry.upperBound = expected;
      entry.worstCaseUpper = worst;
      const value = { expected, worst };
      memo.set(key, value);
      return value;
    }
    const value = visit(tubes, targets);
    if (!value) {
      result.certificate.guaranteed = null;
      result.certificate.budgetStatus = 'unproven';
      return result;
    }
    const continuation = getPolicyContinuation(result.policy, tubes, targets, options);
    if (continuation) {
      result.plan = continuation.plan;
      for (const field of ['nextClearSteps', 'fullShieldCount', 'eligibleRefillTubes', 'refillOutcomeCount']) {
        result.certificate[field] = continuation.certificate[field];
      }
    }
    const cert = result.certificate;
    cert.upperBound = value.expected;
    cert.worstCaseUpper = value.worst;
    cert.objectiveUpperBound = cert.objective === 'worst-case' ? value.worst : value.expected;
    cert.absoluteGap = Math.max(0, cert.objectiveUpperBound - cert.objectiveLowerBound);
    cert.relativeGap = cert.objectiveLowerBound > EPSILON ? cert.absoluteGap / cert.objectiveLowerBound : null;
    cert.provenOptimal = cert.absoluteGap <= EPSILON;
    cert.budgetStatus = value.worst <= cert.moveBudget ? 'guaranteed'
      : cert.objectiveLowerBound > cert.moveBudget ? 'impossible' : 'unproven';
    // Only the selected tree must cross the Worker boundary or remain in the
    // page. Discard thousands of unused search alternatives from that payload.
    result.policy.entries = result.policy.entries.filter(entry => memo.has(entry.canonicalKey));
    result.stats.policyValidationStates = memo.size;
    result.stats.elapsedMs += nowMs() - started;
    return result;
  }

  function isBetterPolicyResult(candidate, incumbent) {
    if (!incumbent) return true;
    if (candidate.certificate.objective === 'worst-case') {
      const candidateWorst = candidate.certificate.worstCaseUpper;
      const incumbentWorst = incumbent.certificate.worstCaseUpper;
      if (candidateWorst < incumbentWorst - EPSILON) return true;
      if (candidateWorst > incumbentWorst + EPSILON) return false;
    }
    const candidateUpper = candidate.certificate.upperBound;
    const incumbentUpper = incumbent.certificate.upperBound;
    if (candidateUpper < incumbentUpper - EPSILON) return true;
    if (candidateUpper > incumbentUpper + EPSILON) return false;
    const candidateWorst = candidate.certificate.worstCaseUpper;
    const incumbentWorst = incumbent.certificate.worstCaseUpper;
    if (candidateWorst < incumbentWorst - EPSILON) return true;
    if (candidateWorst > incumbentWorst + EPSILON) return false;
    return candidate.plan.length < incumbent.plan.length;
  }

  function mergePolicyEntries(first, second, objective = 'expected') {
    const merged = new Map();
    for (const result of [first, second]) {
      const entries = result && result.policy && Array.isArray(result.policy.entries)
        ? result.policy.entries
        : [];
      for (const entry of entries) {
        const previous = merged.get(entry.canonicalKey);
        if (!previous || betterPolicy(entry.upperBound, entry.worstCaseUpper,
          previous.upperBound, previous.worstCaseUpper, { options: { objective } })) {
          merged.set(entry.canonicalKey, entry);
        }
      }
    }
    return [...merged.values()].sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
  }

  function solveRefillPolicy(initialTubes, initialTargets, options = {}) {
    const warmOptions = options.warmStartOptions;
    const totalLimitMs = Number.isFinite(options.timeLimitMs) ? options.timeLimitMs : 4000;
    if (!warmOptions || totalLimitMs <= 0) {
      return solveRefillPolicyOnce(initialTubes, initialTargets, options);
    }

    const portfolioStartedAt = nowMs();
    const configuredWarmLimit = Number.isFinite(warmOptions.timeLimitMs)
      ? warmOptions.timeLimitMs
      : Math.min(4000, totalLimitMs);
    const warmLimitMs = Math.max(1, Math.min(totalLimitMs, configuredWarmLimit));
    const warmResult = solveRefillPolicyOnce(initialTubes, initialTargets, {
      ...warmOptions,
      objective: options.objective,
      moveBudget: options.moveBudget,
      timeLimitMs: warmLimitMs,
      includePolicy: true,
      warmStartOptions: undefined,
      initialIncumbent: undefined
    });

    const elapsedAfterWarm = nowMs() - portfolioStartedAt;
    const remainingMs = Math.max(0, totalLimitMs - elapsedAfterWarm);
    if (remainingMs < 10) {
      warmResult.stats = {
        ...warmResult.stats,
        warmStartElapsedMs: elapsedAfterWarm,
        portfolioElapsedMs: elapsedAfterWarm
      };
      if (options.includePolicy !== true) delete warmResult.policy;
      return warmResult;
    }

    const fullResult = solveRefillPolicyOnce(initialTubes, initialTargets, {
      ...options,
      timeLimitMs: remainingMs,
      warmStartOptions: undefined,
      initialIncumbent: warmResult
    });
    const chosen = isBetterPolicyResult(fullResult, warmResult)
      ? fullResult
      : warmResult;
    const result = {
      ...chosen,
      plan: chosen.plan.map(move => ({
        ...move,
        remainingTargets: cloneTargets(move.remainingTargets || []),
        afterState: cloneTubes(move.afterState || [])
      })),
      certificate: { ...chosen.certificate },
      stats: { ...chosen.stats }
    };

    const combinedLower = Math.min(
      result.certificate.objectiveUpperBound,
      Math.max(
        warmResult.certificate.objectiveLowerBound,
        fullResult.certificate.objectiveLowerBound
      )
    );
    const combinedGap = Number.isFinite(result.certificate.objectiveUpperBound)
      ? Math.max(0, result.certificate.objectiveUpperBound - combinedLower)
      : Infinity;
    result.certificate.objectiveLowerBound = combinedLower;
    if (result.certificate.objective === 'worst-case') result.certificate.worstCaseLower = combinedLower;
    else result.certificate.lowerBound = combinedLower;
    result.certificate.absoluteGap = combinedGap;
    result.certificate.relativeGap = Number.isFinite(combinedGap) && combinedLower > EPSILON
      ? combinedGap / combinedLower
      : null;
    result.certificate.provenOptimal = result.certificate.provenOptimal
      || (Number.isFinite(result.certificate.objectiveUpperBound) && combinedGap <= EPSILON);
    result.certificate.budgetStatus = result.certificate.guaranteed === true
      && result.certificate.worstCaseUpper <= result.certificate.moveBudget ? 'guaranteed'
      : combinedLower > result.certificate.moveBudget ? 'impossible' : 'unproven';

    const counterKeys = [
      'deterministicNodes',
      'staticNodes',
      'macroCandidates',
      'chanceOutcomes',
      'policyStates',
      'cacheHits',
      'greedyStates'
    ];
    for (const key of counterKeys) {
      result.stats[key] = (warmResult.stats[key] || 0) + (fullResult.stats[key] || 0);
    }
    result.stats.warmStartElapsedMs = warmResult.stats.elapsedMs;
    result.stats.fullSearchElapsedMs = fullResult.stats.elapsedMs;
    result.stats.elapsedMs = nowMs() - portfolioStartedAt;

    if (options.includePolicy === true) {
      result.policy = {
        objective: result.certificate.objective,
        entries: mergePolicyEntries(warmResult, fullResult, result.certificate.objective)
      };
    } else {
      delete result.policy;
    }
    return finalizePolicyResult(result, initialTubes, normalizeTargets(initialTargets), options);
  }

  // A certified contingent policy already contains a plan for every refill
  // state it can reach. Reuse that exact continuation instead of starting an
  // unrelated search after each clear, which could lose the original budget.
  function getPolicyContinuation(policy, tubes, targets, options = {}) {
    if (!policy || !Array.isArray(policy.entries)) return null;
    const capacity = options.capacity || DEFAULT_CAPACITY;
    const state = normalizeState(tubes, targets, capacity);
    const key = canonicalStateKeyNormalized(state.tubes, state.targets);
    const entry = policy.entries.find(value => value.canonicalKey === key);
    if (!entry || !Number.isFinite(entry.worstCaseUpper)) return null;
    const rawPlan = remapPolicyPlan(entry, state.tubes, state.targets, capacity);
    if (!rawPlan || rawPlan.length === 0) return null;
    const plan = materializeMovePlan(state.tubes, state.targets, rawPlan, capacity);
    const objective = policy.objective || 'expected';
    const lower = admissibleMoveLowerBound(state.tubes, state.targets, capacity);
    const cost = objective === 'worst-case' ? entry.worstCaseUpper : entry.upperBound;
    const moveBudget = Number.isInteger(options.moveBudget) ? Math.max(0, options.moveBudget) : 20;
    const last = plan[plan.length - 1];
    const layout = analyzeClearLayout({ depth: plan.length, tubes: last.afterState,
      targets: last.remainingTargets, clearedTube: last.clearedTube, clearedColor: last.clearedColor }, options);
    return {
      kind: 'refill-policy', plan, policy,
      certificate: {
        objective, guaranteed: true, provenOptimal: cost === lower,
        lowerBound: lower, upperBound: entry.upperBound,
        objectiveLowerBound: lower, objectiveUpperBound: cost,
        worstCaseLower: objective === 'worst-case' ? lower : null,
        worstCaseUpper: entry.worstCaseUpper,
        absoluteGap: Math.max(0, cost - lower),
        moveBudget, budgetStatus: entry.worstCaseUpper <= moveBudget ? 'guaranteed' : 'unproven',
        nextClearSteps: plan.length, shortestClearDepth: null, deliberateSetupSteps: null,
        fullShieldCount: layout.fullShieldCount, eligibleRefillTubes: layout.eligibleCount,
        refillOutcomeCount: layout.outcomeCount
      },
      stats: { elapsedMs: 0, reusedPolicy: true }
    };
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
      move: null,
      key: canonicalStateKeyNormalized(start.tubes, start.targets),
      priority: admissibleMoveLowerBound(start.tubes, start.targets, capacity),
      order: 0
    };
    const frontier = [rootNode];
    const bestDepth = new Map([[rootNode.key, 0]]);
    let expanded = 0;
    let order = 1;
    let lowerBound = rootNode.priority;
    let stoppedByLimit = false;

    while (frontier.length > 0) {
      if (expanded >= context.options.finalNodeLimit || isExpired(context)) {
        lowerBound = frontier[0].priority;
        stoppedByLimit = true;
        break;
      }

      const current = heapPop(frontier);
      if (bestDepth.get(current.key) !== current.depth) continue;
      if (current.targets.length === 0) {
        const plan = materializeMovePlan(
          start.tubes,
          start.targets,
          reconstructRawPath(current),
          capacity
        );
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

      expanded++;
      context.stats.staticNodes++;
      const moves = generateLegalMovesNormalized(
        current.tubes,
        current.targets,
        capacity,
        true,
        current.move
      );
      for (const move of moves) {
        const next = applySearchMove(current.tubes, current.targets, move, capacity);
        const node = {
          tubes: next.tubes,
          targets: next.targets,
          depth: current.depth + 1,
          parent: current,
          move,
          key: null,
          priority: 0,
          order: order++
        };
        const key = canonicalStateKeyNormalized(next.tubes, next.targets);
        const previousDepth = bestDepth.get(key);
        if (previousDepth !== undefined && previousDepth <= node.depth) continue;
        bestDepth.set(key, node.depth);
        node.key = key;
        node.priority = node.depth + admissibleMoveLowerBound(
          next.tubes,
          next.targets,
          capacity
        );
        heapPush(frontier, node);
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
      error: stoppedByLimit ? 'search-limit' : 'no-solution'
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
      plan: selected
        ? materializeMovePlan(
          state.tubes,
          state.targets,
          selected.moves,
          context.options.capacity
        )
        : [],
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
    getPolicyContinuation,
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
