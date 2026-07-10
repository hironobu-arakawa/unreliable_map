// 開発者向け検証スクリプト §12・§13
// 実行: npm run sim
// 1) 再現性: 同じ runSeed → 同一のインスタンス＋古地図
// 2) 整合性: held な情報は実地形と一致し、miss には理由が植わっている（憲法1・4）
// 3) 的中率: 信頼度ラベルごとの実的中率が §6.2 の帯に収まる
// 4) ループ: 自動プレイで 開始→脱出/死亡 まで回り、危険ラベルの実リスクが §7 の帯に近い

import { SILENT_WELL } from '../src/core/character';
import { confidenceLabel } from '../src/core/confidence';
import { enemyAt, featureAt, generateInstance, isConnected, itemAt } from '../src/core/generate';
import { applyHearsay } from '../src/core/hearsay';
import { mulberry32, hashSeed } from '../src/core/rng';
import {
  availableActions,
  newGame,
  step,
  type Action,
  type GameState,
} from '../src/core/state';
import { dangerRateByLabel, hitRateByLabel, type TelemetryLog } from '../src/core/telemetry';
import type { Claim, DungeonInstance } from '../src/core/types';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ---- 1) 再現性 ----

function snapshot(instance: DungeonInstance, claims: Claim[]): string {
  return JSON.stringify({ floors: instance.floors, claims });
}

{
  const a = generateInstance(SILENT_WELL, 12345);
  const ca = applyHearsay(a, 12345);
  const b = generateInstance(SILENT_WELL, 12345);
  const cb = applyHearsay(b, 12345);
  check('再現性: 同じrunSeedで同一の迷宮・同一の記録', snapshot(a, ca) === snapshot(b, cb));

  const c = generateInstance(SILENT_WELL, 54321);
  const cc = applyHearsay(c, 54321);
  check('多様性: 別runSeedでは別の迷宮', snapshot(a, ca) !== snapshot(c, cc));
}

// ---- 2) 世界と情報の整合性 ----

{
  let holdMismatch = 0;
  let driftBad = 0;
  let falseBad = 0;
  let disconnected = 0;
  const N = 300;
  for (let s = 0; s < N; s++) {
    const seed = hashSeed('consistency', s);
    const inst = generateInstance(SILENT_WELL, seed);
    const claims = applyHearsay(inst, seed);

    for (const floor of inst.floors) {
      // 崩落を植えても階段↔階段（↔宝箱）の到達性が保たれている
      const anchors = floor.features.filter(
        (f) => f.kind === 'stairsUp' || f.kind === 'stairsDown' || f.kind === 'chest',
      );
      for (let i = 0; i + 1 < anchors.length; i++) {
        if (!isConnected(floor, anchors[i].pos, anchors[i + 1].pos)) disconnected++;
      }
    }

    for (const c of claims) {
      // 相性の噂: 当たりなら真実と一致し、誤認なら一致しないはず
      if (c.kind === 'lore') {
        if (c.lorePattern && c.loreTargetKind) {
          const truth = inst.talismanLore[c.lorePattern];
          const asserted = c.assertedSafety === 'good' ? truth?.strongVs : truth?.backfireVs;
          const matches = asserted === c.loreTargetKind;
          if (c.held !== matches) holdMismatch++;
        }
        continue;
      }
      const floor = inst.floors[c.floorDepth - 1];
      if (c.held && c.actualPos) {
        // 当たりの情報は、実態にそのまま一致するはず（安全性の主張まで含めて）
        const f = featureAt(floor, c.actualPos);
        const ok =
          (c.kind === 'spring' &&
            f?.kind === 'spring' &&
            (c.assertedSafety === 'bad') === f.badWater) ||
          (c.kind === 'chest' &&
            f?.kind === 'chest' &&
            (c.assertedSafety === 'good') ===
              ['weapon', 'potion', 'food'].includes(f.chestContent ?? '')) ||
          (c.kind === 'trap' && f?.kind === 'trap' && !f?.triggered) ||
          (c.kind === 'treasure' &&
            ((f?.kind === 'chest' && f.chestContent === 'treasure') ||
              floor.entities.some((e) => e.boss && e.alive && e.pos.x === c.actualPos!.x && e.pos.y === c.actualPos!.y))) ||
          (c.kind === 'enemy' && enemyAt(floor, c.actualPos) !== undefined) ||
          (c.kind === 'weapon' && itemAt(floor, c.actualPos)?.kind === 'weapon' && !itemAt(floor, c.actualPos)?.broken) ||
          (c.kind === 'passage' && f === undefined);
        if (!ok) holdMismatch++;
      }
      if (!c.held && c.missPattern === 'drift') {
        if (!c.actualPos || (c.actualPos.x === c.claimedPos!.x && c.actualPos.y === c.claimedPos!.y)) driftBad++;
      }
      if (!c.held && c.missPattern === 'false' && c.claimedPos) {
        // 完全な誤情報の位置には、主張された種類のものは無いはず
        const f = featureAt(floor, c.claimedPos);
        const e = enemyAt(floor, c.claimedPos);
        const bad =
          (c.kind === 'spring' && f?.kind === 'spring') ||
          (c.kind === 'chest' && f?.kind === 'chest') ||
          (c.kind === 'enemy' && e !== undefined) ||
          (c.kind === 'trap' && f?.kind === 'trap');
        if (bad) falseBad++;
      }
    }
  }
  check('整合性: 当たり情報は実地形と一致（憲法1）', holdMismatch === 0, `不一致 ${holdMismatch}件 / ${N}シード`);
  check('整合性: 位置ズレは実際にズレている', driftBad === 0, `${driftBad}件`);
  check('整合性: 誤情報の場所に実物がない', falseBad === 0, `${falseBad}件`);
  check('整合性: 崩落後も階段・宝への到達性が保たれる', disconnected === 0, `${disconnected}件`);
}

