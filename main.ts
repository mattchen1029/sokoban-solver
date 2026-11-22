// A push-optimal Sokoban solver.
//
// How it works (from the structure the competition itself describes in RULES.txt):
//  * A level is a one-square-wide hallway with one to four rooms off it. A box
//    pushed out of a room's door into the hallway can never be pushed back, so
//    every box stays in its room and the level's push optimum P* is the sum of
//    the rooms' optima.
//  * Cut the hallway row's dead squares (squares a box standing on them can
//    never be pushed onto a goal) out of the floor; each remaining connected
//    part holding boxes is one room. Solve each room push-optimally in turn,
//    with the other rooms' boxes treated as walls, and concatenate the moves.
//    The walk between rooms costs moves, never pushes, so the total is P*.
//  * Each room is solved with A* over pushes. A state is the boxes' squares
//    plus the player's reachable region (named by its lowest square). The
//    estimate is the cheapest assignment of boxes to goals by walking
//    distance; one push changes it by at most one, so it is admissible and
//    the first solution found is push-optimal. Deadlock pruning: a box may
//    only be pushed onto a live square (one it can be pulled back from a
//    goal to), and a push that leaves a box in a frozen 2 x 2 block of walls
//    and boxes is refused. A solved room is accepted only when the player can
//    still reach its door to walk out.
//  * If the optimal search runs out of its work budget on a room, a greedy
//    best-first search (same pruning, estimate only) tries for any solution,
//    which still scores rather than nothing.
//  * Deterministic: fixed work budgets, no clock, no randomness. The program
//    reads /input/<id>/level.txt and writes /output/<id>/solution.txt.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search expands before it gives up: work, never the clock. */
const ROOM_BUDGET = 200_000;

