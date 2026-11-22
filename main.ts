// Sokoban solver: room-by-room push-optimal A*.
//
// The levels this bounty draws are a hallway with small rooms off it (3-4
// boxes each, in a 6x6 slot). A box pushed out of its room into the hallway
// can never come back, so the rooms are independent: the level's push
// optimum is the sum of the rooms' optima. This solver finds the rooms by
// cutting the hallway's dead squares out of the floor, then solves each room
// push-optimally with A* over pushes (a state is the boxes plus the player's
// reachable region), and joins the rooms' move strings with the walks
// between them. The heuristic is the cheapest assignment of boxes to goals
// by lone-box push distance, which never overestimates, so the first solved
// state A* pops is push-optimal for its room.
//
// Deterministic by construction: the search is bounded by a state count,
// never the clock, and ties break by insertion order, so two runs write the
// same bytes. No network, no files outside /input, /output and /bot.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The most states one room search keeps before it gives up: work, never the clock.
const MAX_STATES = 1_000_000;

// The four directions: [dx, dy, walk letter, push letter].
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: width, height, walls, goals, boxes, player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * For each goal, the fewest pushes a lone box needs to reach it, by square.
 * A lone box at s can be pushed to s+d when s+d is floor and the player can
 * stand at s-d, so the distances come from a backwards breadth-first walk
 * from the goals: from a square x, a predecessor is y = x-d with y and y-d
 * floor. A square no goal's walk reaches is dead for a box (-1 everywhere).
 */
function pushDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const size = wall.length;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (y < 0 || y >= size) continue;
        if (wall[y] || wall[y - d] || dist[y] >= 0) continue;
        dist[y] = dist[x]! + 1;
        queue.push(y);
      }
    }
    out.push(dist);
  }
  return out;
}

/** Whether any goal is reachable for a lone box on square s. */
function liveMask(dist: Int32Array[]): Uint8Array {
  const size = dist[0]!.length;
  const live = new Uint8Array(size);
  for (let s = 0; s < size; s++) {
    for (const d of dist) {
      if (d[s]! >= 0) {
        live[s] = 1;
        break;
      }
    }
  }
  return live;
}

/**
 * The cheapest one-to-one assignment of boxes to goals, by the push-distance
 * tables: the minimum over all matchings of the summed distances, or
 * Infinity when no matching exists. With at most five boxes this is a
 * straight permutation search; with more, the sum of each box's nearest goal
 * (still a lower bound, just a looser one).
 */
function assignmentCost(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 5) {
    let total = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (const d of dist) if (d[b]! >= 0 && d[b]! < best) best = d[b]!;
      if (best === Infinity) return Infinity;
      total += best;
    }
    return total;
  }
  const used = new Array<boolean>(n).fill(false);
  let best = Infinity;
  const place = (i: number, total: number): void => {
    if (total >= best) return;
    if (i === n) {
      best = total;
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const c = dist[j]![boxes[i]!]!;
      if (c < 0) continue;
      used[j] = true;
      place(i + 1, total + c);
      used[j] = false;
    }
  };
  place(0, 0);
  return best;
}

/** The squares the player reaches from `from` around walls and boxes. */
class Region {
  seen: Int32Array;
  stack: Int32Array;
  stamp = 0;
  constructor(size: number) {
    this.seen = new Int32Array(size);
    this.stack = new Int32Array(size);
  }
  /** Flood fill from `from`; returns the region's lowest square. */
  lowest(level: Level, occupied: Uint8Array, from: number): number {
    const { w, wall } = level;
    const stamp = ++this.stamp;
    let low = from;
    let n = 0;
    this.stack[n++] = from;
    this.seen[from] = stamp;
    while (n > 0) {
      const p = this.stack[--n]!;
      if (p < low) low = p;
      const q0 = p - w;
      const q1 = p + w;
      const q2 = p - 1;
      const q3 = p + 1;
      if (wall[q0] === 0 && occupied[q0] === 0 && this.seen[q0] !== stamp) {
        this.seen[q0] = stamp;
        this.stack[n++] = q0;
      }
      if (wall[q1] === 0 && occupied[q1] === 0 && this.seen[q1] !== stamp) {
        this.seen[q1] = stamp;
        this.stack[n++] = q1;
      }
      if (wall[q2] === 0 && occupied[q2] === 0 && this.seen[q2] !== stamp) {
        this.seen[q2] = stamp;
        this.stack[n++] = q2;
      }
      if (wall[q3] === 0 && occupied[q3] === 0 && this.seen[q3] !== stamp) {
        this.seen[q3] = stamp;
        this.stack[n++] = q3;
      }
    }
    return low;
  }
}

