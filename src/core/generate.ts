// 性格＋シード → DungeonInstance §5
// 具体地形は毎回 性格＋runSeed から生成する。統計的に似るが同一ではない。
// 1潜行の地形・敵配置・アイテムは runSeed で完全に決まる（憲法2・§4.2）。

import type {
  DungeonCharacter,
  DungeonInstance,
  Entity,
  EnemyKind,
  Feature,
  Floor,
  Item,
  Tile,
  Vec,
} from './types';
import { ENEMY_NAMES } from './character';
import type { RNG } from './rng';
import { hashSeed, mulberry32, pick, randInt, shuffle } from './rng';

export const FLOOR_W = 13;
export const FLOOR_H = 9;

// ---- グリッド補助 ----

export function inBounds(floor: Floor, p: Vec): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < floor.width && p.y < floor.height;
}

export function tileAt(floor: Floor, p: Vec): Tile | null {
  return inBounds(floor, p) ? floor.grid[p.y][p.x] : null;
}

export function featureAt(floor: Floor, p: Vec): Feature | undefined {
  return floor.features.find((f) => f.pos.x === p.x && f.pos.y === p.y);
}

export function enemyAt(floor: Floor, p: Vec): Entity | undefined {
  return floor.entities.find((e) => e.alive && e.pos.x === p.x && e.pos.y === p.y);
}

export function itemAt(floor: Floor, p: Vec): Item | undefined {
  return floor.items.find((i) => !i.taken && i.pos && i.pos.x === p.x && i.pos.y === p.y);
}

/** 歩行可能か（床であり、崩落に塞がれていない） */
export function isWalkable(floor: Floor, p: Vec): boolean {
  const t = tileAt(floor, p);
  if (!t || t.kind !== 'floor') return false;
  const f = featureAt(floor, p);
  if (f && f.kind === 'collapse') return false;
  return true;
}

/** 床セルの一覧 */
export function floorCells(floor: Floor): Vec[] {
  const out: Vec[] = [];
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      if (floor.grid[y][x].kind === 'floor') out.push({ x, y });
    }
  }
  return out;
}

/** from→to が歩行可能セルだけで到達可能か（BFS）。blocked を追加障害物として扱える */
export function isConnected(floor: Floor, from: Vec, to: Vec, blocked?: Vec): boolean {
  const key = (p: Vec) => `${p.x},${p.y}`;
  if (blocked && key(blocked) === key(from)) return false;
  if (blocked && key(blocked) === key(to)) return false;
  const seen = new Set<string>([key(from)]);
  const queue: Vec[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.x === to.x && cur.y === to.y) return true;
    for (const d of [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ]) {
      const next = { x: cur.x + d.x, y: cur.y + d.y };
      const k = key(next);
      if (seen.has(k)) continue;
      if (!isWalkable(floor, next)) continue;
      if (blocked && k === key(blocked)) continue;
      seen.add(k);
      queue.push(next);
    }
  }
  return false;
}

// ---- 生成本体 ----

type Room = { x: number; y: number; w: number; h: number };

function roomCenter(r: Room): Vec {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

function carveRoom(grid: Tile[][], r: Room): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      grid[y][x] = { kind: 'floor' };
    }
  }
}

/** L字通路を彫る */
function carveCorridor(grid: Tile[][], a: Vec, b: Vec, rng: RNG): void {
  const horizontalFirst = rng.next() < 0.5;
  let { x, y } = a;
  const stepX = () => {
    while (x !== b.x) {
      x += Math.sign(b.x - x);
      grid[y][x] = { kind: 'floor' };
    }
  };
  const stepY = () => {
    while (y !== b.y) {
      y += Math.sign(b.y - y);
      grid[y][x] = { kind: 'floor' };
    }
  };
  if (horizontalFirst) {
    stepX();
    stepY();
  } else {
    stepY();
    stepX();
  }
}

/** 未使用の床セルを1つ確保する（階段・泉・敵などの重複配置を避ける） */
function takeFreeCell(floor: Floor, cells: Vec[], used: Set<string>): Vec | null {
  for (const c of cells) {
    const k = `${c.x},${c.y}`;
    if (used.has(k)) continue;
    if (featureAt(floor, c) || enemyAt(floor, c) || itemAt(floor, c)) continue;
    used.add(k);
    return c;
  }
  return null;
}

