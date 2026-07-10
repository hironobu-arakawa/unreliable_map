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
  TalismanEffect,
  TalismanLore,
  Tile,
  TreasureMode,
  Vec,
} from './types';
import { ENEMY_NAMES, POTION_DROP, POTION_NAMES } from './character';
import { GEM_DATA, rollGemKind } from './economy';
import type { RNG } from './rng';
import { hashSeed, mulberry32, pick, pickWeighted, randInt, shuffle } from './rng';

export const FLOOR_W = 21;
export const FLOOR_H = 13;

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
  // dormant（宝箱に潜むミミック）は開けられるまで存在しないものとして扱う
  return floor.entities.find(
    (e) => e.alive && !e.dormant && e.pos.x === p.x && e.pos.y === p.y,
  );
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

/** 札の模様の候補。模様から効果は察知できない（対応はランごとにシャッフル） */
export const TALISMAN_PATTERNS = ['渦', '三ツ目', '鱗紋', '月牙', '雷紋', '枯枝'] as const;

/** 札の効き方の系統。ランごとに模様へ割り当てられる */
export const TALISMAN_EFFECTS: readonly TalismanEffect[] = ['burn', 'slow', 'sleep', 'haste'];

/**
 * 敵を1体作る（初期配置と、大地の編み直しによる再湧きの両方で使う）。
 * v0.9: 持ち物は7割——手ぶらの敵を倒しても得るものはない。
 * 「奴は何かを運んでいる」という記録・気配が、狩る相手を選ぶ理由になる
 */
export function makeEnemy(
  character: DungeonCharacter,
  depth: number,
  maxDepth: number,
  rng: RNG,
  pos: Vec,
  id: string,
): Entity {
  const b = character.biases;
  const depthFrac = maxDepth > 1 ? (depth - 1) / (maxDepth - 1) : 0;
  const kind: EnemyKind =
    rng.next() < b.metallicEnemyRate ? 'metallic' : pick(rng, ['beast', 'shade'] as const);
  // 深いほど強い。宝の眠る最深階の敵は、生半可な支度では死の気配になる
  const strength = Math.min(
    0.95,
    Math.max(0.1, 0.22 + depthFrac * 0.58 + (b.enemyLethality - 0.5) * 0.3 + (rng.next() - 0.5) * 0.16),
  );
  // 深い階の敵は光るものを呑んでいることがある（挑む動機の上積み）
  const gemCarryP = 0.05 + depthFrac * 0.12;
  const carry =
    rng.next() < 0.3
      ? ('none' as const)
      : rng.next() < gemCarryP
        ? ('gem' as const)
        : kind === 'metallic'
          ? rng.next() < b.rewardWeaponBias
            ? ('weapon' as const)
            : ('potion' as const)
          : kind === 'beast'
            ? ('food' as const)
            : ('potion' as const);
  return {
    id,
    kind,
    name: pick(rng, ENEMY_NAMES[kind]),
    pos,
    strength,
    alive: true,
    moveEvery: kind === 'metallic' ? 2 : 1,
    chasing: false,
    lastSeen: null,
    lostTurns: 0,
    carry,
  };
}

