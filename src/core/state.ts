// ゲーム状態・ターンループの遷移 §10・§11
// core はUIもDOMも一切触らない。副作用は注入されたPRNGのみ（§4.1）。

import type {
  Claim,
  DungeonInstance,
  Entity,
  Floor,
  PlayerState,
  Vec,
} from './types';
import type { DungeonCharacter } from './types';
import { confidenceLabel, drawInternalP, SOURCE_NAMES } from './confidence';
import { assessDanger, type DangerAssessment } from './danger';
import { enemyAt, featureAt, generateInstance, itemAt, tileAt } from './generate';
import { applyHearsay } from './hearsay';
import { resolveInfo } from './resolve';
import type { RNG } from './rng';
import { hashSeed, mulberry32, pick } from './rng';
import {
  createTelemetry,
  recordChoice,
  recordDanger,
  recordInfo,
  recordSummary,
  type TelemetryLog,
} from './telemetry';

// ---- 方向 ----

export type Dir = 'north' | 'south' | 'west' | 'east';
export const DIR_VEC: Record<Dir, Vec> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
  east: { x: 1, y: 0 },
};
export const DIR_WORD: Record<Dir, string> = {
  north: '北',
  south: '南',
  west: '西',
  east: '東',
};

/** 8方位の言葉（気配の方向表現） */
function dirWord8(from: Vec, to: Vec): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ns = dy < 0 ? '北' : dy > 0 ? '南' : '';
  const we = dx < 0 ? '西' : dx > 0 ? '東' : '';
  return ns + we || 'すぐ近く';
}

// ---- 状態の言葉（数字は出さない §11） ----

export function conditionWord(c: number): string {
  if (c >= 85) return '体調はほぼ万全だ';
  if (c >= 60) return '軽い傷を負っている';
  if (c >= 35) return '傷が痛む';
  if (c >= 15) return '重傷だ';
  return '瀕死だ';
}

export function hungerWord(h: number): string {
  if (h < 25) return '腹は満ちている';
  if (h < 55) return '少し腹が減った';
  if (h < 80) return '空腹ぎみだ';
  if (h < 100) return '空腹で力が入らない';
  return '飢えている';
}

export function armorWord(w: number): string {
  if (w < 40) return '革鎧はまだ保つ';
  if (w < 70) return '革鎧は傷んでいる';
  return '革鎧はぼろぼろだ';
}

export function torchWord(t: number): string {
  if (t > 60) return '松明は明るい';
  if (t > 30) return '松明は揺らいでいる';
  if (t > 0) return '松明は残り少ない';
  return '松明は燃え尽きた';
}

// ---- ゲーム状態 ----

export type Knowledge = {
  walked: Set<string>;
  seen: Set<string>;
};

export type GamePhase = 'explore' | 'encounter' | 'dead' | 'escaped';

export type PendingEncounter = {
  enemyId: string;
  assessment: DangerAssessment;
  /** 判断材料スナップショット（死亡ログ用 §10） */
  materials: string[];
};

export type GameState = {
  instance: DungeonInstance;
  claims: Claim[];
  player: PlayerState;
  floorIndex: number; // 0-based
  pos: Vec;
  knowledge: Knowledge[];
  turn: number;
  phase: GamePhase;
  pending: PendingEncounter | null;
  /** 直近の行動結果（行動後の結果と事前情報の対応 §10） */
  events: string[];
  /** 耳を澄ますで得た未検証の気配情報 */
  senses: Claim[];
  deathLog: string[] | null;
  escapeLog: string[] | null;
  telemetry: TelemetryLog;
  rng: RNG; // プレイ時の判定用（runSeed由来。同じ行動列なら同じ結果）
  deepestVisited: number;
  senseSeq: number;
};

export type Action =
  | { type: 'move'; dir: Dir }
  | { type: 'listen' }
  | { type: 'rest' }
  | { type: 'descend' }
  | { type: 'ascend' }
  | { type: 'escape' }
  | { type: 'drinkPotion' }
  | { type: 'eat' }
  | { type: 'engage' }
  | { type: 'retreat' };