function generateFloor(
  character: DungeonCharacter,
  depth: number,
  maxDepth: number,
  rng: RNG,
): Floor {
  const grid: Tile[][] = [];
  for (let y = 0; y < FLOOR_H; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < FLOOR_W; x++) row.push({ kind: 'wall' });
    grid.push(row);
  }

  // 部屋を3つ彫り、順に通路でつなぐ（必ず連結になる）
  const rooms: Room[] = [];
  for (let i = 0; i < 3; i++) {
    const w = randInt(rng, 3, 5);
    const h = randInt(rng, 2, 3);
    const x = randInt(rng, 1, FLOOR_W - 1 - w);
    const y = randInt(rng, 1, FLOOR_H - 1 - h);
    rooms.push({ x, y, w, h });
  }
  for (const r of rooms) carveRoom(grid, r);
  for (let i = 0; i + 1 < rooms.length; i++) {
    carveCorridor(grid, roomCenter(rooms[i]), roomCenter(rooms[i + 1]), rng);
  }

  const floor: Floor = {
    depth,
    width: FLOOR_W,
    height: FLOOR_H,
    grid,
    entities: [],
    items: [],
    features: [],
  };

  const b = character.biases;
  const cells = shuffle(rng, floorCells(floor));
  const used = new Set<string>();

  // 階段（B1の上り階段＝入口）
  const upPos = takeFreeCell(floor, cells, used)!;
  // 下層ほど帰り道が崩れやすい（性格 lowerReturnDifficulty）
  const crumbleP = maxDepth > 1 ? b.lowerReturnDifficulty * ((depth - 1) / (maxDepth - 1)) : 0;
  floor.features.push({
    id: `f${depth}-up`,
    kind: 'stairsUp',
    pos: upPos,
    crumbling: depth > 1 && rng.next() < crumbleP,
  });
  if (depth < maxDepth) {
    const downPos = takeFreeCell(floor, cells, used)!;
    floor.features.push({ id: `f${depth}-down`, kind: 'stairsDown', pos: downPos });
  } else {
    // 最深部の宝
    const tPos = takeFreeCell(floor, cells, used)!;
    floor.features.push({ id: `f${depth}-treasure`, kind: 'treasure', pos: tPos });
  }

  // 泉（たまに湧く）
  if (rng.next() < 0.55) {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.features.push({ id: `f${depth}-spring`, kind: 'spring', pos: p });
  }

  // 毒罠: 上層ほど出やすい（性格 upperTrapRate）
  const upperness = maxDepth > 1 ? 1 - (depth - 1) / (maxDepth - 1) : 1;
  const trapCount = Math.round(b.upperTrapRate * (0.6 + upperness * 1.8) + rng.next() * 0.5);
  for (let i = 0; i < trapCount; i++) {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.features.push({ id: `f${depth}-trap${i}`, kind: 'trap', pos: p });
  }

  // 敵: 密度は低め・一体ごとの危険度は高め（性格）
  const enemyCount = Math.max(1, Math.round(b.enemyDensity * 4 + rng.next() * 0.8));
  for (let i = 0; i < enemyCount; i++) {
    const p = takeFreeCell(floor, cells, used);
    if (!p) break;
    const kind: EnemyKind =
      rng.next() < b.metallicEnemyRate ? 'metallic' : pick(rng, ['beast', 'shade'] as const);
    const depthFrac = maxDepth > 1 ? (depth - 1) / (maxDepth - 1) : 0;
    const strength = Math.min(
      0.95,
      Math.max(0.1, 0.2 + depthFrac * 0.5 + (b.enemyLethality - 0.5) * 0.3 + (rng.next() - 0.5) * 0.16),
    );
    floor.entities.push({
      id: `e${depth}-${i}`,
      kind,
      name: pick(rng, ENEMY_NAMES[kind]),
      pos: p,
      strength,
      alive: true,
    });
  }

  // アイテム: 糧食は各階ほぼ確実、薬はときどき、武器は中層に性格次第で
  if (rng.next() < 0.85) {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.items.push({ id: `i${depth}-food`, kind: 'food', name: '乾いた糧食', pos: p, taken: false });
  }
  if (rng.next() < 0.5) {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.items.push({ id: `i${depth}-potion`, kind: 'potion', name: '濁った薬', pos: p, taken: false });
  }
  const midDepth = Math.ceil(maxDepth / 2);
  if (depth === midDepth && rng.next() < b.rewardWeaponBias) {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.items.push({ id: `i${depth}-weapon`, kind: 'weapon', name: '古びた剣', pos: p, taken: false });
  }

  return floor;
}

/**
 * 性格＋runSeed → 具体インスタンス。
 * 同じ runSeed なら常に同一の迷宮になる（§4.2 再現性）。
 */
export function generateInstance(character: DungeonCharacter, runSeed: number): DungeonInstance {
  const rng = mulberry32(hashSeed(runSeed, 'gen'));
  const maxDepth = 3 + Math.floor(rng.next() * 3); // 3〜5階層（§11）
  const floors: Floor[] = [];
  for (let d = 1; d <= maxDepth; d++) {
    floors.push(generateFloor(character, d, maxDepth, rng));
  }
  return { character, runSeed, floors };
}
