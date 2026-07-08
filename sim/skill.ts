// スキル実験（開発者向け）: 「判断は生存を動かすか」を測る
// 実行: npm run sim:skill
//
// 3種のbotを比較する:
//   fight  — 目的地へ最短移動し、遭遇は常に挑む（スキルなしの基準線）
//   smart  — fight ＋ 危険ラベルで挑む/退くを選び、追跡者から逃げる（危険度を読むスキル）
//   reader — smart ＋ 古地図・メモを読む（罠の主張位置を避け、空腹時は泉の主張へ、宝の主張へ探索を寄せる）
//
// smart > fight なら「危険度ラベルは飾りではない」。
// reader > smart なら「地図を読むことが機構的に報われている」＝このゲームの主題が機能している。

import { SILENT_WELL } from '../src/core/character';
import { confidenceLabel } from '../src/core/confidence';
import { assessDanger } from '../src/core/danger';
import { featureAt, isWalkable, tileAt } from '../src/core/generate';
import { hashSeed, mulberry32, type RNG } from '../src/core/rng';
import {
  availableActions,
  currentFloor,
  newGame,
  step,
  type Action,
  type Dir,
  type GameState,
} from '../src/core/state';
import type { Vec } from '../src/core/types';

type Brain = 'fight' | 'smart' | 'reader';

const key = (p: Vec) => `${p.x},${p.y}`;
const DIRS: { dir: Dir; v: Vec }[] = [
  { dir: 'north', v: { x: 0, y: -1 } },
  { dir: 'south', v: { x: 0, y: 1 } },
  { dir: 'west', v: { x: -1, y: 0 } },
  { dir: 'east', v: { x: 1, y: 0 } },
];

function manhattan(a: Vec, b: Vec): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 信頼度ラベルの序列（botはラベルだけを読む。内部確率は読まない＝プレイヤーと同じ視界） */
const LABEL_RANK: Record<string, number> = {
  確か: 5,
  かなり信じられる: 4,
  ありそう: 3,
  怪しい: 2,
  噂程度: 1,
};

/**
 * この場所の箱/水について、手元の情報が主張する安全性。
 * 最も信頼度ラベルの高い情報に従う。情報がなければ null
 */
function betVerdict(state: GameState, pos: Vec): 'good' | 'bad' | null {
  const depth = state.instance.floors[state.floorIndex].depth;
  let verdict: 'good' | 'bad' | null = null;
  let bestRank = 0;
  for (const c of [...state.claims, ...state.senses]) {
    if (c.verified || c.floorDepth !== depth || !c.assertedSafety || !c.claimedPos) continue;
    if (c.kind !== 'chest' && c.kind !== 'spring') continue;
    if (manhattan(c.claimedPos, pos) > 1) continue;
    const rank = LABEL_RANK[confidenceLabel(c.internalP)] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      verdict = c.assertedSafety;
    }
  }
  return verdict;
}

/** プレイヤーの知識だけでBFSし、goalへ向かう最初の1歩を返す（未知の?マスは目標にはなるが通過はできない） */
function pathStep(
  state: GameState,
  goals: Set<string>,
  avoid: Set<string>,
): Dir | null {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const start = key(state.pos);
  if (goals.has(start)) return null;
  const prev = new Map<string, { from: string; dir: Dir }>();
  const seen = new Set<string>([start]);
  const queue: Vec[] = [state.pos];
  let goalKey: string | null = null;
  while (queue.length > 0 && !goalKey) {
    const cur = queue.shift()!;
    for (const { dir, v } of DIRS) {
      const n = { x: cur.x + v.x, y: cur.y + v.y };
      const k = key(n);
      if (seen.has(k) || !tileAt(floor, n)) continue;
      const isKnown = know.seen.has(k);
      // 既知なら歩行可能マスのみ。未知(?)は目標としてのみ許す
      if (isKnown && !isWalkable(floor, n)) continue;
      if (avoid.has(k) && !goals.has(k)) continue;
      // 見えている敵のいるマスは通らない（遭遇は自分で選ぶ）
      if (
        state.visibleNow.has(k) &&
        floor.entities.some((e) => e.alive && key(e.pos) === k)
      )
        continue;
      seen.add(k);
      prev.set(k, { from: key(cur), dir });
      if (goals.has(k)) {
        goalKey = k;
        break;
      }
      if (isKnown) queue.push(n); // 未知マスの先へは計画できない
    }
  }
  if (!goalKey) return null;
  let cur = goalKey;
  let dir: Dir = 'north';
  while (cur !== start) {
    const p = prev.get(cur)!;
    dir = p.dir;
    cur = p.from;
  }
  return dir;
}