const key = (p: Vec) => `${p.x},${p.y}`;

export function currentFloor(state: GameState): Floor {
  return state.instance.floors[state.floorIndex];
}

// ---- 生成 ----

export function newGame(character: DungeonCharacter, runSeed: number): GameState {
  // 生成パイプライン: 地形 → 古地図・噂の解決（地形の最終化を含む）。以後、地形は不変
  const instance = generateInstance(character, runSeed);
  const claims = applyHearsay(instance, runSeed);

  const entry = instance.floors[0].features.find((f) => f.kind === 'stairsUp')!;
  const state: GameState = {
    instance,
    claims,
    player: {
      condition: 100,
      hunger: 10,
      armorWear: 10,
      torch: 100,
      poisonTurns: 0,
      hasWeapon: false,
      hasTreasure: false,
      potions: 1,
      food: 1,
      ownLog: [],
    },
    floorIndex: 0,
    pos: { ...entry.pos },
    knowledge: instance.floors.map(() => ({ walked: new Set(), seen: new Set() })),
    turn: 0,
    phase: 'explore',
    pending: null,
    events: [],
    senses: [],
    deathLog: null,
    escapeLog: null,
    telemetry: createTelemetry(runSeed, character.id),
    rng: mulberry32(hashSeed(runSeed, 'play')),
    deepestVisited: 1,
    senseSeq: 0,
  };

  state.knowledge[0].walked.add(key(state.pos));
  const events: string[] = [
    `あなたは「${character.name}」の入口に立っている。`,
    ...character.traitRumors.map((r) => `${r}（噂：${confidenceLabel(0.35)}）`),
  ];
  look(state, events);
  state.events = events;
  return state;
}

// ---- 視界（憲法2: 視界は嘘をつかない） ----

/** 直線の視線が通るか（間のマスがすべて床であること） */
function lineOfSight(floor: Floor, from: Vec, to: Vec): boolean {
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let err = dx - dy;
  while (x !== to.x || y !== to.y) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    if (x === to.x && y === to.y) break;
    const t = tileAt(floor, { x, y });
    if (!t || t.kind !== 'floor') return false; // 壁の向こうは見えない
  }
  return true;
}

/** 現在地から見えるマスを知識に追加し、新たに見えたものについて情報の当否を検証する */
function look(state: GameState, events: string[]): void {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const radius = state.player.torch > 0 ? 2 : 1;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const p = { x: state.pos.x + dx, y: state.pos.y + dy };
      if (!tileAt(floor, p)) continue;
      if (know.seen.has(key(p))) continue;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 1 && !lineOfSight(floor, state.pos, p)) continue;
      know.seen.add(key(p));
    }
  }
  verifyClaims(state, events);
}

// ---- 情報の検証（行動後の対応表示 §10 ＋ 計測 §12） ----

function sourceName(c: Claim): string {
  return SOURCE_NAMES[c.source];
}

/** 検証時の対応文（なぜ外れたかが必ず言葉で残る。憲法4） */
function correspondenceText(c: Claim): string {
  const src = sourceName(c);
  const label = confidenceLabel(c.internalP);
  if (c.held) {
    const what: Record<string, string> = {
      spring: '泉は確かにあった',
      enemy: '何かが棲んでいるのは本当だった',
      trap: '毒の仕掛けは実在した',
      treasure: '宝の在り処は正しかった',
      passage: '道は今も通じていた',
      weapon: '得物は残されていた',
    };
    return `（${src}・${label}：当たり——${what[c.kind]}）`;
  }
  switch (c.missPattern) {
    case 'drift':
      return `（${src}・${label}：位置が少しズレていた）`;
    case 'condition':
      return c.kind === 'spring'
        ? `（${src}・${label}：泉はあった。だが涸れていた——内容は合うが条件が違う）`
        : `（${src}・${label}：得物はあった。だが朽ちていた——内容は合うが条件が違う）`;
    case 'stale':
      return c.kind === 'passage'
        ? `（${src}・${label}：その記録は古い——道は崩れていた）`
        : `（${src}・${label}：その記録は古い——仕掛けはとうに朽ちていた）`;
    case 'misread':
      return `（${src}・${label}：誰かの誤認だ——音の主は罠だった）`;
    case 'false':
      return `（${src}・${label}：そこには何もなかった）`;
    default:
      return `（${src}・${label}：外れ）`;
  }
}

