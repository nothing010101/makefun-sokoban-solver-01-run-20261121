# Room-by-room push-optimal Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) [![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/nothing010101/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) [![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/nothing010101/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Entry for the [make.fun](https://make.fun) bounty
[`sokoban-solver-01-run-20261121`](https://make.fun/bounty/sokoban-solver-01-run-20261121):
a Sokoban solver that answers every instance of a set push-optimally — the
level's optimum, not just a solution.

## What it is

- `main.ts` — the program the harness runs (`node /bot/main.ts`): reads
  `/input/<id>/level.txt` for i001–i005 and writes
  `/output/<id>/solution.txt` (LURD moves, upper letter a push) for each.
  Pure TypeScript, Node built-ins only, no network, deterministic.

## How it works

The drawn levels are a hallway with small rooms off it (3–4 boxes each, in
a 6×6 slot), and a box pushed out of its room into the hallway can never
come back — so the rooms are independent and the level's push optimum is
the sum of the rooms' optima. The solver:

1. **Finds the rooms** by cutting the hallway's dead squares (floor squares
   of the player's row from which no box can reach a goal) out of the floor;
   each remaining component holding boxes is a room.
2. **Solves each room push-optimally** with A* over pushes. A state is the
   boxes plus the player's reachable region (named by its lowest square);
   the estimate is the cheapest one-to-one assignment of boxes to goals by
   lone-box push distance, which never overestimates, so the first solved
   state popped is push-optimal for its room. Dead squares and frozen 2×2
   blocks are pruned. The other rooms' boxes stand as walls while a room
   is solved (on their goals once done).
3. **Joins the rooms** with the walks between them, in a fixed room order.

A greedy best-first pass (same search, ordered by the estimate alone) is
the fallback when the optimal search runs out of states, and a whole-level
A* is the fallback when a level is no set of rooms. The search is bounded
by a state count, never the clock, and ties break by insertion order, so
two runs write the same bytes.

## Correctness and score

See [`report.md`](report.md) for the full evidence: **practice set 5/5
solved at exactly P\* (13, 16, 29, 47, 60 pushes) — score 1,000,000 /
1,000,000**, and the same on 3 extra sets drawn fresh from the kit's
generator (15/15 at P\*). The house baseline plain-astar 1.0.0 scores
200,000 on the practice set (only i001 solved). Whole set runs in ~0.5 s
of the 60 s budget. Two runs are byte-identical.

## License

MIT — see [LICENSE](LICENSE).