/** 未知の境界(?)マス一覧 */
function frontierTiles(state: GameState): Vec[] {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const out: Vec[] = [];
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      const p = { x, y };
      if (know.seen.has(key(p))) continue;
      const adjSeen = DIRS.some(({ v }) => {
        const a = { x: x + v.x, y: y + v.y };
        return know.seen.has(key(a)) && tileAt(floor, a)?.kind === 'floor';
      });
      if (adjSeen) out.push(p);
    }
  }
  return out;
}

type RunResult = {
  survived: boolean;
  treasure: boolean;
  deepest: number;
  turns: number;
  combatDeath: boolean;
};

function run(seed: number, brain: Brain): RunResult {
  const state = newGame(SILENT_WELL, seed);
  const rng: RNG = mulberry32(hashSeed(seed, 'skillbot'));
  const blacklist = new Set<string>(); // readerが「行ってみたが無かった」主張
  const skippedBets = new Set<string>(); // 記録を信じて開けない/飲まないと決めた場所
  let consecutiveRetreats = 0;
  let resting = false; // 休息のヒステリシス（中途半端な体力で戦いに入らない）
  let guard = 0;

  while (state.phase !== 'dead' && state.phase !== 'escaped' && guard++ < 6000) {
    const actions = availableActions(state);
    if (actions.length === 0) break;
    const has = (t: Action['type']) => actions.find((a) => a.type === t);
    const floor = currentFloor(state);
    const know = state.knowledge[state.floorIndex];
    const p = state.player;
    const giveUp = state.turn > 250;

    // ---- 遭遇 ----
    if (state.phase === 'encounter') {
      if (brain === 'fight') {
        step(state, { type: 'engage' });
        continue;
      }
      // 危険度ラベルを読む: かなり危険/死の気配だけは避ける。それ以下は挑む
      // （逃げ続けても敵は消えない。消耗との天秤で「上位ラベルのみ回避」が上手いプレイ）
      const label = state.pending!.assessment.label;
      const tooRisky = label === 'かなり危険' || label === '死の気配';
      const cornered = consecutiveRetreats >= 3;
      if (!tooRisky || cornered) {
        step(state, { type: 'engage' });
        consecutiveRetreats = 0;
      } else {
        step(state, { type: 'retreat' });
        consecutiveRetreats++;
      }
      continue;
    }
    consecutiveRetreats = 0;

    // ---- 生活維持 ----
    if (p.hunger >= 75 && has('eat')) {
      step(state, { type: 'eat' });
      continue;
    }
    if (p.condition <= 30 && has('drinkPotion')) {
      step(state, { type: 'drinkPotion' });
      continue;
    }
    const visibleEnemies = floor.entities.filter(
      (e) => e.alive && state.visibleNow.has(key(e.pos)),
    );
    // 休息はまとめて取る: 消耗したら安全な場所で体調が戻るまで（中途半端な体力で戦わない）
    if (resting && (p.condition >= 80 || p.hunger >= 75 || visibleEnemies.length > 0)) {
      resting = false;
    }
    if (!resting && p.condition <= (brain === 'fight' ? 45 : 55) && p.hunger < 70 && visibleEnemies.length === 0) {
      resting = true;
    }
    if (resting && has('rest')) {
      step(state, { type: 'rest' });
      continue;
    }

    // ---- 賭け: 宝箱と泉（reader は記録と見立てを読んでから賭ける） ----
    const wantWater = p.hunger >= 45 || p.condition <= 65;
    if (has('open')) {
      if (brain !== 'reader') {
        step(state, { type: 'open' }); // 無情報の賭け
        continue;
      }
      const verdict = betVerdict(state, state.pos);
      if (verdict === 'good') {
        step(state, { type: 'open' });
        continue;
      }
      if (verdict === 'bad') {
        skippedBets.add(key(state.pos)); // 警告を信じて開けない
      } else if (has('inspect')) {
        step(state, { type: 'inspect' }); // まず調べる（気配帯の見立てを作る）
        continue;
      }
    }
    if (has('drink') && wantWater && !skippedBets.has(key(state.pos))) {
      if (brain !== 'reader') {
        step(state, { type: 'drink' });
        continue;
      }
      const verdict = betVerdict(state, state.pos);
      if (verdict === 'good') {
        step(state, { type: 'drink' });
        continue;
      }
      if (verdict === 'bad') {
        skippedBets.add(key(state.pos));
      } else if (has('inspect')) {
        step(state, { type: 'inspect' });
        continue;
      }
    }

    // ---- 階段・脱出 ----
    const here = featureAt(floor, state.pos);
    if (here?.kind === 'stairsUp' && floor.depth === 1 && (p.hasTreasure || giveUp) && has('escape')) {
      step(state, { type: 'escape' });
      continue;
    }
    if (here?.kind === 'stairsUp' && floor.depth > 1 && (p.hasTreasure || giveUp) && has('ascend')) {
      step(state, { type: 'ascend' });
      continue;
    }
    if (here?.kind === 'stairsDown' && !p.hasTreasure && !giveUp && has('descend')) {
      step(state, { type: 'descend' });
      continue;
    }

    // ---- 目的地の選定（優先順のリストにして、経路が通る最初のものを使う） ----
    const avoid = new Set<string>();

    if (brain !== 'fight') {
      // 危険な追跡者の周囲は通らない（先回りして逃げ回るのではなく、進路から外すだけ。
      // 逃げ回りは消耗が勝つ——距離は退却と階段で作る）
      for (const e of visibleEnemies) {
        if (!e.chasing) continue;
        const label = assessDanger(p, e, state.instance.character).label;
        if (label !== 'かなり危険' && label !== '死の気配') continue;
        avoid.add(key(e.pos));
        for (const { v } of DIRS) avoid.add(key({ x: e.pos.x + v.x, y: e.pos.y + v.y }));
      }
    }
    if (brain === 'reader') {
      // 罠の主張位置（未検証）は踏まない
      for (const c of state.claims) {
        if (c.floorDepth !== floor.depth || c.verified || c.kind !== 'trap' || !c.claimedPos) continue;
        avoid.add(key(c.claimedPos));
      }
    }

    const goalSets: Set<string>[] = [];
    const frontier = frontierTiles(state);

    if (p.hasTreasure || giveUp) {
      // 帰還: 上り階段へ
      const up = floor.features.find((f) => f.kind === 'stairsUp');
      if (up) goalSets.push(new Set([key(up.pos)]));
    } else {
      // 1. 目に入っている宝・下り階段・アイテム・箱・（必要なら）泉
      const seenGoals = new Set<string>();
      for (const f of floor.features) {
        if (!know.seen.has(key(f.pos))) continue;
        if (f.kind === 'treasure' && !f.taken) seenGoals.add(key(f.pos));
        if (f.kind === 'stairsDown') seenGoals.add(key(f.pos));
        if (f.kind === 'chest' && !f.opened && !skippedBets.has(key(f.pos))) seenGoals.add(key(f.pos));
        if (f.kind === 'spring' && wantWater && !skippedBets.has(key(f.pos))) seenGoals.add(key(f.pos));
      }
      for (const it of floor.items) {
        if (!it.taken && it.pos && know.seen.has(key(it.pos))) seenGoals.add(key(it.pos));
      }
      if (seenGoals.size > 0) goalSets.push(seenGoals);

      // 2. reader: 記録を信じて探索を寄せる。
      //    主張位置そのものは暗闇の先で経路が引けないことが多いので、
      //    「主張位置に最も近い未知の境界(?)」を目標にする＝地図が探索の向きを決める
      if (brain === 'reader') {
        const claimGoals = new Set<string>();
        for (const c of state.claims) {
          if (c.floorDepth !== floor.depth || c.verified || !c.claimedPos) continue;
          if (blacklist.has(c.id)) continue;
          if (know.seen.has(key(c.claimedPos))) {
            blacklist.add(c.id); // 見えたのに何もなかった/検証済みになった
            continue;
          }
          const wanted =
            c.kind === 'treasure' ||
            (c.kind === 'spring' && p.hunger >= 55 && c.assertedSafety !== 'bad') ||
            (c.kind === 'chest' && c.assertedSafety === 'good') ||
            c.kind === 'weapon';
          if (!wanted) continue;
          let best: Vec | null = null;
          let bestD = Infinity;
          for (const f of frontier) {
            const d = manhattan(f, c.claimedPos);
            if (d < bestD) {
              bestD = d;
              best = f;
            }
          }
          if (best) claimGoals.add(key(best));
        }
        if (claimGoals.size > 0) goalSets.push(claimGoals);
      }

      // 3. 未知の境界すべて
      if (frontier.length > 0) goalSets.push(new Set(frontier.map(key)));
    }
    // 4. 目標が尽きたら階段へ
    const stairsFallback = new Set<string>();
    for (const f of floor.features) {
      if (f.kind === 'stairsDown' || f.kind === 'stairsUp') stairsFallback.add(key(f.pos));
    }
    goalSets.push(stairsFallback);

    let dir: Dir | null = null;
    for (const goals of goalSets) {
      dir = pathStep(state, goals, avoid);
      if (dir) break;
    }
    if (!dir && avoid.size > 0) {
      // 回避で詰むなら諦めて通る
      for (const goals of goalSets) {
        dir = pathStep(state, goals, new Set());
        if (dir) break;
      }
    }
    if (dir) {
      step(state, { type: 'move', dir });
      continue;
    }

    // 完全に詰まった: ランダムに歩く
    const moves = actions.filter((a) => a.type === 'move');
    if (moves.length > 0) {
      step(state, moves[Math.floor(rng.next() * moves.length)]);
    } else {
      step(state, actions[0]);
    }
  }

  const lastDanger = state.telemetry.dangerEvents[state.telemetry.dangerEvents.length - 1];
  return {
    survived: state.phase === 'escaped',
    treasure: state.player.hasTreasure,
    deepest: state.deepestVisited,
    turns: state.turn,
    combatDeath: state.phase === 'dead' && lastDanger?.outcome === 'death',
  };
}

