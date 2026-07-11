// ゲーム状態・ターンループの遷移 §10・§11
// core はUIもDOMも一切触らない。副作用は注入されたPRNGのみ（§4.1）。

import type {
  ArmorGear,
  Claim,
  DungeonInstance,
  Entity,
  Floor,
  Memo,
  PlayerState,
  PotionKind,
  Vec,
  WeaponGear,
} from './types';
import type { DungeonCharacter } from './types';
import { KIND_WORD, POTION_DROP, POTION_NAMES } from './character';
import { confidenceLabel, drawCue, drawInternalP, SOURCE_NAMES } from './confidence';
import {
  combatProfile,
  enemyHitChance,
  fightRound,
  HEAVY_LOSS,
  rollEnemyDamage,
  type Approacher,
} from './combat';
import { describeGems, GEM_DATA, rollGemKind } from './economy';
import {
  ARMOR_DATA,
  armorShortWord,
  armorWord,
  gearGauge,
  rollGearBonus,
  WEAPON_CAP,
  weaponBetter,
  weaponWord,
} from './gear';
export { KIND_WORD, POTION_NAMES };
export { armorWord, weaponWord } from './gear';
import { assessDanger, type DangerAssessment } from './danger';
import {
  enemyAt,
  featureAt,
  floorCells,
  generateInstance,
  isWalkable,
  itemAt,
  makeEnemy,
  tileAt,
} from './generate';
import { applyHearsay } from './hearsay';
import { resolveInfo } from './resolve';
import type { RNG } from './rng';
import { hashSeed, mulberry32, pick, pickWeighted, shuffle } from './rng';
import {
  createTelemetry,
  recordChoice,
  recordDanger,
  recordInfo,
  recordSummary,
  type TelemetryLog,
} from './telemetry';

// ---- 出来事の行 ----
// UIは tone で色を変える（bad=身に受けた痛み・悪化は赤、good=回復・実入りは緑）。
// 情報の信頼度を色分けしない方針（憲法6）はそのまま——色が付くのは「起きた事実」だけ。

export type EventTone = 'bad' | 'good';
export type EventLine = string | { text: string; tone: EventTone };

export function eventText(e: EventLine): string {
  return typeof e === 'string' ? e : e.text;
}
export function eventTone(e: EventLine): EventTone | null {
  return typeof e === 'string' ? null : e.tone;
}
const bad = (text: string): EventLine => ({ text, tone: 'bad' });
const good = (text: string): EventLine => ({ text, tone: 'good' });

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

export function torchWord(torch: number, spares: number, counted = false): string {
  const flame =
    torch > 60
      ? '松明は明るい'
      : torch > 30
        ? '松明は揺らいでいる'
        : torch > 0
          ? '松明は残り少ない'
          : '明かりが消えている';
  // 荷を検めた後は、予備の本数を数えで言える（観測済みの事実）
  const spare = counted
    ? spares > 0
      ? `予備はあと${spares}本`
      : '予備はもうない'
    : spares >= 2
      ? '予備はまだある'
      : spares === 1
        ? '予備は最後の一本だ'
        : '予備はもうない';
  return `${flame}（${spare}）`;
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
  /** 先制の一投を使ったか（距離があるうちの一投は一度だけ） */
  thrown: boolean;
  /** 打ち合いのラウンド数。0 = まだ刃を合わせていない（投げられるのはこの間だけ） */
  rounds: number;
  /** 最初に刃を合わせた時の読み（計測§12はこの時点のラベルで行う） */
  engagedLabel?: string;
  engagedRisk?: number;
  /** 打ち合い開始時の体調（勝った時の重傷判定に使う） */
  conditionAtStart?: number;
};


export type GameState = {
  instance: DungeonInstance;
  /** 手元の記録の文書（メモ）。claims は memoId でこれに属する */
  memos: Memo[];
  claims: Claim[];
  player: PlayerState;
  floorIndex: number; // 0-based
  pos: Vec;
  knowledge: Knowledge[];
  /** 今このターンに見えているマス（動く敵の可視判定用。seenは累積、こちらは現在） */
  visibleNow: Set<string>;
  turn: number;
  phase: GamePhase;
  pending: PendingEncounter | null;
  /** 直近の行動結果（行動後の結果と事前情報の対応 §10） */
  events: EventLine[];
  /** 耳を澄ますで得た未検証の気配情報 */
  senses: Claim[];
  deathLog: string[] | null;
  escapeLog: string[] | null;
  telemetry: TelemetryLog;
  rng: RNG; // プレイ時の判定用（runSeed由来。同じ行動列なら同じ結果）
  deepestVisited: number;
  senseSeq: number;
  /**
   * 札の目撃知識: 自分で投げて見た効果は確定（憲法2）。
   * 模様→種族→'strong'|'backfire'|'neutral'
   */
  talismanKnowledge: Record<string, Record<string, 'strong' | 'backfire' | 'neutral'>>;
  /** 荷を検めたか。一度数えれば、以後の増減は頭に入っている（個数表示になる） */
  counted: boolean;
  /** 一度でも足を踏み入れた階（floorIndex）。再訪時は大地の編み直しで敵が湧き直す */
  visitedFloors: Set<number>;
  /** 再湧きした敵のID連番 */
  respawnSeq: number;
  /** 床に置いていった装備のID連番 */
  dropSeq: number;
  /**
   * 直前の行動で立ち止まっていたか（休む・薬・耳を澄ます等）。
   * 立ち止まっている隙に追いつかれると、敵の初撃つきで遭遇が始まる
   */
  stoodStill: boolean;
};

export type Action =
  | { type: 'move'; dir: Dir }
  | { type: 'listen' }
  | { type: 'rest' }
  | { type: 'descend' }
  | { type: 'ascend' }
  | { type: 'escape' }
  | { type: 'drinkPotion'; kind: PotionKind }
  | { type: 'eat' }
  | { type: 'drink' } // 泉の水を飲む（不可逆な賭け）
  | { type: 'open' } // 宝箱を開ける（不可逆な賭け）
  | { type: 'inspect' } // 調べる: 箱・泉の安全性について気配帯の情報を自力生成する
  | { type: 'engage' }
  | { type: 'retreat' }
  | { type: 'steal' } // 眠る相手の懐を探る（しくじれば目が覚める）
  | { type: 'checkPack' } // 荷を検める: 落ち着いて数を数える（以後、個数が分かる）
  | { type: 'equipWeapon'; index: number } // 腰の得物に持ち替える（1ターン・遭遇中は不可）
  | { type: 'equipArmor' } // 背の予備の鎧に着替える（1ターン・遭遇中は不可）
  | { type: 'throwStone' } // 距離があるうちの一投（安全だが弱い）
  | { type: 'throwFireOil' } // 火油の瓶（種族を問わず焼くが、逃げ場がないと己も焼く）
  | { type: 'throwTalisman'; pattern: string }; // 札の賭け（相性は投げるまで分からない）

const key = (p: Vec) => `${p.x},${p.y}`;

export function currentFloor(state: GameState): Floor {
  return state.instance.floors[state.floorIndex];
}

// ---- 生成 ----

/**
 * 出発時の装備。生還すれば持ち出した品が次の潜行の支度になる（死ねば失う）。
 * 持ち越した札の模様は残るが、模様→効果の理は編み直される（talismanLoreはランごと）
 */
export type StartKit = {
  potions: Record<string, number>; // 薬の種類→本数
  food: number;
  stones: number;
  spareTorches: number;
  /** 火油の瓶（帳場で買う。持ち越し可） */
  fireOil: number;
  /** 手持ちの得物（先頭が手にしているもの）。空ならギルドの標準（傷んだ短剣）が支給される */
  weapons: WeaponGear[];
  /** 着ている鎧。null ならギルドの標準（革鎧）が支給される */
  armor: ArmorGear | null;
  talismans: Record<string, number>;
};

// ---- 携行上限（荷は無限には持てない） ----
export const POTION_CAP = 3; // 薬は種類ごとに3本まで
export const FOOD_CAP = 10;
export const STONE_CAP = 20;

/** ギルドが保証する最低限の支度。持ち越しがこれを下回っても詰まない（死の連鎖を断つ） */
export const BASE_KIT: StartKit = {
  potions: { salve: 1 },
  food: 2,
  stones: 2,
  spareTorches: 2, // 冒険者は準備してくる。暗闇は計画の失敗として訪れる
  fireOil: 0,
  weapons: [{ kind: 'dagger', wear: 45 }], // 傷んだ短剣。丸腰で潜る冒険者はいない
  armor: { kind: 'leather', wear: 10 },
  talismans: {},
};

/** 項目ごとにギルドの標準と持ち越しの多い方を採る（装備は深いコピー——帳面の品を潜行が汚さない） */
function mergeKit(kit?: StartKit): StartKit {
  const baseWeapons = BASE_KIT.weapons.map((w) => ({ ...w }));
  const baseArmor = BASE_KIT.armor ? { ...BASE_KIT.armor } : null;
  if (!kit) {
    return {
      ...BASE_KIT,
      potions: { ...BASE_KIT.potions },
      talismans: {},
      weapons: baseWeapons,
      armor: baseArmor,
    };
  }
  const potions: Record<string, number> = { ...kit.potions };
  for (const [kind, count] of Object.entries(BASE_KIT.potions)) {
    potions[kind] = Math.max(count, potions[kind] ?? 0);
  }
  for (const kind of Object.keys(potions)) {
    potions[kind] = Math.min(POTION_CAP, potions[kind]);
  }
  const weapons = kit.weapons.filter((w) => w.wear < 100).map((w) => ({ ...w }));
  weapons.sort((a, b) => (weaponBetter(a, b) ? -1 : 1));
  weapons.splice(WEAPON_CAP); // 手＋腰2の上限
  return {
    potions,
    food: Math.min(FOOD_CAP, Math.max(BASE_KIT.food, kit.food)),
    stones: Math.min(STONE_CAP, Math.max(BASE_KIT.stones, kit.stones)),
    spareTorches: Math.max(BASE_KIT.spareTorches, kit.spareTorches),
    fireOil: Math.max(BASE_KIT.fireOil, kit.fireOil ?? 0),
    weapons: weapons.length > 0 ? weapons : baseWeapons,
    armor: kit.armor ? { ...kit.armor } : baseArmor,
    talismans: { ...kit.talismans },
  };
}