/** 主張位置（または実位置）が視界に入ったら、その情報の当否を提示・計測する */
function verifyClaims(state: GameState, events: string[]): void {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const pool = [...state.claims, ...state.senses];
  for (const c of pool) {
    if (c.verified || c.floorDepth !== floor.depth) continue;
    const claimedSeen = c.claimedPos !== null && know.seen.has(key(c.claimedPos));
    const actualSeen = c.actualPos !== null && know.seen.has(key(c.actualPos));
    // held/条件違い/古い情報は実位置が見えた時点で判明。
    // 位置ズレは両方見えて初めて「ズレていた」と分かる。誤情報は主張位置を見て「何もない」と分かる
    let ready = false;
    if (c.held) ready = actualSeen;
    else if (c.missPattern === 'drift') ready = claimedSeen && actualSeen;
    else if (c.missPattern === 'false') ready = claimedSeen;
    else ready = actualSeen;
    if (!ready) continue;

    c.verified = true;
    events.push(correspondenceText(c));
    recordInfo(state.telemetry, {
      turn: state.turn,
      source: c.source,
      label: confidenceLabel(c.internalP),
      internal_p: c.internalP,
      predicted: `${c.kind}@B${c.floorDepth}`,
      actual: c.actualKind,
      held: c.held,
      miss_pattern: c.missPattern,
    });
  }
}

// ---- 判断材料（行動前の提示 §10） ----

/** いま画面に出ている判断材料を言葉で列挙する（死亡ログにも使う） */
export function currentMaterials(state: GameState): string[] {
  const out: string[] = [];
  const p = state.player;
  out.push(conditionWord(p.condition));
  out.push(hungerWord(p.hunger));
  out.push(armorWord(p.armorWear));
  out.push(torchWord(p.torch));
  if (p.poisonTurns > 0) out.push('毒が回っている');
  const depth = currentFloor(state).depth;
  for (const c of state.claims) {
    if (c.floorDepth === depth && !c.verified) {
      out.push(`${c.text}（${sourceName(c)}：${confidenceLabel(c.internalP)}）`);
    }
  }
  for (const s of state.senses) {
    if (s.floorDepth === depth && !s.verified) {
      out.push(`${s.text}（気配：${confidenceLabel(s.internalP)}）`);
    }
  }
  return out;
}

// ---- ターン共通処理 ----

function advanceTurn(state: GameState, events: string[], hungerCost: number, torchCost: number): void {
  state.turn++;
  const p = state.player;
  p.hunger = Math.min(120, p.hunger + hungerCost);
  p.torch = Math.max(0, p.torch - torchCost);
  if (p.poisonTurns > 0) {
    p.poisonTurns--;
    p.condition -= 3;
    events.push('毒が体を蝕んでいる。');
  }
  if (p.hunger >= 100) {
    p.condition -= 4;
    events.push('飢えが体力を奪っていく。');
  }
  if (p.condition <= 0) {
    die(state, events, '力尽きた。毒と飢えと暗闇が、静かに追いついてきたのだ。');
  }
}

// ---- 死亡・脱出 ----

function die(state: GameState, events: string[], causeLine: string): void {
  if (state.phase === 'dead') return;
  state.phase = 'dead';
  const materials = state.pending?.materials ?? currentMaterials(state);
  state.deathLog = [
    '死亡記録：',
    causeLine,
    `${state.instance.character.name} B${currentFloor(state).depth}F・潜行はここで途絶えた。`,
    '',
    '直前の判断材料：',
    ...materials.map((m) => `  ・${m}`),
  ];
  events.push('あなたは倒れた。');
  recordSummary(state.telemetry, {
    runSeed: state.instance.runSeed,
    characterId: state.instance.character.id,
    result: 'death',
    deepestFloor: state.deepestVisited,
    turns: state.turn,
    gotTreasure: state.player.hasTreasure,
  });
}