// ---- 実行 ----

const N = Number(process.argv[2] ?? 300);
console.log(`スキル実験（各${N}潜行・同一シード集合で比較）\n`);
console.log('brain   | 生還率 | 宝持ち帰り | 平均到達階 | 平均ターン | 戦闘死/死亡');
console.log('--------|--------|-----------|-----------|-----------|----------');
for (const brain of ['fight', 'smart', 'reader'] as Brain[]) {
  let survived = 0;
  let treasure = 0;
  let deepest = 0;
  let turns = 0;
  let combatDeaths = 0;
  let deaths = 0;
  for (let s = 0; s < N; s++) {
    const r = run(hashSeed('skill-exp', s), brain);
    if (r.survived) survived++;
    else deaths++;
    if (r.treasure) treasure++;
    deepest += r.deepest;
    turns += r.turns;
    if (r.combatDeath) combatDeaths++;
  }
  console.log(
    `${brain.padEnd(7)} | ${((survived / N) * 100).toFixed(1).padStart(5)}% | ${(
      (treasure / N) * 100
    )
      .toFixed(1)
      .padStart(8)}% | ${(deepest / N).toFixed(2).padStart(9)} | ${(turns / N)
      .toFixed(0)
      .padStart(9)} | ${combatDeaths}/${deaths}`,
  );
}
console.log(
  '\n読み方: smart>fight なら危険度ラベルが機能。reader>smart なら「地図を読むこと」が機構的に報われている。',
);