function generateFloor(
  character: DungeonCharacter,
  depth: number,
  maxDepth: number,
  rng: RNG,
  treasureMode: TreasureMode,
  runPatterns: string[],
): Floor {
  const grid: Tile[][] = [];
  for (let y = 0; y < FLOOR_H; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < FLOOR_W; x++) row.push({ kind: 'wall' });
    grid.push(row);
  }

  // 部屋を4〜5彫り、順に通路でつなぐ（必ず連結になる）
  const rooms: Room[] = [];
  const roomCount = randInt(rng, 4, 5);
  for (let i = 0; i < roomCount; i++) {
    const w = randInt(rng, 3, 6);
    const h = randInt(rng, 2, 4);
    const x = randInt(rng, 1, FLOOR_W - 1 - w);
    const y = randInt(rng, 1, FLOOR_H - 1 - h);
    rooms.push({ x, y, w, h });
  }
  for (const r of rooms) carveRoom(grid, r);
  for (let i = 0; i + 1 < rooms.length; i++) {
    carveCorridor(grid, roomCenter(rooms[i]), roomCenter(rooms[i + 1]), rng);
  }
  // 余剰の通路を1本足して回り道を作る（角を曲がって敵の視線を切る余地になる）
  carveCorridor(grid, roomCenter(rooms[0]), roomCenter(rooms[rooms.length - 1]), rng);

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
  } else if (treasureMode === 'chest') {
    // 箱型: 最深階の箱のどれかに宝が眠る（どの箱かは開けるまで分からない）
    const tPos = takeFreeCell(floor, cells, used)!;
    floor.features.push({
      id: `f${depth}-treasure-chest`,
      kind: 'chest',
      pos: tPos,
      chestContent: 'treasure',
    });
  } else {
    // ボス型: 深部の主が宝を抱いている
    const bPos = takeFreeCell(floor, cells, used)!;
    const kind: EnemyKind = rng.next() < character.biases.metallicEnemyRate ? 'metallic' : 'beast';
    floor.entities.push({
      id: `e${depth}-boss`,
      kind,
      name: '深部の主',
      pos: bPos,
      strength: Math.min(0.95, 0.72 + rng.next() * 0.15 + (character.biases.enemyLethality - 0.5) * 0.2),
      alive: true,
      moveEvery: 2, // 強大だが重い——走れば距離は作れる
      chasing: false,
      lastSeen: null,
      lostTurns: 0,
      carry: 'treasure',
      boss: true,
    });
  }

  const upperness = maxDepth > 1 ? 1 - (depth - 1) / (maxDepth - 1) : 1;

  // 泉: 見た目では飲めるか分からない。「上層の毒」の性格は水の悪さに現れる
  const badWaterP = 0.2 + upperness * b.upperTrapRate * 0.45;
  if (rng.next() < 0.75) {
    const p = takeFreeCell(floor, cells, used);
    if (p)
      floor.features.push({
        id: `f${depth}-spring`,
        kind: 'spring',
        pos: p,
        badWater: rng.next() < badWaterP,
      });
    if (rng.next() < 0.3) {
      const q = takeFreeCell(floor, cells, used);
      if (q)
        floor.features.push({
          id: `f${depth}-spring2`,
          kind: 'spring',
          pos: q,
          badWater: rng.next() < badWaterP,
        });
    }
  }

  // 宝箱: 開けるまで中身は分からない（当たり/毒針/ミミック/空。§「検証行為そのものがリスク」）
  const chestCount = rng.next() < 0.75 ? (rng.next() < 0.25 ? 2 : 1) : 0;
  for (let i = 0; i < chestCount; i++) {
    const p = takeFreeCell(floor, cells, used);
    if (!p) break;
    const content = pickWeighted(rng, [
      ['weapon', 0.12 * (0.5 + b.rewardWeaponBias)],
      ['armor', 0.07 * (0.5 + b.rewardWeaponBias)],
      ['potion', 0.15],
      ['food', 0.15],
      ['talisman', 0.13],
      ['gem', 0.04 + (1 - upperness) * 0.08], // 深い箱ほど石が眠る
      ['needle', 0.15 * (0.5 + upperness * b.upperTrapRate)],
      ['mimic', 0.08 * (0.5 + b.metallicEnemyRate)],
      ['empty', 0.1],
    ] as const);
    floor.features.push({ id: `f${depth}-chest${i}`, kind: 'chest', pos: p, chestContent: content });
    if (content === 'mimic') {
      // 箱に潜むもの: 開けられるまで動かず、見えず、遭遇しない
      floor.entities.push({
        id: `e${depth}-mimic${i}`,
        kind: 'metallic',
        name: '箱に潜んでいたもの',
        pos: p,
        strength: Math.min(0.9, 0.35 + upperness * 0 + (depth - 1) * 0.12 + rng.next() * 0.15),
        alive: true,
        moveEvery: 1,
        chasing: false,
        lastSeen: null,
        lostTurns: 0,
        carry: pickWeighted(rng, [
          ['potion', 0.5],
          ['food', 0.5],
        ] as const),
        dormant: true,
      });
    }
  }

  // 毒罠: 数は控えめに（踏むかどうかは選択ではなく運。判断の主役は箱と水に移した）
  const trapCount = Math.round(b.upperTrapRate * (0.3 + upperness * 1.0) + rng.next() * 0.4);
  for (let i = 0; i < trapCount; i++) {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.features.push({ id: `f${depth}-trap${i}`, kind: 'trap', pos: p });
  }

  // 敵: 密度は低め・一体ごとの危険度は高め（性格）。金属系は重く遅い＝走れば振り切れる
  const enemyCount = Math.max(1, Math.round(b.enemyDensity * 6 + rng.next() * 0.9));
  for (let i = 0; i < enemyCount; i++) {
    const p = takeFreeCell(floor, cells, used);
    if (!p) break;
    floor.entities.push(makeEnemy(character, depth, maxDepth, rng, p, `e${depth}-${i}`));
  }

  // アイテム: 糧食は各階確実＋ときどき2つ（マップ拡大に合わせた消耗予算）、薬はときどき、武器は中層に性格次第で
  {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.items.push({ id: `i${depth}-food`, kind: 'food', name: '乾いた糧食', pos: p, taken: false });
    if (rng.next() < 0.45) {
      const q = takeFreeCell(floor, cells, used);
      if (q) floor.items.push({ id: `i${depth}-food2`, kind: 'food', name: '乾いた糧食', pos: q, taken: false });
    }
  }
  // 石: 各階に1〜2個。安全だが弱い投擲の弾
  {
    const stoneCount = randInt(rng, 1, 2);
    for (let i = 0; i < stoneCount; i++) {
      const p = takeFreeCell(floor, cells, used);
      if (p) floor.items.push({ id: `i${depth}-stone${i}`, kind: 'stone', name: '手頃な石', pos: p, taken: false });
    }
  }
  // 札: ときどき落ちている。模様はランに出る2種のどちらか
  if (rng.next() < 0.6) {
    const p = takeFreeCell(floor, cells, used);
    if (p) {
      const pattern = pick(rng, runPatterns);
      floor.items.push({
        id: `i${depth}-talisman`,
        kind: 'talisman',
        name: `${pattern}の札`,
        pos: p,
        taken: false,
        pattern,
      });
    }
  }
  if (rng.next() < 0.5) {
    const p = takeFreeCell(floor, cells, used);
    if (p) {
      const potionKind = pickWeighted(rng, POTION_DROP);
      floor.items.push({
        id: `i${depth}-potion`,
        kind: 'potion',
        name: `${POTION_NAMES[potionKind]}の瓶`,
        pos: p,
        taken: false,
        potionKind,
      });
    }
  }
  const midDepth = Math.ceil(maxDepth / 2);
  if (depth === midDepth && rng.next() < b.rewardWeaponBias) {
    const p = takeFreeCell(floor, cells, used);
    if (p) floor.items.push({ id: `i${depth}-weapon`, kind: 'weapon', name: '古びた剣', pos: p, taken: false });
  }
  // 打ち捨てられた鎧: 深い階にときどき転がっている（先に潜った誰かの、脱ぎ捨てた形見だ）
  if (depth >= 2 && rng.next() < 0.12) {
    const p = takeFreeCell(floor, cells, used);
    if (p) {
      floor.items.push({
        id: `i${depth}-armor`,
        kind: 'armor',
        name: '打ち捨てられた鎧',
        pos: p,
        taken: false,
      });
    }
  }
  // 宝石: 深い階の土にときどき埋もれている
  {
    const depthFrac = maxDepth > 1 ? (depth - 1) / (maxDepth - 1) : 0;
    if (depth >= 2 && rng.next() < 0.06 + depthFrac * 0.12) {
      const p = takeFreeCell(floor, cells, used);
      if (p) {
        const gemKind = rollGemKind(rng, depthFrac);
        floor.items.push({
          id: `i${depth}-gem`,
          kind: 'gem',
          name: GEM_DATA[gemKind].name,
          pos: p,
          taken: false,
          gemKind,
        });
      }
    }
  }

  return floor;
}