export function newGame(character: DungeonCharacter, runSeed: number, kit?: StartKit): GameState {
  // 生成パイプライン: 地形 → 古地図・噂の解決（地形の最終化を含む）。以後、地形は不変
  const instance = generateInstance(character, runSeed);
  const { memos, claims } = applyHearsay(instance, runSeed);
  const k = mergeKit(kit);

  const entry = instance.floors[0].features.find((f) => f.kind === 'stairsUp')!;
  const state: GameState = {
    instance,
    memos,
    claims,
    player: {
      condition: 100,
      hunger: 10,
      torch: 100,
      spareTorches: k.spareTorches,
      poisonTurns: 0,
      hasteTurns: 0,
      weapons: k.weapons,
      armor: k.armor,
      hasTreasure: false,
      fireOil: k.fireOil,
      gems: {},
      potions: k.potions,
      food: k.food,
      stones: k.stones,
      talismans: k.talismans,
      ownLog: [],
    },
    floorIndex: 0,
    pos: { ...entry.pos },
    knowledge: instance.floors.map(() => ({ walked: new Set(), seen: new Set() })),
    visibleNow: new Set(),
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
    talismanKnowledge: {},
    counted: false,
    visitedFloors: new Set([0]),
    respawnSeq: 0,
    dropSeq: 0,
    stoodStill: false,
  };

  state.knowledge[0].walked.add(key(state.pos));
  const events: EventLine[] = [
    `あなたは「${character.name}」の入口に立っている。`,
    '酒場で聞いた噂は、手元の記録に書き留めてある。',
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
function look(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const radius = state.player.torch > 0 ? 2 : 1;
  state.visibleNow = new Set();
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const p = { x: state.pos.x + dx, y: state.pos.y + dy };
      if (!tileAt(floor, p)) continue;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 1 && !lineOfSight(floor, state.pos, p)) continue;
      state.visibleNow.add(key(p));
      know.seen.add(key(p)); // 地形の記憶は累積（静的な事実は忘れない）
    }
  }
  verifyClaims(state, events);
}

// ---- 情報の検証（行動後の対応表示 §10 ＋ 計測 §12） ----

function sourceName(c: Claim): string {
  return SOURCE_NAMES[c.source];
}

/** 箱の中身が「当たり」か */
function chestGood(actualKind: string): boolean {
  return ['chest_weapon', 'chest_armor', 'chest_potion', 'chest_food', 'chest_gem'].includes(
    actualKind,
  );
}

/** 検証時の対応文（なぜ外れたかが必ず言葉で残る。憲法4）。
 *  手がかり〈字の乱れ等〉を添えて出す——「乱れた字はどれだけ当たるか」を体で学ばせるため */
function correspondenceText(c: Claim): string {
  const src = `${sourceName(c)}〈${c.cue}〉`;
  if (c.held) {
    const what: Record<string, string> = {
      spring: c.actualKind === 'badSpring' ? '警告どおり、水は悪かった' : '記されたとおり、水は澄んでいた',
      chest:
        c.actualKind === 'chest_empty'
          ? '空という話は本当だった'
          : chestGood(c.actualKind)
            ? '箱の中身は本物だった'
            : '触るなという警告は正しかった',
      enemy: '何かが棲んでいるのは本当だった',
      trap: '毒の仕掛けは実在した',
      treasure: '宝の在り処は正しかった',
      passage: '道は今も通じていた',
      weapon: '得物は残されていた',
      lore: '札についての記述は正しかった',
    };
    return `（${src}：当たり——${what[c.kind]}）`;
  }
  switch (c.missPattern) {
    case 'drift':
      return `（${src}：位置が少しズレていた）`;
    case 'condition':
      if (c.kind === 'spring') {
        return c.actualKind === 'badSpring'
          ? `（${src}：泉はあった。だが水は悪くなっていた——内容は合うが条件が違う）`
          : `（${src}：泉はあった。だが涸れていた——内容は合うが条件が違う）`;
      }
      return `（${src}：得物はあった。だが朽ちていた——内容は合うが条件が違う）`;
    case 'stale':
      if (c.kind === 'chest') return `（${src}：その記録は古い——箱は先に漁られていた）`;
      return c.kind === 'passage'
        ? `（${src}：その記録は古い——道は崩れていた）`
        : `（${src}：その記録は古い——仕掛けはとうに朽ちていた）`;
    case 'misread':
      if (c.kind === 'chest') {
        // 文面の主張を基準に「どう外れたか」を語る（憲法4）
        return c.assertedSafety === 'bad'
          ? `（${src}：慎重すぎる警告だった——箱に牙はなかった）`
          : `（${src}：誤認だ——当たりのはずの箱に、牙があった）`;
      }
      if (c.kind === 'spring') {
        return c.assertedSafety === 'bad'
          ? `（${src}：見立て違いだ——水はただ澄んでいた）`
          : `（${src}：見立て違いだ——水は悪かった）`;
      }
      if (c.kind === 'lore') {
        return `（${src}：その手記は誤りだった——札はそうは働かなかった）`;
      }
      if (c.actualKind === 'enemy') {
        return `（${src}：誤認だ——仕掛けの軋みではない、生きて動くものだった）`;
      }
      return `（${src}：誰かの誤認だ——音の主は罠だった）`;
    case 'false':
      return `（${src}：そこには何もなかった）`;
    default:
      return `（${src}：外れ）`;
  }
}

/** 情報を検証済みにして、対応文の提示と計測を行う（§10・§12） */
function settleClaim(state: GameState, c: Claim, events: EventLine[]): void {
  c.verified = true;
  events.push(correspondenceText(c));
  recordInfo(state.telemetry, {
    turn: state.turn,
    source: c.source,
    label: confidenceLabel(c.internalP),
    internal_p: c.internalP,
    predicted: `${c.kind}${c.assertedSafety ? `:${c.assertedSafety}` : ''}@B${c.floorDepth}`,
    actual: c.actualKind,
    held: c.held,
    miss_pattern: c.missPattern,
  });
}

/**
 * 箱を開けた/水を飲んだ時の検証。
 * 箱と水の安全性は「見る」だけでは決して判明しない——賭けた者だけが答えを知る
 */
function verifyDecisionClaimsAt(state: GameState, pos: Vec, events: EventLine[]): void {
  const depth = currentFloor(state).depth;
  for (const c of [...state.claims, ...state.senses]) {
    if (c.verified || c.floorDepth !== depth) continue;
    if (c.kind !== 'chest' && c.kind !== 'spring' && c.kind !== 'treasure') continue;
    if (!c.actualPos || c.actualPos.x !== pos.x || c.actualPos.y !== pos.y) continue;
    settleClaim(state, c, events);
  }
}

/** 主張位置（または実位置・実体）が視界に入ったら、その情報の当否を提示・計測する */
function verifyClaims(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const pool = [...state.claims, ...state.senses];
  for (const c of pool) {
    if (c.verified || c.floorDepth !== floor.depth) continue;
    const claimedSeen = c.claimedPos !== null && know.seen.has(key(c.claimedPos));
    const actualSeen = c.actualPos !== null && know.seen.has(key(c.actualPos));
    // held/条件違い/古い情報は実位置が見えた時点で判明。
    // 位置ズレは両方見えて初めて「ズレていた」と分かる。誤情報は主張位置を見て「何もない」と分かる。
    // 動く敵についての情報は、位置ではなく敵本体を見た（or倒した）時点で判明
    let ready = false;
    if (c.kind === 'lore') continue; // 相性の噂は「その札をその相手に投げた」時にだけ判明する
    if (c.aboutEnemyId) {
      const enemy = floor.entities.find((e) => e.id === c.aboutEnemyId);
      ready = !!enemy && (!enemy.alive || state.visibleNow.has(key(enemy.pos)));
    } else if (
      (c.kind === 'chest' || c.kind === 'spring') &&
      (c.held || c.missPattern === 'condition' || c.missPattern === 'stale' || c.missPattern === 'misread')
    ) {
      // 箱の中身・水の安全性は視界では判明しない。開ける/飲むまで宙吊り
      // （涸れた泉だけは、乾いた窪みを見れば分かる）
      ready = c.actualKind === 'driedSpring' && actualSeen;
    } else if (c.held) ready = actualSeen;
    else if (c.missPattern === 'drift') ready = claimedSeen && actualSeen;
    else if (c.missPattern === 'false') ready = claimedSeen;
    else ready = actualSeen;
    if (!ready) continue;

    settleClaim(state, c, events);
  }
}

// ---- 判断材料（行動前の提示 §10） ----

/** いま画面に出ている判断材料を言葉で列挙する（死亡ログにも使う） */
export function currentMaterials(state: GameState): string[] {
  const out: string[] = [];
  const p = state.player;
  out.push(conditionWord(p.condition));
  out.push(hungerWord(p.hunger));
  out.push(armorWord(p.armor));
  out.push(torchWord(p.torch, p.spareTorches, state.counted));
  out.push(`得物は${weaponWord(p.weapons[0])}`);
  if (p.poisonTurns > 0) out.push('毒が回っている');
  const depth = currentFloor(state).depth;
  for (const c of state.claims) {
    if ((c.floorDepth === depth || c.floorDepth === 0) && !c.verified) {
      out.push(`${c.text}（${sourceName(c)}——${c.cue}）`);
    }
  }
  for (const s of state.senses) {
    if (s.floorDepth === depth && !s.verified) {
      out.push(`${s.text}（気配——${s.cue}）`);
    }
  }
  return out;
}

// ---- ターン共通処理 ----

function advanceTurn(state: GameState, events: EventLine[], hungerCost: number, torchCost: number): void {
  state.turn++;
  const p = state.player;
  p.hunger = Math.min(120, p.hunger + hungerCost);
  p.torch = Math.max(0, p.torch - torchCost);
  if (p.torch <= 0 && p.spareTorches > 0) {
    p.spareTorches--;
    p.torch = 100;
    events.push('松明が燃え尽きた。手早く予備に火を移す。');
  }
  if (p.poisonTurns > 0) {
    p.poisonTurns--;
    p.condition -= 3;
    events.push(bad('毒が体を蝕んでいる。'));
  }
  if (p.hasteTurns > 0) {
    p.hasteTurns--;
    if (p.hasteTurns === 0) events.push('体の軽さが抜けていく。風は行ってしまった。');
  }
  if (p.hunger >= 100) {
    p.condition -= 4;
    events.push(bad('飢えが体力を奪っていく。'));
  }
  if (p.condition <= 0) {
    die(state, events, '力尽きた。毒と飢えと暗闇が、静かに追いついてきたのだ。');
  }
}

// ---- 死亡・脱出 ----

function die(state: GameState, events: EventLine[], causeLine: string): void {
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
  events.push(bad('あなたは倒れた。'));
  recordSummary(state.telemetry, {
    runSeed: state.instance.runSeed,
    characterId: state.instance.character.id,
    result: 'death',
    deepestFloor: state.deepestVisited,
    turns: state.turn,
    gotTreasure: state.player.hasTreasure,
  });
}