// ---- 3) 信頼度ラベルの的中率が帯に収まるか（§6.2） ----

{
  const bands: Record<string, [number, number]> = {
    確か: [0.95, 1.0],
    かなり信じられる: [0.8, 0.95],
    ありそう: [0.6, 0.8],
    怪しい: [0.4, 0.6],
    噂程度: [0.2, 0.4],
  };
  const acc: Record<string, { n: number; hit: number }> = {};
  const N = 2000;
  for (let s = 0; s < N; s++) {
    const seed = hashSeed('hitrate', s);
    const inst = generateInstance(SILENT_WELL, seed);
    const claims = applyHearsay(inst, seed);
    for (const c of claims) {
      const label = confidenceLabel(c.internalP);
      const a = (acc[label] ??= { n: 0, hit: 0 });
      a.n++;
      if (c.held) a.hit++;
    }
  }
  console.log('\n  ラベル別の実的中率（古地図・メモ、生成時解決）:');
  for (const [label, { n, hit }] of Object.entries(acc)) {
    const rate = hit / n;
    const [lo, hi] = bands[label] ?? [0, 1];
    const tolerance = 0.05;
    const ok = rate >= lo - tolerance && rate <= hi + tolerance;
    console.log(`    ${label}: ${(rate * 100).toFixed(1)}% (n=${n}) 期待帯 ${lo}-${hi}`);
    check(`的中率: 「${label}」が帯内`, ok, `${(rate * 100).toFixed(1)}%`);
  }
}

// ---- 4) 自動プレイ: ループ完走と危険ラベルの実リスク（§7・受け入れ条件1） ----

type BotResult = { result: string; turns: number; telemetry: TelemetryLog };

