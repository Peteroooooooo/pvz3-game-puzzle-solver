# PVZ3 Game Puzzle Solver

Static browser tools for **Plants vs. Zombies 3** puzzle solving.

Live demo: [https://peteroooooooo.github.io/pvz3-game-puzzle-solver/](https://peteroooooooo.github.io/pvz3-game-puzzle-solver/)

## What this repo contains

- `pvz3_water_sort_solver.html` - refill-aware PVZ3 puzzle solver with animation and physical validation
- `water_solver_engine.js` - testable shortest-path, full-tube shielding, and stochastic policy engine
- `water_solver_worker.js` - background browser solver worker
- `seeded_simulation_test.js` - reproducible fixed-refill-seed policy A/B test
- `pvz3_decode_solver.html` - companion decoding / feedback solver
- `assets/pvz3/` - local art assets used by the tools

## Highlights

- PVZ3-style refill-aware water sort logic
- Shield-aware policy search compares immediate clears with deliberate full-tube setup and enumerates every modeled refill outcome
- Static mode performs complete state search and proves the shortest route; the built-in sample improves from the legacy 15 steps to a proven 13 steps
- Refill mode reports guaranteed-policy status, expected-step lower/upper bounds, and the remaining optimality gap; global expected optimality is shown only when the bounds meet
- 4-second, 15-second, and 60-second search budgets run inside a Web Worker
- Default strict-feedback decoder strategy: all 11,880 valid non-repeating secrets are guaranteed to finish within 4 rounds under permanent correct-slot locks
- Browser-only, no install required
- Friendly for GitHub Pages deployment

## Verification

```bash
node smoke_test.js
node water_solver_engine_test.js
node seeded_simulation_test.js
```

Across 2,048 fixed refill seeds on the built-in sample, both the immediate-clear baseline and the bounded policy clear 100% of runs. The bounded policy reduces the mean from 20.844 to 20.598 moves (0.246 moves, about 1.18%) and the observed maximum from 23 to 22. Blindly maximizing full-tube shields instead increases the mean to 23 moves, so the policy balances setup cost against future refill risk.

## Docs

- [中文说明](./README.zh-CN.md)
- [文案审查](./docs/copy-review.md)

## Keywords

PVZ3, Plants vs. Zombies 3, game puzzle solver, water sort puzzle, A* solver, refill simulation, static site, GitHub Pages

## Note

This is a fan-made project and is not affiliated with PopCap, EA, or the official Plants vs. Zombies team.