function escape(state: GameState, events: EventLine[]): void {
  state.phase = 'escaped';
  const p = state.player;
  const gems = describeGems(p.gems);
  state.escapeLog = [
    '生還記録：',
    p.hasTreasure
      ? 'あなたは井戸の底の宝を携え、光の下へ戻ってきた。'
      : gems.length > 0
        ? 'あなたは囊に石の重みを抱えて、生きて戻ってきた。'
        : 'あなたは手ぶらで、しかし生きて戻ってきた。それで十分だ。',
    `最深到達: 地下${state.deepestVisited}階。`,
    ...(gems.length > 0 ? [`持ち帰った石: ${gems.join('、')}。`] : []),
    conditionWord(p.condition) + '。' + armorWord(p.armor) + '。',
    '読んだ記録の当たり外れは、あなたの体が覚えているだろう。',
  ];
  events.push(good('地上の光が見える。'));
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
    const actions: Action[] = [{ type: 'engage' }, { type: 'retreat' }];
    const foe = currentFloor(state).entities.find((e) => e.id === state.pending!.enemyId);
    // 眠っている相手の懐は探れる（しくじれば目が覚める＝工夫の勝ち筋）
    if (foe && (foe.sleepTurns ?? 0) > 0 && foe.carry !== 'none') {
      actions.push({ type: 'steal' });
    }
    // 距離があるうちの一投（一度だけ・刃を合わせる前だけ）。石は安全な削り、札は相性の賭け
    if (!state.pending!.thrown && state.pending!.rounds === 0) {
      if (state.player.stones > 0) actions.push({ type: 'throwStone' });
      if (state.player.fireOil > 0) actions.push({ type: 'throwFireOil' });
      for (const [pattern, count] of Object.entries(state.player.talismans)) {
        if (count > 0) actions.push({ type: 'throwTalisman', pattern });
      }
    }
    // 睨み合い・打ち合いの最中でも薬と糧食は使える——ただし、その隙に相手は動く
    for (const [kind, count] of Object.entries(state.player.potions)) {
      if (count > 0) actions.push({ type: 'drinkPotion', kind: kind as PotionKind });
    }
    if (state.player.food > 0) actions.push({ type: 'eat' });
    return actions;
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
  const here = featureAt(floor, state.pos);
  if (here?.kind === 'spring') {
    actions.push({ type: 'drink' });
    actions.push({ type: 'inspect' });
  }
  if (here?.kind === 'chest' && !here.opened) {
    actions.push({ type: 'open' });
    actions.push({ type: 'inspect' });
  }
  actions.push({ type: 'listen' });
  actions.push({ type: 'rest' });
  // 荷を検める: 敵の姿が見えていない、落ち着いた時にだけ数えられる
  const enemyInSight = floor.entities.some(
    (e) => e.alive && !e.dormant && state.visibleNow.has(key(e.pos)),
  );
  if (!state.counted && !enemyInSight) actions.push({ type: 'checkPack' });
  // 持ち替え・着替え（拾っただけでは手も体も変わらない——替えるのは自分の判断）
  for (let i = 1; i < state.player.weapons.length; i++) {
    actions.push({ type: 'equipWeapon', index: i });
  }
  const itemHere = itemAt(floor, state.pos);
  if (itemHere?.kind === 'armor') actions.push({ type: 'equipArmor' });
  if (here?.kind === 'stairsDown') actions.push({ type: 'descend' });
  if (here?.kind === 'stairsUp' && floor.depth > 1) actions.push({ type: 'ascend' });
  if (here?.kind === 'stairsUp' && floor.depth === 1) actions.push({ type: 'escape' });
  for (const [kind, count] of Object.entries(state.player.potions)) {
    if (count > 0) actions.push({ type: 'drinkPotion', kind: kind as PotionKind });
  }
  if (state.player.food > 0) actions.push({ type: 'eat' });
  return actions;
}

// ---- 敵の行動 ----

const CHASE_SIGHT = 5; // 敵の知覚半径（視線が通る場合のみ）
const CHASE_GIVE_UP = 3; // 視線を失ってから諦めるまでのターン数（角を曲がれば撒ける）

function chebDist(a: Vec, b: Vec): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function orthAdjacent(a: Vec, b: Vec): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function orthNeighbors(p: Vec): Vec[] {
  return [
    { x: p.x, y: p.y - 1 },
    { x: p.x, y: p.y + 1 },
    { x: p.x - 1, y: p.y },
    { x: p.x + 1, y: p.y },
  ];
}

/** 敵の1歩をBFSで求める（他の敵は障害物として避ける）。経路がなければnull */
function enemyStepToward(floor: Floor, from: Vec, to: Vec): Vec | null {
  const blocked = (p: Vec) =>
    floor.entities.some((e) => e.alive && e.pos.x === p.x && e.pos.y === p.y);
  const prev = new Map<string, string>();
  const seen = new Set<string>([key(from)]);
  const queue: Vec[] = [from];
  let found = false;
  while (queue.length > 0 && !found) {
    const cur = queue.shift()!;
    for (const n of orthNeighbors(cur)) {
      const k = key(n);
      if (seen.has(k) || !isWalkable(floor, n)) continue;
      const isGoal = n.x === to.x && n.y === to.y;
      if (!isGoal && blocked(n)) continue;
      seen.add(k);
      prev.set(k, key(cur));
      if (isGoal) {
        found = true;
        break;
      }
      queue.push(n);
    }
  }
  if (!found) return null;
  // ゴールから遡り、fromの次の1歩を返す
  let cur = key(to);
  while (prev.get(cur) !== key(from)) {
    cur = prev.get(cur)!;
  }
  const [x, y] = cur.split(',').map(Number);
  return { x, y };
}

/**
 * 敵のターン。全知にはしない:
 * - 視線が通ればプレイヤーの現在地を記憶（lastSeen）
 * - 追跡は lastSeen へ向かう。着いても居なければ、あるいは見失って数ターンで諦める
 * - 金属系（moveEvery=2）は1ターンおきにしか動けない＝走れば距離が開く
 * - 攻撃は「行動開始時に隣接していた」場合のみ＝追いつかれても1ターンは反応できる
 * @param holdId このターン動かない敵（退却直後の相手・打ち合い中の相手）
 * @param duel 打ち合いの最中か。最中は遭遇を上書きせず、隣まで来た敵は「横槍」を入れる
 */
function processEnemies(
  state: GameState,
  events: EventLine[],
  holdId?: string,
  duel = false,
): void {
  if (state.phase !== 'explore' && !duel) return;
  const floor = currentFloor(state);
  for (const e of floor.entities) {
    if (!e.alive || e.dormant || e.id === holdId) continue;

    // 眠りの札: 眠っている間は知覚も移動もしない
    if ((e.sleepTurns ?? 0) > 0) {
      e.sleepTurns!--;
      if (e.sleepTurns === 0 && state.visibleNow.has(key(e.pos))) {
        events.push(`${e.name}が身じろぎし、目を覚ました。`);
      }
      continue;
    }

    // 知覚は毎ターン（動きが遅くても目はある）
    const sees =
      chebDist(e.pos, state.pos) <= CHASE_SIGHT && lineOfSight(floor, e.pos, state.pos);
    if (sees) {
      if (!e.chasing && state.visibleNow.has(key(e.pos))) {
        events.push(`${e.name}がこちらに気づいた。`);
      }
      e.chasing = true;
      e.lastSeen = { ...state.pos };
      e.lostTurns = 0;
    } else if (e.chasing) {
      e.lostTurns++;
      if (e.lostTurns > CHASE_GIVE_UP) {
        e.chasing = false;
        e.lastSeen = null;
      }
    }

    if (state.turn % e.moveEvery !== 0) continue; // 重い敵は動けないターン
    // 韋駄天の札: 体が軽いうちは、敵の足がみな半分に見える
    if (state.player.hasteTurns > 0 && state.turn % 2 === 1) continue;

    if (e.chasing && e.lastSeen) {
      if (orthAdjacent(e.pos, state.pos)) {
        if (duel) {
          // 乱戦の横槍: 打ち合いの最中に隣まで来た敵は、遭遇を上書きせず殴りかかる
          sideAttack(state, e, events);
          if (state.phase === 'dead') return;
          continue;
        }
        // 立ち止まって何かしている隙に追いつかれた——敵の初撃つきで遭遇が始まる。
        // 走っている間は従来どおり睨み合いから（同速の相手から逃げる余地は残す）
        const profile = combatProfile(state.player, e, state.instance.character);
        if (state.stoodStill && state.rng.next() < enemyHitChance(e.strength, profile) * 0.8) {
          const dmg = rollEnemyDamage(e.strength, profile, state.rng) * 0.8;
          state.player.condition -= dmg;
          events.push(bad(`${e.name}に追いつかれた——振り向く間もなく一撃を受けた。`));
          wearArmor(state, 2 + Math.floor(state.rng.next() * 3), events);
          if (state.player.condition <= 0) {
            die(state, events, `${e.name}に背中を裂かれた。逃げ足よりも速い相手だった。`);
            return;
          }
          startEncounter(state, e, events, `${e.name}はもう目の前にいる。`);
        } else {
          startEncounter(state, e, events, `${e.name}が追いついた——暗がりから躍りかかってくる！`);
        }
        return;
      }
      if (e.pos.x === e.lastSeen.x && e.pos.y === e.lastSeen.y) {
        // 最後に見た場所に着いたが、姿はない——見失った
        e.chasing = false;
        e.lastSeen = null;
        continue;
      }
      const next = enemyStepToward(floor, e.pos, e.lastSeen);
      if (next && !(next.x === state.pos.x && next.y === state.pos.y)) {
        e.pos = next;
        enemyStepsOnTrap(state, e, events);
      }
    } else {
      // 徘徊: 気まぐれに1歩
      if (state.rng.next() < 0.4) {
        const options = orthNeighbors(e.pos).filter(
          (p) =>
            isWalkable(floor, p) &&
            !enemyAt(floor, p) &&
            !(p.x === state.pos.x && p.y === state.pos.y),
        );
        if (options.length > 0) {
          e.pos = pick(state.rng, options);
          enemyStepsOnTrap(state, e, events);
        }
      }
    }
  }
}

/** 乱戦の横槍役: 目を覚ましていて、近くで動いている他の敵（危険度に織り込む） */
function nearbyOthers(state: GameState, enemyId: string): Approacher[] {
  const floor = currentFloor(state);
  return floor.entities
    .filter(
      (o) =>
        o.alive &&
        !o.dormant &&
        o.id !== enemyId &&
        (o.sleepTurns ?? 0) <= 0 &&
        chebDist(o.pos, state.pos) <= 5 &&
        (o.chasing || lineOfSight(floor, o.pos, state.pos)),
    )
    .map((o) => ({ entity: o, distance: chebDist(o.pos, state.pos) }));
}

