# PVZ3 Game Puzzle Solver

Static browser tools for **Plants vs. Zombies 3** puzzle solving.

Live demo: [https://peteroooooooo.github.io/pvz3-game-puzzle-solver/](https://peteroooooooo.github.io/pvz3-game-puzzle-solver/)

## What this repo contains

- `pvz3_water_sort_solver.html` - refill-aware PVZ3 puzzle solver with animation and physical validation
- `water_solver_engine.js` - testable shortest-path, full-tube shielding, and stochastic policy engine
- `water_solver_worker.js` - background browser solver worker
- `water_image_engine.js` / `water_image_worker.js` - on-demand local screenshot recognition
- `water_image_import.js` / `water_image_templates.js` - preview, corrections, and compact recipe references
- `seeded_simulation_test.js` - reproducible fixed-refill-seed policy A/B test
- `pvz3_decode_solver.html` - companion decoding / feedback solver
- `assets/pvz3/` - local art assets used by the tools

## Highlights

- PVZ3-style refill-aware water sort logic
- Local PNG, JPG, and WebP screenshot import by file picker, page-wide drag and drop, or clipboard paste, with seven-tube recognition, visual corrections, cropping, and undo
- Screenshot-derived recipe icons, source/receiver arrows, a compact responsive board, and a mobile current-step bar; strategy and search budget stay directly accessible
- Shield-aware policy search protects deterministic-refill layouts (especially exactly four eligible tubes), then compares their full downstream cost against immediate clears and other setups
- Static mode performs complete state search and proves the shortest route; the benchmark sample improves from the legacy 15 steps to a proven 13 steps
- Refill mode prioritizes the worst total move count, breaking ties by expected moves; worst-case bounds, expected policy cost, and optimality gaps are reported separately
- A 20-move guarantee requires a complete branch certificate; after refills, verified continuations are reused and executed moves are counted against the original total bound
- 4-second, 15-second, and 60-second search budgets run inside a Web Worker
- Default strict-feedback decoder strategy: all 11,880 valid non-repeating secrets are guaranteed to finish within 4 rounds under permanent correct-slot locks
- Browser-only, no install required
- Friendly for GitHub Pages deployment

## Verification

```bash
node smoke_test.js
node water_solver_engine_test.js
node water_solver_optimization_test.js
node water_solver_worst_case_test.js
node water_image_engine_test.js
node seeded_simulation_test.js
```

Across 2,048 fixed refill seeds on the built-in sample, every strategy clears 100% of runs. The policy spends one extra setup move before the first clear to leave exactly four refill-eligible tubes, locking that refill to one outcome. It averages 16.800 moves with an observed maximum of 17. That is 4.025 moves (19.33%) below the 20.825-move immediate-clear baseline, whose maximum is 23. Blindly maximizing full-tube shields averages 23 moves, so deterministic refill is prioritized only when its evaluated downstream cost is actually lower.

Worst-case mode verifies all 7 distinct refill edges in the selected sample policy (8 policy states), with a maximum of 17 moves and an exact expectation of 16.8. Independent exhaustive oracles cover 114 compact stochastic boards and 1,760 static shortest-path cases. Pruning adds required departures across target tubes plus the final clear, uses a small capacity-bounded dynamic program for color transfers and blocker removal, checks difficult refill branches first, limits first-clear depth, and passes the remaining move limit to child searches. Only selected policy states cross the Worker boundary and remain in the page.

The 20-move certificate applies to the current board, modeled refill rules, and verified policy; it is not a universal promise. The latest supplied five-color, four-recipe screenshot currently has a constructed 21-move policy, without a proof excluding a 20-move policy. A legal five-recipe editor configuration has a rigorous 21-move lower bound. A timed-out search remains unproven.

## Feedback decoder

Enter the displayed recommendation in the game, then select each slot's feedback. The submit button shows which feedback is missing and generates the next recommendation once all fields are ready. Click a base card to open the nearby five-card picker. **Undo last round** restores that round's cards, feedback, candidate set, confirmed slots, feedback model, and attempts. A unique answer ends the flow inline without a popup or further submissions; game-confirmed slots remain distinct from deduced answers. Calculation details stay collapsed unless feedback conflicts with history. Feedback icons are static transparent cutouts from the supplied game screenshot.

## Screenshot import

Drop a still game screenshot anywhere on the page, paste an image, or click **Import screenshot**. The original appears beside a compact seven-bottle preview on desktop and above it on phones. Click a layer or recipe to edit just that field. Check yellow items and assign values to **Please confirm** items, then click **Load board**. If detection fails, drag around the complete seven-tube game area. Recognition starts automatically when you release, without another click on **Recognize again**. Solving remains manual, and Undo restores the previous configuration.

The top-bar **Random refill** button keeps the existing refill behavior. Recipe colors are edited by clicking the icon below a bottle. The 100-run simulation lives under **More**. Playback timing and the complete step list stay visible; strategy explanations and search details can be expanded as needed. The five transparent recipe icons are static screenshot cutouts, with no image processing during display.

Images stay in the browser. The working image is limited to a 960-pixel longest edge. Recognition uses color segmentation, morphological closing, connected components, normalized bottle geometry, and compact foreground templates for all five recipes. Liquid recognition scans each visible layer region, normalizes brightness and chroma to image highlights, excludes sticker foreground and layer boundaries, and combines independent row evidence with a continuous bottom-to-top fill model. A hidden layer without color evidence stays unresolved. Recipe matching verifies internal luminance texture when a pale outline is broken; the coarse search stays small. If background pixels join white contours, at most two extra contrast passes contribute candidate contours while preserving complete ones. There is no vision model or new dependency. HTTP/GitHub Pages runs recognition in an on-demand worker that terminates afterward; direct HTML opening uses a bounded local fallback. Closing the preview releases its images. There is no idle scanning.

Recognition tests use decoded pixels from the supplied screenshots and cover scaling, black margins, changed spacing, and brightness. These derived cases do not replace screenshots from other actual devices. New bottle artwork, animation, and occlusion may need corrections. Unlisted stickers can be identified by a colored interior enclosed by a pale rim and are flagged for review. Local rim detection tolerates light pink or purple tinting to avoid missing grape stickers.

## Docs

- [中文说明](./README.zh-CN.md)
- [文案审查](./docs/copy-review.md)

## Keywords

PVZ3, Plants vs. Zombies 3, game puzzle solver, water sort puzzle, A* solver, refill simulation, static site, GitHub Pages

## Note

This is a fan-made project and is not affiliated with PopCap, EA, or the official Plants vs. Zombies team.
