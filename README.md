# Sokoban solver

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty.

## How it works

A level is a one-square-wide hallway with one to four rooms off it. A box
pushed out of a room's door into the hallway can never be pushed back, so
every box stays in its room and the level's push optimum P\* is the sum of
the rooms' optima. The solver exploits that:

1. **Decompose.** Cut the hallway row's dead squares (squares a box standing
   on them can never be pushed onto a goal) out of the floor; each remaining
   connected part holding boxes is one room, with its door square and the
   hallway square outside it.
2. **Solve each room push-optimally, in turn**, with the other rooms' boxes
   treated as walls, and concatenate the moves. The walk between rooms costs
   moves, never pushes, so the total is P\*.
3. **Each room is solved with A\* over pushes.** A state is the boxes'
   squares plus the player's reachable region (named by its lowest square).
   The estimate is the cheapest assignment of boxes to goals by walking
   distance; one push changes it by at most one, so it is admissible and the
   first solution found is push-optimal.
4. **Deadlock pruning.** A box may only be pushed onto a live square (one it
   can be pulled back from a goal to), and a push that leaves a box in a
   frozen 2 x 2 block of walls and boxes is refused. A solved room is
   accepted only when the player can still reach its door to walk out.
5. **Fallback.** If the optimal search runs out of its work budget on a
   room, a greedy best-first search (same pruning, estimate only) tries for
   any solution, which still scores rather than nothing.

The program is deterministic: fixed work budgets, no clock, no randomness.
It reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`
(LURD moves, an upper letter marking a push).

## Results

- Practice set: **1,000,000** (every instance solved in exactly P\* pushes).
- Three further sets drawn from the kit's generator with fresh seeds:
  **1,000,000** each.
- The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set.
- Runtime about 0.3 s for a 5-instance set (budget 60 s); two runs produce
  byte-identical outputs.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22 or later, no dependencies. `main.ts` is plain JavaScript with
erasable TypeScript annotations only.