function escape(state: GameState, events: string[]): void {
  state.phase = 'escaped';
  const p = state.player;
  state.escapeLog = [
    '生還記録：',
    p.hasTreasure
      ? 'あなたは井戸の底の宝を携え、光の下へ戻ってきた。'
      : 'あなたは手ぶらで、しかし生きて戻ってきた。それで十分だ。',
    `最深到達: 地下${state.deepestVisited}階。`,
    conditionWord(p.condition) + '。' + armorWord(p.armorWear) + '。',
    '読んだ記録の当たり外れは、あなたの体が覚えているだろう。',
  ];
  events.push('地上の光が見える。');
  recordSummary(state.telemetry, {
    runSeed: state.instance.runSeed,
    characterId: state.instance.character.id,
    result: 'escape',
    deepestFloor: state.deepestVisited,
    turns: state.turn,
    gotTreasure: p.hasTreasure,
  });
}

// ---- 行動の列挙 ----

export function availableActions(state: GameState): Action[] {
  if (state.phase === 'dead' || state.phase === 'escaped') return [];
  if (state.phase === 'encounter') {
    return [{ type: 'engage' }, { type: 'retreat' }];
  }
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const actions: Action[] = [];
  for (const dir of ['north', 'south', 'west', 'east'] as Dir[]) {
    const t = {
      x: state.pos.x + DIR_VEC[dir].x,
      y: state.pos.y + DIR_VEC[dir].y,
    };
    const tile = tileAt(floor, t);
    if (!tile) continue;
    // 既知の壁・既知の崩落には進めない。未知（?）へは踏み込める＝境界（§9.2）
    if (know.seen.has(key(t))) {
      if (tile.kind !== 'floor') continue;
      const f = featureAt(floor, t);
      if (f && f.kind === 'collapse') continue;
    }
    actions.push({ type: 'move', dir });
  }
  actions.push({ type: 'listen' });
  actions.push({ type: 'rest' });
  const here = featureAt(floor, state.pos);
  if (here?.kind === 'stairsDown') actions.push({ type: 'descend' });
  if (here?.kind === 'stairsUp' && floor.depth > 1) actions.push({ type: 'ascend' });
  if (here?.kind === 'stairsUp' && floor.depth === 1) actions.push({ type: 'escape' });
  if (state.player.potions > 0) actions.push({ type: 'drinkPotion' });
  if (state.player.food > 0) actions.push({ type: 'eat' });
  return actions;
}

// ---- エンカウント ----

function startEncounter(state: GameState, enemy: Entity, events: string[]): void {
  const assessment = assessDanger(state.player, enemy, state.instance.character);
  const soundByKind: Record<string, string> = {
    metallic: '金属の擦れる音を立てて、それは振り向いた。',
    beast: '低い唸りが喉の奥から漏れている。',
    shade: '空気が冷たく淀み、輪郭のない影が立ち塞がった。',
  };
  events.push(`${enemy.name}が行く手を塞いでいる。${soundByKind[enemy.kind]}`);
  events.push(`（危険度：${assessment.label}）`);
  const materials = [
    `${enemy.name}——危険度：${assessment.label}`,
    ...assessment.factors,
    ...currentMaterials(state),
  ];
  if (assessment.factors.length > 0) {
    events.push(`不安がよぎる——${assessment.factors.join('。')}。`);
  }
  state.pending = { enemyId: enemy.id, assessment, materials };
  state.phase = 'encounter';
}