function autoplay(seed: number): BotResult {
  const state: GameState = newGame(SILENT_WELL, seed);
  const bot = mulberry32(hashSeed(seed, 'bot'));
  let guard = 0;
  while (state.phase !== 'dead' && state.phase !== 'escaped' && guard < 4000) {
    guard++;
    const actions = availableActions(state);
    if (actions.length === 0) break;
    let chosen: Action | undefined;

    if (state.phase === 'encounter') {
      // ときどき投げ、あとはランダム寄りに挑む（ラベル別の実リスク計測のため）
      const throwable = actions.filter(
        (a) => a.type === 'throwStone' || a.type === 'throwTalisman',
      );
      if (throwable.length > 0 && bot.next() < 0.3) {
        chosen = throwable[Math.floor(bot.next() * throwable.length)];
      } else {
        chosen = bot.next() < 0.6 ? { type: 'engage' } : { type: 'retreat' };
      }
    } else {
      const p = state.player;
      const here = actions;
      const has = (t: Action['type']) => here.find((a) => a.type === t);
      const potionActs = here.filter(
        (a): a is Extract<Action, { type: 'drinkPotion' }> => a.type === 'drinkPotion',
      );
      // 回復系（傷薬・霊薬・濁り薬）を優先して飲む
      const healPotion =
        potionActs.find((a) => a.kind === 'salve' || a.kind === 'elixir' || a.kind === 'murk') ??
        potionActs[0];
      if (p.hunger >= 70 && has('eat')) chosen = { type: 'eat' };
      else if (p.condition <= 35 && healPotion) chosen = healPotion;
      else if (has('open') && bot.next() < 0.75) chosen = { type: 'open' };
      else if (has('drink') && (p.hunger > 40 || p.condition < 80) && bot.next() < 0.6)
        chosen = { type: 'drink' };
      else if (has('inspect') && bot.next() < 0.1) chosen = { type: 'inspect' };
      else if (p.condition <= 45 && bot.next() < 0.5 && has('rest')) chosen = { type: 'rest' };
      else if (p.hasTreasure && has('escape')) chosen = { type: 'escape' };
      else if (p.hasTreasure && has('ascend')) chosen = { type: 'ascend' };
      else if (!p.hasTreasure && has('descend') && bot.next() < 0.8) chosen = { type: 'descend' };
      else if (state.turn > 120 && has('escape')) chosen = { type: 'escape' };
      else if (state.turn > 120 && has('ascend') && bot.next() < 0.6) chosen = { type: 'ascend' };
      else if (bot.next() < 0.08 && has('listen')) chosen = { type: 'listen' };
      if (!chosen) {
        const moves = here.filter((a) => a.type === 'move') as Extract<Action, { type: 'move' }>[];
        // 未踏のマスを優先して彷徨いを減らす
        const know = state.knowledge[state.floorIndex];
        const dirVec: Record<string, { x: number; y: number }> = {
          north: { x: 0, y: -1 },
          south: { x: 0, y: 1 },
          west: { x: -1, y: 0 },
          east: { x: 1, y: 0 },
        };
        const fresh = moves.filter((m) => {
          const v = dirVec[m.dir];
          return !know.walked.has(`${state.pos.x + v.x},${state.pos.y + v.y}`);
        });
        const pool = fresh.length > 0 && bot.next() < 0.75 ? fresh : moves;
        chosen = pool.length > 0 ? pool[Math.floor(bot.next() * pool.length)] : here[0];
      }
    }
    step(state, chosen);
  }
  return {
    result: state.phase,
    turns: state.turn,
    telemetry: state.telemetry,
  };
}

{
  const N = 400;
  const logs: TelemetryLog[] = [];
  let finished = 0;
  let escapes = 0;
  let deaths = 0;
  for (let s = 0; s < N; s++) {
    const r = autoplay(hashSeed('bot-run', s));
    logs.push(r.telemetry);
    if (r.result === 'dead' || r.result === 'escaped') finished++;
    if (r.result === 'escaped') escapes++;
    if (r.result === 'dead') deaths++;
  }
  check(
    'ループ: 自動プレイが開始→脱出/死亡まで完走する',
    finished === N,
    `${finished}/${N}（生還${escapes}・死亡${deaths}）`,
  );

  const dangerBands: Record<string, [number, number]> = {
    なんとかなりそう: [0, 0.1],
    油断はできない: [0.1, 0.25],
    危険: [0.25, 0.45],
    かなり危険: [0.45, 0.7],
    死の気配: [0.7, 1.0],
  };
  const danger = dangerRateByLabel(logs);
  console.log('\n  危険ラベル別の実際の死亡・重傷率（挑んだ場合）:');
  for (const [label, d] of Object.entries(danger)) {
    const [lo, hi] = dangerBands[label] ?? [0, 1];
    console.log(`    ${label}: ${(d.rate * 100).toFixed(1)}% (n=${d.engaged}) 期待帯 ${lo}-${hi}`);
    if (d.engaged >= 30) {
      const tolerance = 0.08;
      check(`危険度: 「${label}」が帯内`, d.rate >= lo - tolerance && d.rate <= hi + tolerance);
    }
  }

  const info = hitRateByLabel(logs);
  console.log('\n  プレイ中に検証された情報のラベル別的中率:');
  for (const [label, d] of Object.entries(info)) {
    console.log(`    ${label}: ${(d.rate * 100).toFixed(1)}% (n=${d.n})`);
  }
}

console.log(failures === 0 ? '\nすべての検証を通過' : `\n${failures}件の検証に失敗`);
process.exit(failures === 0 ? 0 : 1);