/** 乱戦の横槍: 打ち合いの最中、別の敵が隣から殴りかかる（実戦と同じ反撃モデル） */
function sideAttack(state: GameState, e: Entity, events: EventLine[]): void {
  const p = state.player;
  const profile = combatProfile(p, e, state.instance.character);
  if (state.rng.next() < enemyHitChance(e.strength, profile)) {
    const dmg = rollEnemyDamage(e.strength, profile, state.rng);
    p.condition -= dmg;
    events.push(bad(`横合いから${e.name}の一撃が飛んできた。`));
    wearArmor(state, 2 + Math.floor(state.rng.next() * 3), events);
    if (p.condition <= 0) {
      // 刃を合わせた後なら戦死として計測。睨み合い・投げの最中なら挑戦には数えない
      const pending = state.pending;
      if (pending && pending.rounds > 0) {
        recordFightEnd(state, 'death');
      } else if (pending) {
        recordDanger(state.telemetry, {
          turn: state.turn,
          danger_label: pending.assessment.label,
          internal_risk: pending.assessment.internalRisk,
          engaged: false,
          outcome: 'retreatHit',
        });
      }
      die(state, events, '乱戦に呑まれた。二匹目を、数えに入れていなかった。');
    }
  } else {
    events.push(`横合いから${e.name}が躍りかかる——身を捻ってかわした。`);
  }
}

/** 敵も罠を踏む——追われているなら、知っている罠の上を走って誘い込める */
function enemyStepsOnTrap(state: GameState, e: Entity, events: EventLine[]): void {
  const floor = currentFloor(state);
  const trap = featureAt(floor, e.pos);
  if (!trap || trap.kind !== 'trap' || trap.triggered) return;
  trap.triggered = true;
  e.strength = Math.max(0.05, e.strength - (0.2 + state.rng.next() * 0.15));
  const audible = chebDist(e.pos, state.pos) <= 6;
  if (e.strength <= 0.12) {
    e.alive = false;
    if (audible) events.push('仕掛けの跳ねる音、短い悲鳴——それきり、動く音はしない。');
  } else if (audible) {
    events.push('仕掛けの跳ねる音と、何かの呻きが聞こえた。');
  }
}

// ---- エンカウント ----

function startEncounter(state: GameState, enemy: Entity, events: EventLine[], lead?: string): void {
  const assessment = assessDanger(
    state.player,
    enemy,
    state.instance.character,
    nearbyOthers(state, enemy.id),
  );
  const soundByKind: Record<string, string> = {
    metallic: '金属の擦れる音を立てて、それは振り向いた。',
    beast: '低い唸りが喉の奥から漏れている。',
    shade: '空気が冷たく淀み、輪郭のない影が立ち塞がった。',
  };
  const sleeping = (enemy.sleepTurns ?? 0) > 0;
  events.push(
    lead ??
      (sleeping
        ? `${enemy.name}が丸くなって寝息を立てている。今なら、こちらの間合いだ。`
        : `${enemy.name}が行く手を塞いでいる。${soundByKind[enemy.kind]}`),
  );
  const labelLine = `（危険度：${assessment.label}）`;
  events.push(
    assessment.label === 'かなり危険' || assessment.label === '死の気配' ? bad(labelLine) : labelLine,
  );
  const materials = [
    `${enemy.name}——危険度：${assessment.label}`,
    ...assessment.factors,
    ...currentMaterials(state),
  ];
  if (assessment.factors.length > 0) {
    events.push(`見て取れること——${assessment.factors.join('。')}。`);
  }
  state.pending = { enemyId: enemy.id, assessment, materials, thrown: false, rounds: 0 };
  state.phase = 'encounter';
}

/** 先制の一投（§10: 賭けの結果は危険度ラベルの変化として即座に返す） */
function resolveThrow(
  state: GameState,
  events: EventLine[],
  opts: { pattern?: string; fireOil?: boolean } = {},
): void {
  const pending = state.pending!;
  const floor = currentFloor(state);
  const enemy = floor.entities.find((e) => e.id === pending.enemyId)!;
  const p = state.player;
  const pattern = opts.pattern;
  pending.thrown = true;

  if (opts.fireOil) {
    // 火油: 種族を問わず確実に大きく焼く。だが炎はうねる——下がれる床がなければ己も焼く
    p.fireOil--;
    enemy.strength = Math.max(0.05, enemy.strength - (0.3 + state.rng.next() * 0.12));
    events.push(good(`火油の瓶が${enemy.name}の足元で爆ぜ、炎が奴を呑んだ。`));
    if ((enemy.sleepTurns ?? 0) > 0) {
      enemy.sleepTurns = 0;
      events.push('炎に炙られ、それは跳ね起きた。');
    }
    const room = orthNeighbors(state.pos).filter(
      (q) => isWalkable(floor, q) && !enemyAt(floor, q),
    );
    if (room.length === 0) {
      const dmg = 8 + Math.floor(state.rng.next() * 8);
      p.condition -= dmg;
      events.push(bad('壁を背にしていた——うねり返した炎が、あなたの腕も舐めた。'));
      if (p.condition <= 0) {
        die(state, events, '自分の放った炎が、最後の一押しになった。');
        return;
      }
    }
  } else if (!pattern) {
    // 石は安全だが、あくまで牽制。仕留めるのは刃か火の仕事
    p.stones--;
    enemy.strength = Math.max(0.05, enemy.strength - (0.06 + state.rng.next() * 0.04));
    events.push(`石を投げつけた。${enemy.name}は一瞬ひるんだ。`);
  } else {
    p.talismans[pattern]--;
    const lore = state.instance.talismanLore[pattern];
    let effect: 'strong' | 'backfire' | 'neutral' = 'neutral';
    if (lore?.strongVs === enemy.kind) effect = 'strong';
    else if (lore?.backfireVs === enemy.kind) effect = 'backfire';
    const family = lore?.effect ?? 'burn';

    if (effect === 'strong') {
      // 相性が良い: 系統どおりの力が出る（灼く/鈍らせる/眠らせる/韋駄天）
      switch (family) {
        case 'burn':
          enemy.strength = Math.max(0.05, enemy.strength - (0.28 + state.rng.next() * 0.08));
          events.push(good(`${pattern}の札が触れた瞬間、${enemy.name}は灼かれたように仰け反った。`));
          break;
        case 'slow':
          enemy.moveEvery = Math.min(3, enemy.moveEvery + 1);
          enemy.strength = Math.max(0.05, enemy.strength - (0.1 + state.rng.next() * 0.06));
          events.push(good(`${pattern}の札が爆ぜると、${enemy.name}の動きが泥を掻くように鈍った。`));
          break;
        case 'sleep':
          enemy.sleepTurns = 6 + Math.floor(state.rng.next() * 4);
          enemy.chasing = false;
          enemy.lastSeen = null;
          events.push(good(`${pattern}の札が仄白く光り、${enemy.name}はその場に崩れて寝息を立て始めた。`));
          break;
        case 'haste':
          p.hasteTurns = 12;
          events.push(good(`${pattern}の札が爆ぜ、風があなたを包んだ。体が羽のように軽い。`));
          break;
      }
    } else if (effect === 'backfire') {
      // 相性が悪い: 力が相手に流れる
      if (family === 'haste' || family === 'slow') {
        enemy.moveEvery = 1;
        enemy.strength = Math.min(0.98, enemy.strength + (0.08 + state.rng.next() * 0.08));
        events.push(bad(`${pattern}の札の風は${enemy.name}に吸われた——奴の足が、速くなっている。`));
      } else {
        enemy.strength = Math.min(0.98, enemy.strength + (0.15 + state.rng.next() * 0.1));
        events.push(bad(`${pattern}の札は${enemy.name}に吸い込まれた——それは、昂っている。`));
      }
    } else {
      enemy.strength = Math.max(0.05, enemy.strength - (0.05 + state.rng.next() * 0.05));
      events.push(`${pattern}の札は爆ぜたが、石ほどの傷も残らなかった。`);
    }

    // 目撃した効果は確定の知識になる（憲法2: 自分の観測は正しい）
    state.talismanKnowledge[pattern] = {
      ...(state.talismanKnowledge[pattern] ?? {}),
      [enemy.kind]: effect,
    };
    // この模様×この種族についての噂があれば、いま検証された
    for (const c of state.claims) {
      if (
        !c.verified &&
        c.kind === 'lore' &&
        c.lorePattern === pattern &&
        c.loreTargetKind === enemy.kind
      ) {
        settleClaim(state, c, events);
      }
    }
  }

  // 投げた隙に踏み込まれることがある（眠らせた相手は踏み込んでこない）。
  // 相手がどれほど弱っていても、投擲の隙は隙だ（最低確率を持つ）
  if (
    (enemy.sleepTurns ?? 0) <= 0 &&
    state.rng.next() < 0.08 + pending.assessment.internalRisk * 0.25
  ) {
    p.condition -= 5 + Math.floor(state.rng.next() * 7);
    events.push(bad('投げた隙に、爪が掠めた。'));
    if (p.condition <= 0) {
      die(state, events, '投げた隙を突かれた。それが最後だった。');
      return;
    }
  }

  // 一投もひと呼吸ぶんの時間を食う——その間、他の何かは動いている（横槍もある）
  advanceTurn(state, events, 0.8, 0.8);
  if (state.phase === 'dead') return;
  processEnemies(state, events, enemy.id, true);
  if ((state.phase as GamePhase) === 'dead') return;

  // 危険度を再評価して見せる——賭けの結果がラベルの変化として返る
  const before = pending.assessment.label;
  pending.assessment = assessDanger(
    p,
    enemy,
    state.instance.character,
    nearbyOthers(state, enemy.id),
  );
  events.push(
    pending.assessment.label === before
      ? `（危険度：${before}のまま）`
      : `（危険度：${before} → ${pending.assessment.label}）`,
  );
}

// ---- 装備の傷みと入手 ----

/** いまいる階の深さ割合（0=最上階、1=最深階）。拾い物の拵えの分布に効く */
function gearDepthFrac(state: GameState): number {
  const maxDepth = state.instance.floors.length;
  return maxDepth > 1 ? (currentFloor(state).depth - 1) / (maxDepth - 1) : 0;
}

/** 鎧が打撃を受けて傷む。100で体をなさなくなる */
function wearArmor(state: GameState, amount: number, events: EventLine[]): void {
  const p = state.player;
  if (!p.armor) return;
  p.armor.wear = Math.min(100, p.armor.wear + amount);
  if (p.armor.wear >= 100) {
    events.push(bad(`${ARMOR_DATA[p.armor.kind].name}が裂けて崩れ落ちた。もう体をなさない。`));
    p.armor = null;
  }
}

/** 得物が打ち合いで擦り減る。100で折れ、腰の予備に持ち替える */
function wearWeapon(state: GameState, amount: number, events: EventLine[]): void {
  const p = state.player;
  const w = p.weapons[0];
  if (!w) return;
  w.wear = Math.min(100, w.wear + amount);
  if (w.wear >= 100) {
    p.weapons.shift();
    const next = p.weapons[0];
    events.push(
      next
        ? bad(`得物は根元から折れた——腰の${weaponWord(next)}に持ち替える。`)
        : bad('得物は根元から折れた。もう素手だ。'),
    );
  }
}

/** 得物を床に置いていく（拾い直せる。マップには * で残る） */
function dropWeaponHere(state: GameState, w: WeaponGear): void {
  state.dropSeq++;
  currentFloor(state).items.push({
    id: `drop-w${state.dropSeq}`,
    kind: 'weapon',
    name: weaponWord(w),
    pos: { ...state.pos },
    taken: false,
    weaponGear: w,
  });
}