function resolveEngage(state: GameState, events: string[]): void {
  const pending = state.pending!;
  const floor = currentFloor(state);
  const enemy = floor.entities.find((e) => e.id === pending.enemyId)!;
  const risk = pending.assessment.internalRisk;
  const label = pending.assessment.label;
  const p = state.player;

  events.push(`あなたは${enemy.name}に挑んだ。`);
  const roll = state.rng.next();
  if (roll < risk) {
    // 死亡か重傷か
    if (state.rng.next() < 0.45) {
      recordDanger(state.telemetry, {
        turn: state.turn,
        danger_label: label,
        internal_risk: risk,
        engaged: true,
        outcome: 'death',
      });
      state.pending = pending; // 死亡ログが判断材料を参照する
      die(
        state,
        events,
        `あなたは「${label}」とみた${enemy.name}に挑み、敗北した。`,
      );
      return;
    }
    // 重傷: 倒しはしたが深手を負う
    enemy.alive = false;
    p.condition -= 40 + Math.floor(state.rng.next() * 15);
    p.armorWear = Math.min(100, p.armorWear + 20);
    events.push(`辛くも${enemy.name}を退けた。だが深手を負った。革鎧が裂けている。`);
    recordDanger(state.telemetry, {
      turn: state.turn,
      danger_label: label,
      internal_risk: risk,
      engaged: true,
      outcome: 'heavy',
    });
  } else {
    enemy.alive = false;
    const dmg = 4 + Math.floor(enemy.strength * 14 * state.rng.next());
    p.condition -= dmg;
    p.armorWear = Math.min(100, p.armorWear + 5 + Math.floor(state.rng.next() * 8));
    events.push(`${enemy.name}は動かなくなった。${dmg > 10 ? '浅くない傷を受けた。' : 'かすり傷で済んだ。'}`);
    recordDanger(state.telemetry, {
      turn: state.turn,
      danger_label: label,
      internal_risk: risk,
      engaged: true,
      outcome: dmg > 10 ? 'wounded' : 'win',
    });
    // 戦利品（性格: 報酬は武器寄り）
    if (state.rng.next() < 0.45) {
      if (!p.hasWeapon && state.rng.next() < state.instance.character.biases.rewardWeaponBias) {
        p.hasWeapon = true;
        events.push('倒した敵の傍らに、まだ使える剣が落ちていた。拾い上げる。');
      } else {
        p.potions++;
        events.push('敵の持ち物から薬瓶を見つけた。');
      }
    }
  }

  state.pending = null;
  state.phase = 'explore';
  advanceTurn(state, events, 2, 2);
  if (p.condition <= 0) {
    die(state, events, '戦いの傷が深すぎた。'); // die側で二重死亡を防いでいる
    return;
  }
  look(state, events);
}

function resolveRetreat(state: GameState, events: string[]): void {
  const pending = state.pending!;
  const floor = currentFloor(state);
  const enemy = floor.entities.find((e) => e.id === pending.enemyId)!;
  const risk = pending.assessment.internalRisk;
  events.push(`あなたは${enemy.name}から目を離さず、後ずさった。`);
  if (state.rng.next() < risk * 0.35) {
    const dmg = 6 + Math.floor(state.rng.next() * 10);
    state.player.condition -= dmg;
    events.push('背を向けた一瞬、鋭い痛みが走った。');
    recordDanger(state.telemetry, {
      turn: state.turn,
      danger_label: pending.assessment.label,
      internal_risk: risk,
      engaged: false,
      outcome: 'retreatHit',
    });
  } else {
    events.push('それは追ってこなかった。ただ、こちらを見ている。');
    recordDanger(state.telemetry, {
      turn: state.turn,
      danger_label: pending.assessment.label,
      internal_risk: risk,
      engaged: false,
      outcome: 'avoided',
    });
  }
  state.pending = null;
  state.phase = 'explore';
  advanceTurn(state, events, 1, 1.5);
  if (state.player.condition <= 0) {
    die(state, events, '逃げ切れはした。だが傷は深すぎた。');
  }
}

// ---- 移動とタイルイベント ----