/**
 * 性格＋runSeed → 具体インスタンス。
 * 同じ runSeed なら常に同一の迷宮になる（§4.2 再現性）。
 */
export function generateInstance(character: DungeonCharacter, runSeed: number): DungeonInstance {
  const rng = mulberry32(hashSeed(runSeed, 'gen'));
  // 4〜6階層。浅い迷宮を引き当てる運だけで装備が揃わないよう、最低階層は深め（v0.8）
  const maxDepth = 4 + Math.floor(rng.next() * 3);

  // 宝の出所: 箱の中か、主が抱いているか（ランごとにシードで決まる）
  const treasureMode: TreasureMode = rng.next() < 0.5 ? 'chest' : 'boss';

  // 札の模様→系統・相性の対応をシャッフル（模様から効果は察知できない）
  const kinds: EnemyKind[] = shuffle(rng, ['metallic', 'beast', 'shade'] as const);
  const runPatterns = shuffle(rng, TALISMAN_PATTERNS).slice(0, 3);
  const runEffects = shuffle(rng, TALISMAN_EFFECTS);
  const talismanLore: TalismanLore = {};
  for (let i = 0; i < runPatterns.length; i++) {
    // 効く相手と逆効く相手は必ず別の種族。系統もランごとに編み直される
    talismanLore[runPatterns[i]] = {
      effect: runEffects[i % runEffects.length],
      strongVs: kinds[i % kinds.length],
      backfireVs: kinds[(i + 1 + Math.floor(rng.next() * 2)) % kinds.length],
    };
    if (talismanLore[runPatterns[i]].backfireVs === talismanLore[runPatterns[i]].strongVs) {
      talismanLore[runPatterns[i]].backfireVs = kinds[(i + 1) % kinds.length];
    }
  }

  const floors: Floor[] = [];
  for (let d = 1; d <= maxDepth; d++) {
    floors.push(generateFloor(character, d, maxDepth, rng, treasureMode, runPatterns));
  }
  return { character, runSeed, floors, treasureMode, talismanLore };
}