/** 鎧を床に置いていく（拾い直せる） */
function dropArmorHere(state: GameState, a: ArmorGear): void {
  state.dropSeq++;
  currentFloor(state).items.push({
    id: `drop-a${state.dropSeq}`,
    kind: 'armor',
    name: armorShortWord(a),
    pos: { ...state.pos },
    taken: false,
    armorGear: a,
  });
}

/**
 * 得物を手に入れる。手にしている得物は替えない——持ち替えはプレイヤーの選択
 * （愛用の一本が勝手にベンチへ下がらない）。腰が塞がっていれば一番劣る予備を置いていく
 */
function gainWeapon(state: GameState, w: WeaponGear, events: EventLine[], lead: string): void {
  const p = state.player;
  if (p.weapons.length === 0) {
    p.weapons.push(w);
    events.push(good(`${lead}${weaponWord(w)}だ。素手よりずっといい——迷わず手に取る。`));
    return;
  }
  p.weapons.push(w);
  events.push(good(`${lead}${weaponWord(w)}だ。腰に差した。`));
  if (p.weapons.length > WEAPON_CAP) {
    // 手の得物（先頭）は置かない。腰の中で一番劣るものを置いていく
    let worst = 1;
    for (let i = 2; i < p.weapons.length; i++) {
      if (weaponBetter(p.weapons[worst], p.weapons[i])) worst = i;
    }
    const [dropped] = p.weapons.splice(worst, 1);
    dropWeaponHere(state, dropped);
    events.push(`腰はもう塞がっている。${weaponWord(dropped)}をその場に置いていった。`);
  }
}

/** 打ち捨てられた鎧の中身を決める（拾ってみるまで質は分からない） */
function rollArmorGear(state: GameState): ArmorGear {
  return {
    kind: state.rng.next() < 0.65 ? 'leather' : 'chain',
    wear: 20 + Math.floor(state.rng.next() * 45),
    bonus: rollGearBonus(state.rng, gearDepthFrac(state)),
  };
}

/**
 * 鎧を手に入れる。予備は背負えない——裸なら着る、着ていれば床に広げる
 * （その場に「着替える」行動が出る。着替えるかはプレイヤーの選択）
 */
function gainArmor(state: GameState, a: ArmorGear, events: EventLine[], lead: string): void {
  const p = state.player;
  if (!p.armor) {
    p.armor = a;
    events.push(good(`${lead}${armorShortWord(a)}だ。身を守るものがなかった——ありがたく着る。`));
    return;
  }
  dropArmorHere(state, a);
  events.push(`${lead}${armorShortWord(a)}${gearGauge(a.wear)}だ。床に広げた——着替えるなら今だ。`);
}

/** 宝石を得る（深いほど良い石）。持ち帰ればギルドが銀貨に換える */
function gainGem(state: GameState, events: EventLine[], lead: string): void {
  const p = state.player;
  const floor = currentFloor(state);
  const maxDepth = state.instance.floors.length;
  const depthFrac = maxDepth > 1 ? (floor.depth - 1) / (maxDepth - 1) : 0;
  const kind = rollGemKind(state.rng, depthFrac);
  p.gems[kind] = (p.gems[kind] ?? 0) + 1;
  events.push(good(`${lead}${GEM_DATA[kind].name}だ。持ち帰れば、帳場が値をつけてくれる。`));
}

/** 骸から薬を得る（種類は懐を漁って初めて分かる）。袋が一杯なら null（置いていく） */
function gainPotion(state: GameState): PotionKind | null {
  const kind = pickWeighted(state.rng, POTION_DROP);
  const p = state.player;
  if ((p.potions[kind] ?? 0) >= POTION_CAP) return null;
  p.potions[kind] = (p.potions[kind] ?? 0) + 1;
  return kind;
}

function lootCarry(state: GameState, enemy: Entity, events: EventLine[]): void {
  const p = state.player;
  switch (enemy.carry) {
    case 'weapon':
      gainWeapon(
        state,
        {
          kind: 'sword',
          wear: 15 + Math.floor(state.rng.next() * 45),
          bonus: rollGearBonus(state.rng, gearDepthFrac(state)),
        },
        events,
        '奴が引きずっていたのは',
      );
      break;
    case 'potion': {
      const kind = gainPotion(state);
      events.push(
        kind
          ? good(`骸の懐から${POTION_NAMES[kind]}の瓶が転がり出た。`)
          : '骸の懐に薬瓶——だが同じ薬で袋はもう一杯だ。置いていく。',
      );
      break;
    }
    case 'food':
      if (p.food >= FOOD_CAP) {
        events.push('奴の糧袋はまだ食えそうだ。だが、これ以上は担げない。');
      } else {
        p.food++;
        events.push(good('奴が漁っていた糧袋を回収した。まだ食える。'));
      }
      break;
    case 'gem':
      gainGem(state, events, '骸の懐から転がり出たのは');
      break;
    case 'none':
      events.push('骸を検めたが、何も持っていなかった。');
      return;
    case 'treasure':
      p.hasTreasure = true;
      events.push(good('骸の腕の中から、布に包まれた重みを取り上げた。宝だ。あとは、生きて帰るだけだ。'));
      break;
  }
}

/** 打ち合いで受けた傷の言葉（数字は出さない） */
function woundWord(dmg: number): EventLine {
  if (dmg >= 26) return bad('骨まで響く一撃を受けた。');
  if (dmg >= 14) return bad('浅くない傷を受けた。');
  return bad('掠り傷を受けた。');
}

/** 打ち込みの手応えの言葉（削った地力の帯→語は固定） */
function blowWord(blow: number): string {
  if (blow >= 0.24) return '深々と刃が入った。';
  if (blow >= 0.14) return '確かな手応えがあった。';
  return '刃は浅く滑った。';
}

/** 戦い終わり（勝ち・戦死）の計測（§12）。ラベルは最初に刃を合わせた時の読み */
function recordFightEnd(
  state: GameState,
  outcome: 'win' | 'wounded' | 'heavy' | 'death',
): void {
  const pending = state.pending!;
  recordDanger(state.telemetry, {
    turn: state.turn,
    danger_label: pending.engagedLabel ?? pending.assessment.label,
    internal_risk: pending.engagedRisk ?? pending.assessment.internalRisk,
    engaged: true,
    outcome,
  });
}

/**
 * 眠る相手の懐を探る（工夫の勝ち筋）。
 * 成功すれば戦わずに持ち物——主が抱く宝さえ——を抜き取れる。しくじれば目が覚める。
 */
function resolveSteal(state: GameState, events: EventLine[]): void {
  const pending = state.pending!;
  const floor = currentFloor(state);
  const enemy = floor.entities.find((e) => e.id === pending.enemyId)!;
  const p = state.player;
  if ((enemy.sleepTurns ?? 0) <= 0 || enemy.carry === 'none') return;

  // 韋駄天の札で体が軽ければ、指先も速い
  const successP = 0.6 + (p.hasteTurns > 0 ? 0.2 : 0);
  if (state.rng.next() < successP) {
    switch (enemy.carry) {
      case 'treasure':
        p.hasTreasure = true;
        events.push(
          good(
            `眠る${enemy.name}の腕の中から、布に包まれた重みをそっと抜き取った。宝だ。奴が目を覚ます前に、ここを離れろ。`,
          ),
        );
        break;
      case 'weapon':
        gainWeapon(
          state,
          {
            kind: 'sword',
            wear: 15 + Math.floor(state.rng.next() * 45),
            bonus: rollGearBonus(state.rng, gearDepthFrac(state)),
          },
          events,
          '眠る相手が抱えていたのは',
        );
        break;
      case 'potion': {
        const kind = gainPotion(state);
        events.push(
          kind
            ? good(`眠る${enemy.name}の懐から${POTION_NAMES[kind]}の瓶を抜き取った。`)
            : '懐の瓶に指が触れた——だが同じ薬で袋は一杯だ。そっと戻す。',
        );
        break;
      }
      case 'food':
        if (p.food >= FOOD_CAP) {
          events.push('糧袋に手が届いた。だが、これ以上は担げない。');
        } else {
          p.food++;
          events.push(good(`眠る${enemy.name}の脇から糧袋を引き抜いた。`));
        }
        break;
      case 'gem':
        gainGem(state, events, '眠る相手の懐で光っていたのは');
        break;
    }
    enemy.carry = 'none';
    state.pending = null;
    state.phase = 'explore';
    advanceTurn(state, events, 0.8, 0.8);
    if (state.phase !== 'explore') return;
    processEnemies(state, events, enemy.id);
    if (state.phase === 'explore') look(state, events);
    return;
  }

  // しくじった——目が覚める（眠りの分の危険度の割引が消える）
  enemy.sleepTurns = 0;
  enemy.chasing = true;
  enemy.lastSeen = { ...state.pos };
  events.push(bad(`指先が触れた瞬間、${enemy.name}の目が開いた。`));
  advanceTurn(state, events, 0.8, 0.8);
  if (state.phase === 'dead') return;
  const before = pending.assessment.label;
  pending.assessment = assessDanger(
    p,
    enemy,
    state.instance.character,
    nearbyOthers(state, enemy.id),
  );
  events.push(
    pending.assessment.label === before
      ? `（危険度：${before}のまま）`
      : `（危険度：${before} → ${pending.assessment.label}）`,
  );
}

/**
 * 遭遇中に薬を呷る・糧食を齧る。回復は打ち合いの最中でも選べる——
 * ただし一手は一手。その隙に相手は踏み込んでくる（眠っていれば別だ）
 */
function resolveEncounterConsume(
  state: GameState,
  events: EventLine[],
  action: { type: 'drinkPotion'; kind: PotionKind } | { type: 'eat' },
): void {
  const pending = state.pending!;
  const floor = currentFloor(state);
  const enemy = floor.entities.find((e) => e.id === pending.enemyId)!;
  const p = state.player;

  if (action.type === 'eat') {
    if (p.food <= 0) return;
    p.food--;
    p.hunger = Math.max(0, p.hunger - 40);
    events.push('相手から目を離さず、乾いた糧食を口に押し込んだ。');
  } else {
    if ((p.potions[action.kind] ?? 0) <= 0) return;
    applyPotionEffect(state, action.kind, events);
  }

  // 呷る隙に、相手は動く
  if ((enemy.sleepTurns ?? 0) <= 0) {
    const profile = combatProfile(p, enemy, state.instance.character);
    if (state.rng.next() < enemyHitChance(enemy.strength, profile)) {
      const dmg = rollEnemyDamage(enemy.strength, profile, state.rng);
      p.condition -= dmg;
      events.push(bad(`その隙に${enemy.name}が踏み込んできた。`));
      events.push(woundWord(dmg));
      wearArmor(state, 2 + Math.floor(state.rng.next() * 4), events);
      if (p.condition <= 0) {
        if (pending.rounds > 0) recordFightEnd(state, 'death');
        die(state, events, `${enemy.name}を前にして、悠長すぎた。`);
        return;
      }
    } else {
      events.push(`${enemy.name}が踏み込んでくる——身を捻ってかわした。`);
    }
  }

  advanceTurn(state, events, 0.8, 0.8);
  if (state.phase === 'dead') {
    if (pending.rounds > 0) recordFightEnd(state, 'death');
    return;
  }
  processEnemies(state, events, enemy.id, true);
  if ((state.phase as GamePhase) === 'dead') return;

  const before = pending.assessment.label;
  pending.assessment = assessDanger(
    p,
    enemy,
    state.instance.character,
    nearbyOthers(state, enemy.id),
  );
  events.push(
    pending.assessment.label === before
      ? `（危険度：${before}のまま）`
      : `（危険度：${before} → ${pending.assessment.label}）`,
  );
}