function stepOnTile(state: GameState, events: string[]): void {
  const floor = currentFloor(state);
  const p = state.player;
  const f = featureAt(floor, state.pos);
  if (f) {
    switch (f.kind) {
      case 'trap':
        if (!f.triggered) {
          f.triggered = true;
          p.condition -= 12;
          p.poisonTurns = 4;
          events.push('足元で乾いた音がした——毒の棘だ。痺れが脚を這い上がってくる。');
        } else {
          events.push('床に朽ちた仕掛けの残骸がある。もう動かない。');
        }
        break;
      case 'spring':
        p.condition = Math.min(100, p.condition + 20);
        p.hunger = Math.max(0, p.hunger - 20);
        f.uses = (f.uses ?? 0) + 1;
        if (f.uses >= 2) {
          f.kind = 'driedSpring';
          events.push('泉の水を飲み干した。水脈は細り、あとには乾いた窪みだけが残った。');
        } else {
          events.push('冷たい泉が湧いている。水を飲むと、体の芯が少し軽くなった。');
        }
        break;
      case 'driedSpring':
        events.push('泉の跡がある。だが水は涸れて久しい。底に乾いた泥だけが残っている。');
        break;
      case 'treasure':
        if (!f.taken) {
          f.taken = true;
          p.hasTreasure = true;
          events.push('石台の上に、それはあった。井戸の底の宝だ。あとは、生きて帰るだけだ。');
        }
        break;
      case 'stairsUp':
        events.push(
          floor.depth === 1
            ? '入口の階段だ。ここから地上へ戻れる。'
            : f.crumbling
              ? '上りの階段——だが半ば崩れている。登るには苦労しそうだ。'
              : '上りの階段がある。',
        );
        break;
      case 'stairsDown':
        events.push('下りの階段が、暗がりの奥へ続いている。');
        break;
      case 'collapse':
        break; // 到達不能
    }
  }
  const item = itemAt(floor, state.pos);
  if (item) {
    item.taken = true;
    if (item.kind === 'food') {
      p.food++;
      events.push('乾いた糧食が落ちている。まだ食べられそうだ。');
    } else if (item.kind === 'potion') {
      p.potions++;
      events.push('濁った薬瓶を拾った。中身は振ってみても分からない。');
    } else if (item.kind === 'weapon') {
      if (item.broken) {
        events.push('剣だ——だが手に取ると、刃は錆びて根元から折れた。使い物にならない。');
      } else {
        p.hasWeapon = true;
        events.push('古びた剣を拾った。刃はまだ生きている。');
      }
    }
  }
}

function doMove(state: GameState, dir: Dir, events: string[]): void {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const target = { x: state.pos.x + DIR_VEC[dir].x, y: state.pos.y + DIR_VEC[dir].y };
  const tile = tileAt(floor, target);
  if (!tile) return;

  // 未知のマスに踏み込もうとした場合も、まず見える（視界は正確）
  if (tile.kind !== 'floor') {
    know.seen.add(key(target));
    events.push(`${DIR_WORD[dir]}へ進もうとしたが、行く手は壁だった。`);
    verifyClaims(state, events);
    return; // 壁への衝突はターンを消費しない
  }
  const blockingFeature = featureAt(floor, target);
  if (blockingFeature?.kind === 'collapse') {
    know.seen.add(key(target));
    events.push(`${DIR_WORD[dir]}の道は崩れた瓦礫に塞がれている。通れない。`);
    verifyClaims(state, events);
    return;
  }
  const enemy = enemyAt(floor, target);
  if (enemy) {
    know.seen.add(key(target));
    startEncounter(state, enemy, events);
    return;
  }

  state.pos = target;
  know.walked.add(key(target)); // 踏破: 100%（憲法2）
  know.seen.add(key(target));
  advanceTurn(state, events, 1.2, 1.5);
  if (state.phase !== 'explore') return;
  stepOnTile(state, events);
  if (state.player.condition <= 0) {
    die(state, events, '毒の仕掛けが最後の一押しになった。');
    return;
  }
  look(state, events);
}

// ---- 耳を澄ます（気配情報の生成。§6.1 sense帯） ----