const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** A level in XSB text: its width and height, walls, goals, boxes and player. */
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
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const d of DIRS) {
      const dd = d.dy * w + d.dx;
      const y = x - dd;
      if (!wall[y] && !wall[y - dd] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** For every square and goal, the walking distance between them around walls alone (-1 when none). */
function goalDistances(lv: Level): Int32Array {
  const { w, wall, goals } = lv;
  const nGoals = goals.length;
  const dist = new Int32Array(wall.length * nGoals).fill(-1);
  for (let gi = 0; gi < nGoals; gi++) {
    const g = goals[gi]!;
    const queue = [g];
    dist[g * nGoals + gi] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (wall[q] || dist[q * nGoals + gi] >= 0) continue;
        dist[q * nGoals + gi] = dist[p * nGoals + gi] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * The push-optimal solution of `level` within `maxExpansions` state expansions:
 * {pushes, moves} (moves in LURD, a lower letter a step, an upper one a push),
 * or null when the search gives up. When `exitSq` is given (>= 0), a solved
 * state counts only when the player can still walk to that square. When
 * `greedy` is set, the search follows the estimate alone instead of pushes
 * plus estimate: it finds a solution fast but not necessarily an optimal one.
 */
function solvePushOptimal(
  lv: Level,
  maxExpansions: number,
  exitSq: number,
  greedy: boolean,
): { pushes: number; moves: string } | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = lv;
  const size = wall.length;
  const nGoals = goals.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(lv);
  for (const b of startBoxes) if (!live[b]) return null;
  const gdist = goalDistances(lv);
  const numericKey = Math.pow(size, startBoxes.length + 1) < 9007199254740992;

  // Scratch: `seen` stamps the squares of one flood fill, `stack` its work list,
  // `occupied` the boxes of the state being expanded. `stamp` counts the fills.
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  let stamp = 0;

  /** The lowest square the player reaches from `from` (boxes in `occupied` in the way); marks `seen` with a fresh stamp. */
  const flood = (from: number): number => {
    stamp++;
    let low = from;
    let n = 0;
    stack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      const q0 = p - w;
      const q1 = p + w;
      const q2 = p - 1;
      const q3 = p + 1;
      if (!wall[q0] && !occupied[q0] && seen[q0] !== stamp) {
        seen[q0] = stamp;
        stack[n++] = q0;
      }
      if (!wall[q1] && !occupied[q1] && seen[q1] !== stamp) {
        seen[q1] = stamp;
        stack[n++] = q1;
      }
      if (!wall[q2] && !occupied[q2] && seen[q2] !== stamp) {
        seen[q2] = stamp;
        stack[n++] = q2;
      }
      if (!wall[q3] && !occupied[q3] && seen[q3] !== stamp) {
        seen[q3] = stamp;
        stack[n++] = q3;
      }
    }
    return low;
  };

  /** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
  const frozen = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) || (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
    }
    return false;
  };

  /** The cheapest assignment of the boxes to distinct goals by walking distance; Infinity when none exists. */
  const estimate = (boxes: number[]): number => {
    const n = boxes.length;
    if (n !== nGoals || n > 6) {
      let sum = 0;
      for (const b of boxes) {
        let m = Infinity;
        for (let gi = 0; gi < nGoals; gi++) {
          const d = gdist[b * nGoals + gi]!;
          if (d >= 0 && d < m) m = d;
        }
        if (m === Infinity) return Infinity;
        sum += m;
      }
      return sum;
    }
    let best = Infinity;
    const used = new Uint8Array(nGoals);
    const assign = (i: number, sum: number): void => {
      if (sum >= best) return;
      if (i === n) {
        best = sum;
        return;
      }
      const b = boxes[i]!;
      for (let gi = 0; gi < nGoals; gi++) {
        if (used[gi]) continue;
        const d = gdist[b * nGoals + gi]!;
        if (d < 0) continue;
        used[gi] = 1;
        assign(i + 1, sum + d);
        used[gi] = 0;
      }
    };
    assign(0, 0);
    return best;
  };

  /** A state's key: its region's lowest square and the boxes' squares. */
  const keyOf = (boxes: number[], low: number): number | string => {
    if (numericKey) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return `${low}:${boxes.join(',')}`;
  };

  /** The shortest walk from `from` to `to` around walls and the boxes in `occupied`, in lower LURD letters. */
  const walkTo = (from: number, to: number): string => {
    if (from === to) return '';
    const prev = new Int32Array(size).fill(-1);
    const how = new Array<string>(size);
    const queue = [from];
    prev[from] = from;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      if (p === to) break;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (wall[q] || occupied[q] || prev[q] !== -1) continue;
        prev[q] = p;
        how[q] = d.step;
        queue.push(q);
      }
    }
    if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
    let s = '';
    for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
    return s;
  };

  // The states in the order found: their boxes, the player's square, and the push that made them from their parent.
  const stBoxes: number[][] = [];
  const stPlayer: number[] = [];
  const stParent: number[] = [];
  const stPushFrom: number[] = [];
  const stPushTo: number[] = [];
  const stPushDir: number[] = [];
  const stKey: (number | string)[] = [];
  const best = new Map<number | string, number>();

  for (const b of startBoxes) occupied[b] = 1;
  const low0 = flood(startPlayer);
  for (const b of startBoxes) occupied[b] = 0;
  const k0 = keyOf(startBoxes, low0);
  stBoxes.push(startBoxes.slice());
  stPlayer.push(startPlayer);
  stParent.push(-1);
  stPushFrom.push(-1);
  stPushTo.push(-1);
  stPushDir.push(-1);
  stKey.push(k0);
  best.set(k0, 0);
  const h0 = estimate(startBoxes);
  if (h0 === Infinity) return null;

  // The open list, a heap on (estimate, then deeper first, then first found).
  const heap: [number, number, number, number][] = [[h0, 0, 0, 0]];
  let seq = 0;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expansions = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, g, , si] = heapPop();
    if (best.get(stKey[si]!) !== g) continue; // superseded by a better path to the same state
    const boxes = stBoxes[si]!;
    const player = stPlayer[si]!;
    if (boxes.every((b) => goalSet[b])) {
      if (exitSq < 0) {
        found = si;
        break;
      }
      for (const b of boxes) occupied[b] = 1;
      flood(player);
      const out = seen[exitSq] === stamp;
      for (const b of boxes) occupied[b] = 0;
      if (out) {
        found = si;
        break;
      }
      // The player is shut in: keep searching for a solved state it can walk out of.
    }
    if (expansions >= maxExpansions) return null;
    expansions++;
    for (const b of boxes) occupied[b] = 1;
    flood(player);
    const here = stamp;
    // First pass: which pushes the player can make from this region. (A
    // successor's own flood fill would overwrite these marks, so the pushes
    // are all collected before any successor is built.)
    const cands: { bi: number; di: number; tgt: number }[] = [];
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const dd = d.dy * w + d.dx;
        const tgt = b + dd;
        if (seen[b - dd] !== here || wall[tgt] || occupied[tgt] || !live[tgt]) continue;
        cands.push({ bi, di, tgt });
      }
    }
    // Second pass: build each successor.
    for (const { bi, di, tgt } of cands) {
      const b = boxes[bi]!;
      const nb = boxes.slice();
      nb[bi] = tgt;
      nb.sort((a, b2) => a - b2);
      occupied[b] = 0;
      occupied[tgt] = 1;
      if (frozen(tgt)) {
        occupied[tgt] = 0;
        occupied[b] = 1;
        continue;
      }
      const nlow = flood(b);
      occupied[tgt] = 0;
      occupied[b] = 1;
      const key = keyOf(nb, nlow);
      const ng = g + 1;
      const prev = best.get(key);
      if (prev !== undefined && prev <= ng) continue;
      const nh = estimate(nb);
      if (nh === Infinity) continue;
      best.set(key, ng);
      const ni = stBoxes.length;
      stBoxes.push(nb);
      stPlayer.push(b);
      stParent.push(si);
      stPushFrom.push(b);
      stPushTo.push(tgt);
      stPushDir.push(di);
      stKey.push(key);
      heapPush([greedy ? nh : ng + nh, ng, ++seq, ni]);
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes.slice();
  for (const s of path) {
    const from = stPushFrom[s]!;
    const to = stPushTo[s]!;
    const di = stPushDir[s]!;
    const d = DIRS[di]!;
    const dd = d.dy * w + d.dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(player, from - dd);
    for (const b of boxes) occupied[b] = 0;
    moves += d.push;
    player = from;
    const bi = boxes.indexOf(from);
    boxes[bi] = to;
    boxes.sort((a, b2) => a - b2);
  }
  return { pushes: path.length, moves };
}