/** 相手が倒れた。戦果の整理と、平時への復帰 */
function finishFight(state: GameState, events: EventLine[], enemy: Entity): void {
  const pending = state.pending!;
  const p = state.player;
  const lost = (pending.conditionAtStart ?? p.condition) - p.condition;
  const outcome = lost >= HEAVY_LOSS ? 'heavy' : lost > 10 ? 'wounded' : 'win';
  if (outcome === 'heavy') events.push(bad('勝ちはした。だが深手を負った。'));
  recordFightEnd(state, outcome);
  lootCarry(state, enemy, events);
  state.pending = null;
  state.phase = 'explore';
  advanceTurn(state, events, 1.5, 1.5);
  if (p.condition <= 0) {
    die(state, events, '戦いの傷が深すぎた。'); // die側で二重死亡を防いでいる
    return;
  }
  processEnemies(state, events); // 戦っている間にも、他の何かは近づいてくる
  if (state.phase === 'explore') look(state, events);
}

/**
 * 1ラウンドの打ち合い（ターン制戦闘）。
 * こちらの打ち込み→（相手が生きていれば）反撃→形勢の読み直し。
 * 「挑む」は一手ごとの選択になった——深手を負ってから退くか、粘るかは毎ラウンド選べる。
 */
function resolveEngage(state: GameState, events: EventLine[]): void {
  const pending = state.pending!;
  const floor = currentFloor(state);
  const enemy = floor.entities.find((e) => e.id === pending.enemyId)!;
  const p = state.player;
  const profile = combatProfile(p, enemy, state.instance.character);
  const sleeping = (enemy.sleepTurns ?? 0) > 0;

  if (pending.rounds === 0) {
    // 最初に刃を合わせた時の読みが、この賭けのラベル（計測§12もこの読みで行う）
    pending.engagedLabel = pending.assessment.label;
    pending.engagedRisk = pending.assessment.internalRisk;
    pending.conditionAtStart = p.condition;
    events.push(
      sleeping
        ? `あなたは眠りこける${enemy.name}に刃を立てた。`
        : `あなたは${enemy.name}に打ちかかった。`,
    );
  }
  pending.rounds++;

  const r = fightRound(profile, enemy.strength, state.rng, sleeping);
  enemy.sleepTurns = 0; // 刃を受ければ、眠りは終わる
  enemy.strength = Math.max(0, enemy.strength - r.blowDamage);
  wearWeapon(state, 3 + Math.floor(state.rng.next() * 5), events);

  if (r.enemyDead) {
    enemy.alive = false;
    events.push(`${enemy.name}は動かなくなった。`);
    finishFight(state, events, enemy);
    return;
  }

  events.push(blowWord(r.blowDamage));
  if (enemy.strength <= 0.15) events.push(`${enemy.name}はもう立っているのがやっとだ。`);

  if (r.playerHit) {
    p.condition -= r.playerDamage;
    events.push(woundWord(r.playerDamage));
    wearArmor(state, 2 + Math.floor(state.rng.next() * 4), events);
    if (p.condition <= 0) {
      recordFightEnd(state, 'death');
      die(
        state,
        events,
        `あなたは「${pending.engagedLabel}」とみた${enemy.name}に挑み、敗北した。`,
      );
      return;
    }
  } else if (sleeping) {
    events.push(`${enemy.name}が跳ね起きた。もう不意は打てない。`);
  } else {
    events.push('反撃は空を切った。');
  }

  advanceTurn(state, events, 1, 1);
  if (state.phase === 'dead') {
    // 毒・飢えが打ち合いの最中に尽きた
    recordFightEnd(state, 'death');
    return;
  }

  // 乱戦: 打ち合いの間にも、他の何かは動いている。隣まで来れば横槍が飛ぶ
  processEnemies(state, events, enemy.id, true);
  if ((state.phase as GamePhase) === 'dead') return; // 横槍に倒れた（記録はsideAttack内で済み）

  // 形勢を読み直す——ラベルの変化がそのまま戦況になる（近づく影も織り込む）
  const before = pending.assessment.label;
  pending.assessment = assessDanger(
    p,
    enemy,
    state.instance.character,
    nearbyOthers(state, enemy.id),
  );
  events.push(
    pending.assessment.label === before
      ? `（危険度：${before}のまま）`
      : `（危険度：${before} → ${pending.assessment.label}）`,
  );
}

function resolveRetreat(state: GameState, events: EventLine[]): void {
  const pending = state.pending!;
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const enemy = floor.entities.find((e) => e.id === pending.enemyId)!;
  const risk = pending.assessment.internalRisk;

  // 実際に1歩後退して距離を作る（相手はこのターン動かない＝逃げる猶予が生まれる）
  const options = orthNeighbors(state.pos).filter(
    (p) => isWalkable(floor, p) && !enemyAt(floor, p),
  );
  let best: Vec | null = null;
  let bestDist = chebDist(state.pos, enemy.pos);
  for (const o of shuffle(state.rng, options)) {
    const d = chebDist(o, enemy.pos);
    if (d > bestDist) {
      best = o;
      bestDist = d;
    }
  }
  if (best) {
    state.pos = best;
    know.walked.add(key(best));
    know.seen.add(key(best));
    events.push(`あなたは${enemy.name}から目を離さず、後ずさって距離を取った。`);
  } else {
    events.push(`下がる場所がない。壁を背に、${enemy.name}と睨み合う。`);
  }

  // 韋駄天の札: 体が軽いうちの離脱は無傷（眠っている相手も追い打ちできない）
  const cleanBreak = state.player.hasteTurns > 0 || (enemy.sleepTurns ?? 0) > 0;
  // 背を向ける瞬間は、相手がどれほど弱っていても無防備だ（最低確率を持つ）。
  // 下がる場所のない壁際からの離脱は、なおさら高くつく
  const partingChance = (best ? 0.08 : 0.25) + risk * 0.3;
  if (!cleanBreak && state.rng.next() < partingChance) {
    const dmg = 6 + Math.floor(state.rng.next() * 10);
    state.player.condition -= dmg;
    events.push(bad('離れ際、鋭い痛みが走った。'));
    recordDanger(state.telemetry, {
      turn: state.turn,
      danger_label: pending.assessment.label,
      internal_risk: risk,
      engaged: false,
      outcome: 'retreatHit',
    });
  } else {
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
  advanceTurn(state, events, 0.8, 1);
  if (state.player.condition <= 0) {
    die(state, events, '逃げ切れはした。だが傷は深すぎた。');
    return;
  }
  // 退却した相手（holdId）は踏み込んでこないが、他の敵は動く
  processEnemies(state, events, enemy.id);
  if (state.phase === 'explore') look(state, events);
}

// ---- 移動とタイルイベント ----

function stepOnTile(state: GameState, events: EventLine[]): void {
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
          events.push(bad('足元で乾いた音がした——毒の棘だ。痺れが脚を這い上がってくる。'));
        } else {
          events.push('床に朽ちた仕掛けの残骸がある。もう動かない。');
        }
        break;
      case 'spring':
        // 飲むかどうかは選択（見た目では良い水か悪い水か分からない）
        events.push('泉が湧いている。水面は静かで、覗き込んでも底の色は読めない。');
        break;
      case 'driedSpring':
        events.push('泉の跡がある。だが水は涸れて久しい。底に乾いた泥だけが残っている。');
        break;
      case 'chest':
        if (!f.opened) {
          events.push('古い木の箱が置かれている。留め金は錆びているが、蓋は閉じたままだ。');
        } else {
          events.push('開け放たれた箱がある。中はもう検分済みだ。');
        }
        break;
      case 'treasure':
        if (!f.taken) {
          f.taken = true;
          p.hasTreasure = true;
          events.push(good('石台の上に、それはあった。井戸の底の宝だ。あとは、生きて帰るだけだ。'));
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
    if (item.kind === 'food') {
      if (p.food >= FOOD_CAP) {
        events.push('乾いた糧食が落ちている。だが、これ以上は担げない。');
      } else {
        item.taken = true;
        p.food++;
        events.push(good('乾いた糧食が落ちている。まだ食べられそうだ。'));
      }
    } else if (item.kind === 'potion') {
      const kind = item.potionKind ?? 'murk';
      if ((p.potions[kind] ?? 0) >= POTION_CAP) {
        events.push('薬瓶が落ちている。だが同じ薬で袋はもう一杯だ。');
      } else {
        item.taken = true;
        p.potions[kind] = (p.potions[kind] ?? 0) + 1;
        events.push(
          good(
            kind === 'murk'
              ? '濁り薬の瓶を拾った。中身は振ってみても分からない。'
              : `${POTION_NAMES[kind]}の瓶を拾った。銘はまだ読める。`,
          ),
        );
      }
    } else if (item.kind === 'stone') {
      if (p.stones >= STONE_CAP) {
        events.push('手頃な石がある。だが袋は石でもう膨れ切っている。');
      } else {
        item.taken = true;
        p.stones++;
        events.push(good('手頃な石を拾った。投げるにはちょうどいい。'));
      }
    } else if (item.kind === 'gem' && item.gemKind) {
      item.taken = true;
      p.gems[item.gemKind] = (p.gems[item.gemKind] ?? 0) + 1;
      events.push(good(`土に半ば埋もれた${GEM_DATA[item.gemKind].name}を掘り出した。持ち帰れば銀貨になる。`));
    } else if (item.kind === 'talisman' && item.pattern) {
      item.taken = true;
      p.talismans[item.pattern] = (p.talismans[item.pattern] ?? 0) + 1;
      events.push(good(`${item.pattern}の札が落ちている。模様の意味までは読めない。`));
    } else if (item.kind === 'weapon') {
      item.taken = true;
      if (item.broken) {
        events.push('剣だ——だが手に取ると、刃は錆びて根元から折れた。使い物にならない。');
      } else {
        // 自分で置いていった得物は実体ごと拾い直せる
        const gear = item.weaponGear ?? {
          kind: 'sword' as const,
          wear: 25 + Math.floor(state.rng.next() * 35),
          bonus: rollGearBonus(state.rng, gearDepthFrac(state)),
        };
        gainWeapon(state, gear, events, item.weaponGear ? '置かれていたのは' : '床に落ちていたのは');
      }
    } else if (item.kind === 'armor') {
      // 鎧は担いで歩けない。裸なら着る。着ていれば中身を検分し、「着替える」行動に委ねる
      if (!p.armor) {
        item.armorGear ??= rollArmorGear(state);
        item.taken = true;
        gainArmor(state, item.armorGear, events, '土埃を払うと、それは');
      } else {
        item.armorGear ??= rollArmorGear(state);
        events.push(
          `${armorShortWord(item.armorGear)}${gearGauge(item.armorGear.wear)}が打ち捨てられている。着替えるなら、ここでだ。`,
        );
      }
    }
  }
}