function doListen(state: GameState, events: string[]): void {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  // まだ見えていない近くの対象を探す
  type Target = { pos: Vec; kind: 'enemy' | 'trap' | 'spring'; enemyKind?: string };
  const targets: Target[] = [];
  for (const e of floor.entities) {
    if (e.alive && !know.seen.has(key(e.pos))) targets.push({ pos: e.pos, kind: 'enemy', enemyKind: e.kind });
  }
  for (const f of floor.features) {
    if (know.seen.has(key(f.pos))) continue;
    if (f.kind === 'trap' && !f.triggered) targets.push({ pos: f.pos, kind: 'trap' });
    if (f.kind === 'spring') targets.push({ pos: f.pos, kind: 'spring' });
  }
  const near = targets
    .filter((t) => Math.max(Math.abs(t.pos.x - state.pos.x), Math.abs(t.pos.y - state.pos.y)) <= 4)
    .slice(0, 2);

  if (near.length === 0) {
    events.push('耳を澄ました。……静かだ。石の下で水脈が鳴っているだけだ。');
  }

  for (const t of near) {
    // すでにこの対象への気配情報があるなら重複させない
    const already = state.senses.some(
      (s) => !s.verified && s.actualPos && s.actualPos.x === t.pos.x && s.actualPos.y === t.pos.y,
    );
    if (already) continue;

    const internalP = drawInternalP(state.rng, 'sense');
    // §8 解決: 気配情報の外れ方は「方向の誤認」か「内容の誤認」のみ（resolve.tsの重みに従う）
    const resolution = resolveInfo(state.rng, internalP, ['drift', 'misread']);
    const held = resolution.held;
    const missPattern = resolution.held ? undefined : resolution.missPattern;

    const soundOf: Record<string, string> = {
      enemy_metallic: '金属の擦れる音がする',
      enemy_beast: '低い唸りのようなものが聞こえる',
      enemy_shade: '空気が不自然に冷たい',
      trap: '床の下で、細い糸が張るような軋みがする',
      spring: 'かすかに水の音がする',
    };
    const soundKey = t.kind === 'enemy' ? `enemy_${t.enemyKind}` : t.kind;

    let dir = dirWord8(state.pos, t.pos);
    let reportedKind: string = t.kind;
    let text: string;
    if (held) {
      text = `${dir}から、${soundOf[soundKey]}。`;
    } else if (missPattern === 'drift') {
      // 方向の誤認: 別の方向として報告する
      const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'].filter((d) => d !== dir);
      dir = pick(state.rng, dirs);
      text = `${dir}から、${soundOf[soundKey]}……気がする。`;
    } else {
      // 内容の誤認: 敵↔罠、泉→ただの水滴
      if (t.kind === 'enemy') {
        reportedKind = 'trap';
        text = `${dir}で、仕掛けが軋むような音がする。`;
      } else if (t.kind === 'trap') {
        reportedKind = 'enemy';
        text = `${dir}から、何かが動く音がする。`;
      } else {
        reportedKind = 'nothing';
        text = `${dir}で水音——いや、ただの滴りかもしれない。`;
      }
    }

    state.senseSeq++;
    state.senses.push({
      id: `s${state.senseSeq}`,
      source: 'sense',
      internalP,
      kind: (reportedKind === 'nothing' ? 'spring' : reportedKind) as Claim['kind'],
      floorDepth: floor.depth,
      claimedPos: t.pos,
      text,
      held,
      missPattern,
      actualPos: t.pos,
      actualKind: t.kind,
      verified: false,
    });
    events.push(`${text}（気配：${confidenceLabel(internalP)}）`);
  }

  advanceTurn(state, events, 0.8, 1);
}

// ---- その他の行動 ----

function doRest(state: GameState, events: string[]): void {
  const p = state.player;
  // 空腹だと休んでも回復しない（空腹・装備が効く、の学習材料 §7）
  if (p.hunger >= 100) {
    events.push('壁に背を預けた。だが飢えで眠れず、体は少しも休まらない。');
  } else if (p.hunger >= 80) {
    p.condition = Math.min(100, p.condition + 6);
    events.push('短く休んだ。腹の虫が鳴って、眠りは浅い。');
  } else {
    p.condition = Math.min(100, p.condition + 14);
    events.push('壁に背を預け、短く休んだ。傷の手当てと、革鎧の紐を締め直す。');
  }
  p.armorWear = Math.max(0, p.armorWear - 4); // 応急の手入れ
  advanceTurn(state, events, 3, 3);
}