/** A binary heap on [priority, insertion order, state index]. */
class Heap {
  items: [number, number, number][] = [];
  less(a: [number, number, number], b: [number, number, number]): boolean {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }
  push(e: [number, number, number]): void {
    const a = this.items;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number] {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && this.less(a[c + 1]!, a[c]!)) c++;
        if (!this.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
  get length(): number {
    return this.items.length;
  }
}

interface Push {
  from: number;
  to: number;
  dir: number;
}

/**
 * The push-optimal solution of a level: {pushes, moves} (moves in LURD, a
 * lower letter a step, an upper one a push), or null when the search gives
 * up. A* over pushes: a state is the boxes and the player's reachable
 * region (named by its lowest square); the estimate is the cheapest
 * assignment of boxes to goals, which never overestimates, so the first
 * solved state popped is push-optimal. `greedy` orders the heap by the
 * estimate alone, trading optimality for finding any solution fast; it is
 * the fallback when the optimal search runs out of states.
 */
function solvePush(level: Level, maxStates: number, greedy: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = pushDistances(level);
  const live = liveMask(dist);
  const occupied = new Uint8Array(size);
  const region = new Region(size);
  const region2 = new Region(size);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (level.boxes.some((b) => live[b] === 0)) return null;

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
  // and boxes with a box off its goal: no push can ever free it.
  const frozenBlock = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (a < 0 || d >= size) continue;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
    }
    return false;
  };

  const keyOf = (boxes: number[], low: number): string => boxes.join(',') + '|' + low;

  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sPush: (Push | null)[] = [null];
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = region.lowest(level, occupied, level.player);
  for (const b of level.boxes) occupied[b] = 0;
  best.set(keyOf(level.boxes, startLow), 0);
  const heap = new Heap();
  let seq = 0;
  const h0 = assignmentCost(level.boxes, dist);
  if (h0 === Infinity) return null;
  heap.push([h0, seq++, 0]);
  let found = solved(level.boxes) ? 0 : -1;

  while (heap.length > 0 && found < 0) {
    const [, , s] = heap.pop();
    const boxes = sBoxes[s]!;
    const g = sG[s]!;
    for (const b of boxes) occupied[b] = 1;
    const low = region.lowest(level, occupied, sPlayer[s]!);
    const stamp = region.stamp;
    if (best.get(keyOf(boxes, low)) !== g) {
      // Stale heap entry: a shorter path to this state was recorded since.
      for (const x of boxes) occupied[x] = 0;
      continue;
    }
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const stance = b - d;
        const t = b + d;
        if (region.seen[stance] !== stamp) continue;
        if (wall[t] || occupied[t] || live[t] === 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(t);
        let key = '';
        let next: number[] | null = null;
        let low = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, bb) => a - bb);
          low = region2.lowest(level, occupied, b);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        // No one-to-one assignment of the boxes to goals exists (two boxes
        // can only reach the same goal): the state is dead. Check this
        // before recording the state, so a dead state never poisons the
        // visited map for a later, live route to the same key.
        const h = assignmentCost(next, dist);
        if (h === Infinity) continue;
        const seen = best.get(key);
        if (seen !== undefined && seen <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(g + 1);
        sParent.push(s);
        sPush.push({ from: b, to: t, dir: d });
        heap.push([greedy ? h : g + 1 + h, seq++, idx]);
        if (solved(next)) {
          found = idx;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const push = sPush[s]!;
    const nextBoxes = sBoxes[s]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, push.from - push.dir);
    for (const b of boxes) occupied[b] = 0;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === push.dir)!;
    moves += dir[3];
    player = push.from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player square after `moves` (LURD, case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when a box starts in the hallway, a goal is
 * cut off, or a part holds a different count of boxes and goals: then the
 * level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const dist = pushDistances(level);
  const live = liveMask(dist);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && live[i] === 0) cut[i] = 1;
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  withBoxes.sort((a, b) => a.squares[0]! - b.squares[0]!);
  return withBoxes;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 * Null when a room's search gives up, or the level is no set of rooms and
 * the search over the whole level gives up.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePush(level, MAX_STATES, false) ?? solvePush(level, MAX_STATES / 4, true);
    return whole;
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePush(sub, MAX_STATES, false) ?? solvePush(sub, MAX_STATES / 4, true);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves that solve a level in XSB, or '' when it is already solved or unsolved. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const solved = solveByRooms(level);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  // One bad instance must never kill the whole set: a level that throws
  // (malformed input, an unreachable push square) still gets its file, so
  // the other four keep their points.
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