function doMove(state: GameState, dir: Dir, events: EventLine[]): void {
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
  advanceTurn(state, events, 0.8, 1.2);
  if (state.phase !== 'explore') return;
  stepOnTile(state, events);
  if (state.player.condition <= 0) {
    die(state, events, '毒の仕掛けが最後の一押しになった。');
    return;
  }
  look(state, events);
}

// ---- 耳を澄ます（気配情報の生成。§6.1 sense帯） ----

function doListen(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  // まだ見えていない近くの対象を探す
  type Target = { pos: Vec; kind: 'enemy' | 'trap' | 'spring'; enemyKind?: string; enemyId?: string };
  const targets: Target[] = [];
  for (const e of floor.entities) {
    // 敵は動くので「いま見えていない」ものが気配の対象（箱に潜むものは音を立てない）
    if (e.alive && !e.dormant && !state.visibleNow.has(key(e.pos)))
      targets.push({ pos: e.pos, kind: 'enemy', enemyKind: e.kind, enemyId: e.id });
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
    const cue = drawCue(state.rng, 'sense', internalP);
    state.senses.push({
      id: `s${state.senseSeq}`,
      source: 'sense',
      internalP,
      kind: (reportedKind === 'nothing' ? 'spring' : reportedKind) as Claim['kind'],
      floorDepth: floor.depth,
      claimedPos: t.pos,
      text,
      cue,
      held,
      missPattern,
      actualPos: t.pos,
      actualKind: t.kind,
      aboutEnemyId: t.enemyId, // 敵は動くため、位置ではなく本体で検証する
      verified: false,
    });
    events.push(`${text}（気配——${cue}）`);
  }

  advanceTurn(state, events, 0.6, 0.8);
}

// ---- 箱と水（不可逆な賭け。§「検証行為そのものがリスク」） ----

function doDrink(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const f = featureAt(floor, state.pos);
  if (!f || f.kind !== 'spring') return;
  const p = state.player;
  if (f.badWater) {
    p.condition -= 10;
    p.poisonTurns = 4;
    events.push(bad('一口含んで吐き出した。遅かった——舌を刺すほど苦い。悪い水だ。'));
  } else {
    p.condition = Math.min(100, p.condition + 20);
    p.hunger = Math.max(0, p.hunger - 20);
    f.uses = (f.uses ?? 0) + 1;
    if (f.uses >= 2) {
      f.kind = 'driedSpring';
      events.push(good('澄んだ水で喉を潤した。……最後の一口で水脈は細り、泉は涸れた。'));
    } else {
      events.push(good('冷たく澄んだ水だ。体の芯が少し軽くなった。'));
    }
  }
  verifyDecisionClaimsAt(state, state.pos, events);
  if (p.condition <= 0) {
    die(state, events, '悪い水が、最後の一押しになった。');
    return;
  }
  advanceTurn(state, events, 0, 0.5);
}

function doOpen(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const f = featureAt(floor, state.pos);
  if (!f || f.kind !== 'chest' || f.opened) return;
  const p = state.player;
  f.opened = true;
  switch (f.chestContent) {
    case 'weapon':
      gainWeapon(
        state,
        {
          kind: 'sword',
          wear: 10 + Math.floor(state.rng.next() * 35),
          bonus: rollGearBonus(state.rng, gearDepthFrac(state)),
        },
        events,
        '箱の中にあったのは油紙に包まれた',
      );
      break;
    case 'armor':
      gainArmor(
        state,
        {
          kind: 'chain',
          wear: 15 + Math.floor(state.rng.next() * 40),
          bonus: rollGearBonus(state.rng, gearDepthFrac(state)),
        },
        events,
        '箱の底に畳まれていたのは',
      );
      break;
    case 'potion': {
      const kind = gainPotion(state);
      events.push(
        kind
          ? good(`箱の中に${POTION_NAMES[kind]}の瓶が収まっていた。当たりだ。`)
          : '箱の中に薬瓶——当たりだが、同じ薬で袋はもう一杯だ。置いていく。',
      );
      break;
    }
    case 'food':
      if (p.food >= FOOD_CAP) {
        events.push('箱の中に蝋引きの包み——糧食だ。だが、これ以上は担げない。');
      } else {
        p.food++;
        events.push(good('箱の中に蝋引きの包み——糧食だ。当たりだ。'));
      }
      break;
    case 'gem':
      gainGem(state, events, '箱の底で鈍く光っているのは');
      break;
    case 'talisman': {
      const patterns = Object.keys(state.instance.talismanLore);
      const pattern = pick(state.rng, patterns);
      p.talismans[pattern] = (p.talismans[pattern] ?? 0) + 1;
      events.push(good(`箱の中に${pattern}の札が収められていた。模様の意味までは読めない。`));
      break;
    }
    case 'treasure':
      p.hasTreasure = true;
      events.push(good('布に包まれた重み——宝だ。この箱だったのか。あとは、生きて帰るだけだ。'));
      break;
    case 'needle':
      p.condition -= 14;
      p.poisonTurns = 3;
      events.push(bad('蓋を開けた瞬間、留め金の奥で針が跳ねた。指先から痺れが這い上がる。'));
      break;
    case 'mimic': {
      const mimic = floor.entities.find(
        (e) => e.dormant && e.alive && e.pos.x === state.pos.x && e.pos.y === state.pos.y,
      );
      events.push('蓋を開けた——箱の底が、濡れた口のように開いた。');
      verifyDecisionClaimsAt(state, state.pos, events);
      if (mimic) {
        mimic.dormant = false;
        mimic.chasing = true;
        mimic.lastSeen = { ...state.pos };
        startEncounter(state, mimic, events, '箱に潜んでいたものが躍りかかってくる！');
      }
      return; // 遭遇へ（ターンは遭遇解決側で進む）
    }
    case 'empty':
      events.push('箱は空だった。底に埃と、誰かが漁った跡だけがある。');
      break;
  }
  verifyDecisionClaimsAt(state, state.pos, events);
  if (p.condition <= 0) {
    die(state, events, '箱に仕込まれた針が、最後の一押しになった。');
    return;
  }
  advanceTurn(state, events, 0.5, 0.5);
}

/** 調べる: 箱・泉の安全性について、気配帯（p=0.6-0.8）の見立てを自力生成する */
function doInspect(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const f = featureAt(floor, state.pos);
  if (!f || (f.kind !== 'chest' && f.kind !== 'spring')) return;

  const already = state.senses.some(
    (s) =>
      !s.verified &&
      s.source === 'sense' &&
      (s.kind === 'chest' || s.kind === 'spring') &&
      s.actualPos?.x === state.pos.x &&
      s.actualPos?.y === state.pos.y,
  );
  if (already) {
    events.push('もう一度眺めてみたが、見立ては変わらない。');
    advanceTurn(state, events, 0.3, 0.3);
    return;
  }

  const isChest = f.kind === 'chest';
  // 安全＝針・ミミック・悪い水ではない（空の箱は「危険はない」＝見立てでは空と分からない）
  const actuallySafe = isChest
    ? f.chestContent !== 'needle' && f.chestContent !== 'mimic'
    : !f.badWater;

  const internalP = drawInternalP(state.rng, 'sense');
  const resolution = resolveInfo(state.rng, internalP, ['misread']);
  const reportedSafe = resolution.held ? actuallySafe : !actuallySafe;

  const text = isChest
    ? reportedSafe
      ? '埃の積もり方は自然だ。仕掛けの気配はしない。'
      : '蝶番のあたりに、細工めいた違和感がある。'
    : reportedSafe
      ? '水は澄んでいて、嫌な匂いはしない。'
      : 'かすかに苦い匂いが鼻をつく。';

  state.senseSeq++;
  const cue = drawCue(state.rng, 'sense', internalP);
  state.senses.push({
    id: `s${state.senseSeq}`,
    source: 'sense',
    internalP,
    kind: isChest ? 'chest' : 'spring',
    floorDepth: floor.depth,
    claimedPos: { ...state.pos },
    text,
    cue,
    held: resolution.held,
    missPattern: resolution.held ? undefined : resolution.missPattern,
    actualPos: { ...state.pos },
    actualKind: isChest ? `chest_${f.chestContent}` : f.badWater ? 'badSpring' : 'goodSpring',
    assertedSafety: reportedSafe ? 'good' : 'bad',
    verified: false,
  });
  events.push(`${text}（見立て——${cue}）`);
  advanceTurn(state, events, 0.5, 0.5);
}

// ---- その他の行動 ----

/** 荷を検める: 落ち着いている時に1ターン使えば、数はもう見失わない（観測は事実＝数字を出してよい） */
function doCheckPack(state: GameState, events: EventLine[]): void {
  const p = state.player;
  state.counted = true;
  const parts: string[] = [];
  if (p.stones > 0) parts.push(`石が${p.stones}`);
  if (p.food > 0) parts.push(`糧食が${p.food}`);
  for (const [kind, count] of Object.entries(p.potions)) {
    if (count > 0) parts.push(`${POTION_NAMES[kind] ?? '薬'}が${count}`);
  }
  if (p.fireOil > 0) parts.push(`火油の瓶が${p.fireOil}`);
  for (const [pattern, count] of Object.entries(p.talismans)) {
    if (count > 0) parts.push(`${pattern}の札が${count}`);
  }
  parts.push(p.spareTorches > 0 ? `予備の松明が${p.spareTorches}本` : '予備の松明はなし');
  events.push(`腰を下ろして荷を検めた。${parts.join('、')}。数はもう頭に入っている。`);
  advanceTurn(state, events, 0.5, 0.5);
}

/** 腰の得物に持ち替える。手にしていたものは腰に戻る */
function doEquipWeapon(state: GameState, index: number, events: EventLine[]): void {
  const p = state.player;
  const w = p.weapons[index];
  if (!w) return;
  p.weapons.splice(index, 1);
  p.weapons.unshift(w);
  events.push(`${weaponWord(w)}を手に馴染ませる。`);
  advanceTurn(state, events, 0.8, 0.8);
}

