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
- The 25-move whole-game target includes all three refills before the fourth recipe clears. A guarantee requires a complete branch certificate; continuations are reused and executed moves are deducted from the original total budget, including when the next screenshot is imported without playing the steps in this page
- Budget search passes remaining whole-game moves to every refill branch, progressively tightens verified strategies, and resumes first-clear frontiers beyond the ranked shortlist. Time, node and live-state limits keep the incumbent on exhaustion
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
node water_solver_budget_search_test.js
node water_solver_batch_verify_test.js
node water_image_engine_test.js
node seeded_simulation_test.js
```

Across 2,048 fixed refill seeds on the built-in sample, every strategy clears 100% of runs. The policy spends one extra setup move before the first clear to leave exactly four refill-eligible tubes, locking that refill to one outcome. It averages 16.800 moves with an observed maximum of 17. That is 4.025 moves (19.33%) below the 20.825-move immediate-clear baseline, whose maximum is 23. Blindly maximizing full-tube shields averages 23 moves, so deterministic refill is prioritized only when its evaluated downstream cost is actually lower.

Worst-case mode verifies all 7 distinct refill edges in the selected sample policy (8 policy states), with a maximum of 17 moves and an exact expectation of 16.8. Independent exhaustive oracles cover 114 compact stochastic boards and 1,760 static shortest-path cases. Pruning adds required departures across target tubes plus the final clear, uses a small capacity-bounded dynamic program for color transfers and blocker removal, checks difficult refill branches first, limits first-clear depth, and passes the remaining move limit to child searches. Only selected policy states cross the Worker boundary and remain in the page.

The 25-move certificate covers the current board, all three modeled random refills, and the verified policy. The latest supplied five-color, four-recipe screenshot has a certified 21-move policy. All 1,000 generated starting boards (500 four-color and 500 five-color, including 500 fragmented wrong-bottom recipe layouts) passed complete branch verification, with worst cases of 14–25 moves. An independent replay checked 11,607 policy states and 12,935 refill edges. The batch exposed restrictive layout limits and missing cached continuations; recovery now widens the search within the existing time budget and carries the complete cached plans. This coverage is not a proof over every possible initial board. No fourth refill is included after the final recipe. The [verification report](./docs/water-budget-verification.md) includes per-case results, seeds, and reproduction commands. Batch verification runs offline in Node and is never loaded by the website.

The next optimization revisited the 125 previously certified 25-move boards using the default four-second profile: 15 now need at most 23 moves, 92 at most 24, and 18 remain at 25. All selected refill branches pass independent replay; 104 boards have a proven optimal worst-case count. Eight compact three-recipe games additionally match an independent exhaustive minimax oracle at both the feasible budget and one move below it.

Another 200 boards generated with a new seed all pass complete three-refill verification within the same default budget: worst cases are 15–25 moves, 195 boards are within 24, and 88 have a proven optimal worst-case count. Full records and reproduction commands are in the verification report.

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