type Room = { boxes: number[]; goals: number[]; doorSq: number; exitSq: number };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds
 * a box is a room, with its door square and the hallway square outside it.
 * Null when the level is no set of rooms.
 */
function roomsOf(lv: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const live = liveSquares(lv);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const parts: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = parts.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = parts.length;
          squares.push(q);
        }
      }
    }
    parts.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) parts[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    parts[part[g]!]!.goals.push(g);
  }
  if (parts.some((r) => r.boxes.length !== r.goals.length)) return null;
  const rooms: Room[] = [];
  for (const r of parts) {
    if (r.boxes.length === 0) continue;
    let doorSq = -1;
    let exitSq = -1;
    for (const s of r.squares) {
      for (const d of DIRS) {
        const q = s + d.dy * w + d.dx;
        if (cut[q]) {
          doorSq = s;
          exitSq = q;
          break;
        }
      }
      if (doorSq >= 0) break;
    }
    if (doorSq < 0) return null;
    rooms.push({
      boxes: r.boxes.sort((a, b) => a - b),
      goals: r.goals.sort((a, b) => a - b),
      doorSq,
      exitSq,
    });
  }
  return rooms;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/** The level's moves: each room solved push-optimally in turn, the other rooms' boxes standing as walls. */
function solveLevel(lv: Level): string {
  const rooms = roomsOf(lv);
  if (rooms === null) {
    const whole = solvePushOptimal(lv, ROOM_BUDGET, -1, false) ?? solvePushOptimal(lv, ROOM_BUDGET, -1, true);
    return whole ? whole.moves : '';
  }
  let player = lv.player;
  let moves = '';
  const done = new Set<number>();
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const wall = lv.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const other = rooms[oj]!;
      for (const b of done.has(oj) ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = { w: lv.w, h: lv.h, wall, goals: room.goals.slice(), boxes: room.boxes.slice(), player };
    let solved = solvePushOptimal(sub, ROOM_BUDGET, room.exitSq, false);
    if (solved === null) solved = solvePushOptimal(sub, ROOM_BUDGET, room.exitSq, true);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(lv.w, player, solved.moves);
    done.add(ri);
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