/** 足元に広げられた鎧に着替える。着ていたものはその場に残す */
function doEquipArmor(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const item = itemAt(floor, state.pos);
  if (!item || item.kind !== 'armor') return;
  item.armorGear ??= rollArmorGear(state);
  const gear = item.armorGear;
  item.taken = true;
  const old = state.player.armor;
  state.player.armor = gear;
  if (old) dropArmorHere(state, old);
  events.push(
    good(`${armorShortWord(gear)}に着替えた。${old ? `${armorShortWord(old)}はその場に残した。` : ''}`),
  );
  advanceTurn(state, events, 1.5, 1);
}

/** 休息で戻せる体調の上限。深い傷は迷宮の中では塞がらない（薬と泉だけが超えられる） */
const REST_CAP = 70;

function doRest(state: GameState, events: EventLine[]): void {
  const p = state.player;
  // 空腹だと休んでも回復しない（空腹・装備が効く、の学習材料 §7）
  if (p.hunger >= 100) {
    events.push('壁に背を預けた。だが飢えで眠れず、体は少しも休まらない。');
  } else if (p.condition >= REST_CAP) {
    events.push('壁に背を預けて休んだ。浅い傷は落ち着いたが、深い疲れは地上でなければ抜けない。');
  } else if (p.hunger >= 80) {
    p.condition = Math.min(REST_CAP, p.condition + 6);
    events.push('短く休んだ。腹の虫が鳴って、眠りは浅い。');
  } else {
    p.condition = Math.min(REST_CAP, p.condition + 10);
    events.push(good('壁に背を預け、短く休んだ。傷に当て布をし、水を口に含む。'));
  }
  // 鎧は直せない——裂けた革は裂けたままだ。管理は買い替えと拾い替えで行う
  advanceTurn(state, events, 3, 2);
}

/** 薬の効き目（薬効はここだけに置く。ターン進行・敵の反応は呼び出し側の責務） */
function applyPotionEffect(state: GameState, kind: PotionKind, events: EventLine[]): void {
  const p = state.player;
  if ((p.potions[kind] ?? 0) <= 0) return;
  p.potions[kind]--;

  if (kind === 'murk') {
    // 濁り薬は素性の分からない賭け。大きく当たるか、何も起きないか、悪いものか
    const sub = state.rng.next();
    if (sub < 0.3) {
      p.condition = Math.min(100, p.condition + 45);
      events.push(good('濁り薬を呷った。驚くほど効いた——傷の熱が一気に引いていく。'));
    } else if (sub < 0.55) {
      p.condition = Math.min(100, p.condition + 12);
      events.push('濁り薬を飲んだ。鈍いが、効いてはいるようだ。');
    } else if (sub < 0.8) {
      events.push('濁り薬を飲んだ。……何も起きない。ただの濁り水だったのか。');
    } else {
      p.condition -= 8;
      p.poisonTurns = 2;
      events.push(bad('濁り薬を飲んだ。腹の奥が焼けるように痛む。悪いものだったらしい。'));
    }
    return;
  }

  // 性格: 薬効の不安定さ（potionInstability）——銘のある薬でも、土地の水は染みる
  const unstable = state.rng.next() < state.instance.character.biases.potionInstability * 0.45;
  const potency = unstable ? (state.rng.next() < 0.5 ? 0.5 : 0) : 1;
  switch (kind) {
    case 'salve':
      if (potency === 0) {
        events.push('傷薬を飲んだ。……薬効が抜けている。何も起きない。');
      } else {
        p.condition = Math.min(100, p.condition + Math.round(26 * potency));
        events.push(
          good(potency === 1 ? '傷薬が染みわたる。傷の熱が引いていく。' : '傷薬を飲んだ。効きは鈍いが、少し楽になった。'),
        );
      }
      break;
    case 'elixir':
      if (potency === 0) {
        events.push('霊薬のはずだった。だが香りが飛んでいる。何も起きない。');
      } else {
        p.condition = Math.min(100, p.condition + Math.round(55 * potency));
        if (potency === 1) {
          p.poisonTurns = 0;
          events.push(good('霊薬が喉を焼き、傷が見る間に塞がっていく。毒気まで洗われた。'));
        } else {
          events.push(good('霊薬の効きが鈍い。それでも、傷はいくらか軽くなった。'));
        }
      }
      break;
    case 'antidote':
      if (potency === 0) {
        events.push('解毒薬を飲んだが、舌に残るのは水の味だけだ。');
      } else if (p.poisonTurns > 0) {
        p.poisonTurns = 0;
        p.condition = Math.min(100, p.condition + 6);
        events.push(good('苦い解毒薬が、血の中の毒を洗い流した。'));
      } else {
        p.condition = Math.min(100, p.condition + 4);
        events.push('解毒薬を飲んだ。毒はないが、腹の底が少し温まった。');
      }
      break;
    case 'tonic':
      if (potency === 0) {
        events.push('滋養薬を飲んだが、水のように薄い。誰かが薄めたか。');
      } else {
        p.hunger = Math.max(0, p.hunger - Math.round(45 * potency));
        p.condition = Math.min(100, p.condition + Math.round(8 * potency));
        events.push(good('滋養薬は重く甘い。腹の底に力が戻ってくる。'));
      }
      break;
  }
}

function doDrinkPotion(state: GameState, kind: PotionKind, events: EventLine[]): void {
  if ((state.player.potions[kind] ?? 0) <= 0) return;
  applyPotionEffect(state, kind, events);
  advanceTurn(state, events, 0.5, 0.5);
}

function doEat(state: GameState, events: EventLine[]): void {
  const p = state.player;
  p.food--;
  p.hunger = Math.max(0, p.hunger - 40);
  events.push(good('乾いた糧食をかじった。味は薄いが、腹は落ち着いた。'));
  advanceTurn(state, events, 0, 0.5);
}

/**
 * 大地の編み直し: 一度離れた階に戻ると、空いた巣にまた何かが棲みついていることがある。
 * 「ひとつ前の階へ戻って休む」は選べるが、無料の安全地帯ではなくなる
 */
function maybeReweave(state: GameState, events: EventLine[]): void {
  if (!state.visitedFloors.has(state.floorIndex)) {
    state.visitedFloors.add(state.floorIndex);
    return;
  }
  if (state.rng.next() >= 0.65) return;
  const floor = currentFloor(state);
  const maxDepth = state.instance.floors.length;
  const depthFrac = gearDepthFrac(state);
  const count = depthFrac > 0.5 && state.rng.next() < 0.25 ? 2 : 1;
  let spawned = 0;
  for (const c of shuffle(state.rng, floorCells(floor))) {
    if (spawned >= count) break;
    if (chebDist(c, state.pos) < 6) continue; // 目の前には湧かない（視界は嘘をつかない）
    if (!isWalkable(floor, c) || featureAt(floor, c) || enemyAt(floor, c) || itemAt(floor, c))
      continue;
    state.respawnSeq++;
    floor.entities.push(
      makeEnemy(
        state.instance.character,
        floor.depth,
        maxDepth,
        state.rng,
        c,
        `e${floor.depth}-r${state.respawnSeq}`,
      ),
    );
    spawned++;
  }
  if (spawned > 0) {
    events.push('空気が前と違う。大地は編み直され、空いた巣にはまた何かが棲みつく。');
  }
}

function doDescend(state: GameState, events: EventLine[]): void {
  state.floorIndex++;
  state.deepestVisited = Math.max(state.deepestVisited, state.floorIndex + 1);
  const floor = currentFloor(state);
  const up = floor.features.find((f) => f.kind === 'stairsUp')!;
  state.pos = { ...up.pos };
  const know = state.knowledge[state.floorIndex];
  know.walked.add(key(state.pos));
  events.push(`階段を降りる。地下${floor.depth}階。空気が重くなった。`);
  state.senses = state.senses.filter((s) => !s.verified && s.floorDepth === floor.depth);
  maybeReweave(state, events);
  advanceTurn(state, events, 1.5, 2);
  if (state.phase === 'explore') look(state, events);
}

function doAscend(state: GameState, events: EventLine[]): void {
  const floor = currentFloor(state);
  const up = featureAt(floor, state.pos)!;
  if (up.crumbling) {
    // 性格: 下層ほど帰還困難（lowerReturnDifficulty）
    state.player.condition -= 8;
    events.push(bad('崩れかけた階段をよじ登る。足場が二度抜け、膝を打った。'));
  } else {
    events.push('階段を上る。');
  }
  state.floorIndex--;
  const upper = currentFloor(state);
  const down = upper.features.find((f) => f.kind === 'stairsDown')!;
  state.pos = { ...down.pos };
  state.knowledge[state.floorIndex].walked.add(key(state.pos));
  events.push(`地下${upper.depth}階に戻ってきた。`);
  maybeReweave(state, events);
  advanceTurn(state, events, 1.5, 2);
  if (state.player.condition <= 0) {
    die(state, events, '崩れた階段が、最後の体力を奪った。');
    return;
  }
  if (state.phase === 'explore') look(state, events);
}

// ---- ステップ（1ターン処理 §11） ----

export function step(state: GameState, action: Action): EventLine[] {
  if (state.phase === 'dead' || state.phase === 'escaped') return [];
  const events: EventLine[] = [];
  recordChoice(state.telemetry, { turn: state.turn, action: action.type });

  if (state.phase === 'encounter') {
    if (action.type === 'engage') resolveEngage(state, events);
    else if (action.type === 'retreat') resolveRetreat(state, events);
    else if (action.type === 'steal') resolveSteal(state, events);
    else if (action.type === 'throwStone') resolveThrow(state, events);
    else if (action.type === 'throwFireOil') resolveThrow(state, events, { fireOil: true });
    else if (action.type === 'throwTalisman') resolveThrow(state, events, { pattern: action.pattern });
    else if (action.type === 'drinkPotion' || action.type === 'eat')
      resolveEncounterConsume(state, events, action);
    state.events = events;
    return events;
  }

  const turnBefore = state.turn;
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
    case 'checkPack':
      doCheckPack(state, events);
      break;
    case 'equipWeapon':
      doEquipWeapon(state, action.index, events);
      break;
    case 'equipArmor':
      doEquipArmor(state, events);
      break;
    case 'drinkPotion':
      doDrinkPotion(state, action.kind, events);
      break;
    case 'eat':
      doEat(state, events);
      break;
    case 'drink':
      doDrink(state, events);
      break;
    case 'open':
      doOpen(state, events);
      break;
    case 'inspect':
      doInspect(state, events);
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

  // 敵の行動（ターンが進んだ探索中のみ。階を移った直後のターンは動かない＝降りた瞬間に襲われない）
  if (
    state.turn > turnBefore &&
    state.phase === 'explore' &&
    action.type !== 'descend' &&
    action.type !== 'ascend'
  ) {
    // 立ち止まる行動だったか（移動以外）。立ち止まる隙に追いつかれると初撃を貰う
    state.stoodStill = action.type !== 'move';
    processEnemies(state, events);
    state.stoodStill = false;
    if (state.phase === 'explore') look(state, events);
  }

  state.events = events;
  return events;
}