function doDrinkPotion(state: GameState, events: string[]): void {
  const p = state.player;
  p.potions--;
  // 性格: 薬効の不安定さ（potionInstability）
  if (state.rng.next() < state.instance.character.biases.potionInstability) {
    const sub = state.rng.next();
    if (sub < 0.4) {
      events.push('薬を飲んだ。……何も起きない。ただの濁り水だったのか。');
    } else if (sub < 0.7) {
      p.condition = Math.min(100, p.condition + 12);
      events.push('薬を飲んだ。効きは鈍いが、少しだけ楽になった。');
    } else {
      p.condition -= 6;
      events.push('薬を飲んだ。腹の奥が焼けるように痛む。悪いものだったらしい。');
    }
  } else {
    p.condition = Math.min(100, p.condition + 30);
    events.push('薬を飲んだ。温かいものが傷に染みわたる。よく効いた。');
  }
  advanceTurn(state, events, 0.5, 0.5);
}

function doEat(state: GameState, events: string[]): void {
  const p = state.player;
  p.food--;
  p.hunger = Math.max(0, p.hunger - 40);
  events.push('乾いた糧食をかじった。味は薄いが、腹は落ち着いた。');
  advanceTurn(state, events, 0, 0.5);
}

function doDescend(state: GameState, events: string[]): void {
  state.floorIndex++;
  state.deepestVisited = Math.max(state.deepestVisited, state.floorIndex + 1);
  const floor = currentFloor(state);
  const up = floor.features.find((f) => f.kind === 'stairsUp')!;
  state.pos = { ...up.pos };
  const know = state.knowledge[state.floorIndex];
  know.walked.add(key(state.pos));
  events.push(`階段を降りる。地下${floor.depth}階。空気が重くなった。`);
  state.senses = state.senses.filter((s) => !s.verified && s.floorDepth === floor.depth);
  advanceTurn(state, events, 1.5, 2);
  if (state.phase === 'explore') look(state, events);
}

function doAscend(state: GameState, events: string[]): void {
  const floor = currentFloor(state);
  const up = featureAt(floor, state.pos)!;
  if (up.crumbling) {
    // 性格: 下層ほど帰還困難（lowerReturnDifficulty）
    state.player.condition -= 8;
    events.push('崩れかけた階段をよじ登る。足場が二度抜け、膝を打った。');
  } else {
    events.push('階段を上る。');
  }
  state.floorIndex--;
  const upper = currentFloor(state);
  const down = upper.features.find((f) => f.kind === 'stairsDown')!;
  state.pos = { ...down.pos };
  state.knowledge[state.floorIndex].walked.add(key(state.pos));
  events.push(`地下${upper.depth}階に戻ってきた。`);
  advanceTurn(state, events, 1.5, 2);
  if (state.player.condition <= 0) {
    die(state, events, '崩れた階段が、最後の体力を奪った。');
    return;
  }
  if (state.phase === 'explore') look(state, events);
}

// ---- ステップ（1ターン処理 §11） ----

export function step(state: GameState, action: Action): string[] {
  if (state.phase === 'dead' || state.phase === 'escaped') return [];
  const events: string[] = [];
  recordChoice(state.telemetry, { turn: state.turn, action: action.type });

  if (state.phase === 'encounter') {
    if (action.type === 'engage') resolveEngage(state, events);
    else if (action.type === 'retreat') resolveRetreat(state, events);
    state.events = events;
    return events;
  }

  switch (action.type) {
    case 'move':
      doMove(state, action.dir, events);
      break;
    case 'listen':
      doListen(state, events);
      break;
    case 'rest':
      doRest(state, events);
      break;
    case 'drinkPotion':
      doDrinkPotion(state, events);
      break;
    case 'eat':
      doEat(state, events);
      break;
    case 'descend':
      doDescend(state, events);
      break;
    case 'ascend':
      doAscend(state, events);
      break;
    case 'escape':
      escape(state, events);
      break;
    default:
      break;
  }

  state.events = events;
  return events;
}
