// 古地図・噂の生成 §9.3
//
// 考え方: 古地図・メモは「同じ性格の“別インスタンス”に由来する記録」（§5）。
// 実装では §8 の解決アルゴリズムを生成時に適用する:
//   - hold（roll < p）→ 主張を実地形に正確に一致させる
//   - miss → 外れ方を抽選し、「理由の残る形」で主張と実地形をズラす
//     （枯れた泉・崩落・罠の残骸などは実地形側に痕跡として植え込む）
// すべて runSeed 由来の決定論で、プレイ開始前に確定する。
// 「完全な誤情報」だけは別シードの兄弟インスタンスから主張を持ってくる
// （＝本当に“別の潜行の記録”であり、現インスタンスには存在しない）。

import type {
  Claim,
  ClaimKind,
  DungeonInstance,
  Floor,
  InfoSource,
  MissPattern,
  Vec,
} from './types';
import { drawInternalP } from './confidence';
import { generateInstance, featureAt, isConnected, isWalkable, floorCells } from './generate';
import { resolveInfo } from './resolve';
import type { RNG } from './rng';
import { hashSeed, mulberry32, pick, pickWeighted, randInt, shuffle } from './rng';

// ---- 位置の言語化（数字・座標をUIに出さないための曖昧化） ----

/** 位置を「北東のあたり」等の言葉に射影する */
export function posPhrase(floor: Floor, p: Vec): string {
  const xs = p.x < floor.width / 3 ? '西' : p.x >= (floor.width * 2) / 3 ? '東' : '';
  const ys = p.y < floor.height / 3 ? '北' : p.y >= (floor.height * 2) / 3 ? '南' : '';
  const dir = ys + xs;
  return dir === '' ? '中央のあたり' : `${dir}のあたり`;
}

// ---- 文章テンプレ（v0.1はテンプレ文。LLMは後回し §3） ----

function claimText(source: InfoSource, kind: ClaimKind, phrase: string, depth: number): string {
  const t: Record<ClaimKind, Record<string, string>> = {
    spring: {
      oldMap: `${phrase}に泉の印が描かれている。`,
      survivorNote: `「${phrase}の水で命拾いした」と走り書きがある。`,
      deathNote: `「水の匂いがする。${phrase}だ」……メモはそこで乱れている。`,
    },
    enemy: {
      oldMap: `${phrase}に「近寄るな」と書き込みがある。`,
      survivorNote: `「${phrase}で金属の音を聞いた。逃げろ」とある。`,
      deathNote: `「${phrase}に何かいる。音が、止まらない」……最後の記述だ。`,
    },
    trap: {
      oldMap: `${phrase}の床に毒の印が付されている。`,
      survivorNote: `「${phrase}の床は踏むな」と念押しされている。`,
      deathNote: `「足が、痺れて」……${phrase}を指す血の跡がある。`,
    },
    treasure: {
      oldMap: `この階の${phrase}に、宝の印がある。`,
      survivorNote: `「宝は${phrase}。だが持ち帰れなかった」とある。`,
      deathNote: `「見つけた。${phrase}だ。あと少し」……記述はそこまでだ。`,
    },
    passage: {
      oldMap: `${phrase}の道は奥へ抜けられる、と描かれている。`,
      survivorNote: `「${phrase}の道を通って戻れた」とある。`,
      deathNote: `「${phrase}へ走れ。道はあるはずだ」と殴り書きがある。`,
    },
    weapon: {
      oldMap: `${phrase}に剣の印が描かれている。`,
      survivorNote: `「${phrase}に得物を置いてきた。使え」とある。`,
      deathNote: `「武器さえあれば。${phrase}に落としてきた」とある。`,
    },
  };
  const byKind = t[kind];
  const text = byKind[source] ?? byKind.oldMap;
  return `B${depth}F——${text}`;
}

// ---- 外れ方の適用 ----

/** 位置を1〜2マスずらす（盤内に収める。床である必要はない——だからこそ「行ってみたら何もない」が起こる） */
function jitterPos(rng: RNG, floor: Floor, p: Vec): Vec {
  for (let attempt = 0; attempt < 20; attempt++) {
    const dx = randInt(rng, -2, 2);
    const dy = randInt(rng, -2, 2);
    if (dx === 0 && dy === 0) continue;
    const q = { x: p.x + dx, y: p.y + dy };
    if (q.x >= 1 && q.y >= 1 && q.x < floor.width - 1 && q.y < floor.height - 1) return q;
  }
  return { x: Math.max(1, p.x - 1), y: p.y };
}

/** 通路らしい床セル（直線の途中）を1つ探す */
function findCorridorCell(rng: RNG, floor: Floor): Vec | null {
  const cells = shuffle(rng, floorCells(floor));
  for (const c of cells) {
    if (featureAt(floor, c)) continue;
    const n = isWalkable(floor, { x: c.x, y: c.y - 1 });
    const s = isWalkable(floor, { x: c.x, y: c.y + 1 });
    const w = isWalkable(floor, { x: c.x - 1, y: c.y });
    const e = isWalkable(floor, { x: c.x + 1, y: c.y });
    const straightNS = n && s && !w && !e;
    const straightWE = w && e && !n && !s;
    if (straightNS || straightWE) return c;
  }
  return null;
}

/** 階段↔階段（＋宝）の到達性を壊さずに崩落を置けるか確認して置く */
function tryPlantCollapse(floor: Floor, pos: Vec): boolean {
  const anchors = floor.features.filter(
    (f) => f.kind === 'stairsUp' || f.kind === 'stairsDown' || f.kind === 'treasure',
  );
  for (let i = 0; i + 1 < anchors.length; i++) {
    if (!isConnected(floor, anchors[i].pos, anchors[i + 1].pos, pos)) return false;
  }
  floor.features.push({ id: `f${floor.depth}-collapse-${pos.x}-${pos.y}`, kind: 'collapse', pos });
  return true;
}

// ---- 生成本体 ----

type Candidate = { kind: ClaimKind; pos: Vec; enemyId?: string; featureId?: string; itemId?: string };

function collectCandidates(rng: RNG, floor: Floor): Candidate[] {
  const out: Candidate[] = [];
  for (const f of floor.features) {
    if (f.kind === 'spring') out.push({ kind: 'spring', pos: f.pos, featureId: f.id });
    if (f.kind === 'trap') out.push({ kind: 'trap', pos: f.pos, featureId: f.id });
    if (f.kind === 'treasure') out.push({ kind: 'treasure', pos: f.pos, featureId: f.id });
  }
  for (const e of floor.entities) {
    out.push({ kind: 'enemy', pos: e.pos, enemyId: e.id });
  }
  for (const i of floor.items) {
    if (i.kind === 'weapon' && i.pos) out.push({ kind: 'weapon', pos: i.pos, itemId: i.id });
  }
  const corridor = findCorridorCell(rng, floor);
  if (corridor) out.push({ kind: 'passage', pos: corridor });
  return out;
}

/** 情報種別ごとに、意味を成す外れ方の候補（§8） */
const ALLOWED_MISS: Record<ClaimKind, MissPattern[]> = {
  spring: ['drift', 'condition', 'false'],
  enemy: ['drift', 'misread', 'false'],
  trap: ['drift', 'stale', 'false'],
  treasure: ['drift'], // 宝は必ず存在する（勝利条件）。外れは位置ズレのみ
  passage: ['stale'],
  weapon: ['drift', 'condition', 'false'],
};

/**
 * 古地図・生還者メモ・死亡者メモを生成し、当否を解決する。
 * miss の場合は実地形に「理由」を植え込む（インスタンスを変異させる）ため、
 * 必ずプレイ開始前・生成パイプラインの一部として呼ぶこと。
 */
export function applyHearsay(instance: DungeonInstance, runSeed: number): Claim[] {
  const rng = mulberry32(hashSeed(runSeed, 'hearsay'));
  // 兄弟インスタンス: 同じ性格・別シードの「過去の誰かの潜行」。完全な誤情報の出所
  const sibling = generateInstance(instance.character, hashSeed(runSeed, 'sibling'));

  const claims: Claim[] = [];
  let claimNo = 0;

  for (const floor of instance.floors) {
    const candidates = shuffle(rng, collectCandidates(rng, floor));
    // 各階1〜2件。最深階は宝の情報を必ず1件入れる（潜る動機）
    const picked: Candidate[] = [];
    const treasureCand = candidates.find((c) => c.kind === 'treasure');
    if (treasureCand) picked.push(treasureCand);
    for (const c of candidates) {
      if (picked.length >= 2) break;
      if (c === treasureCand) continue;
      picked.push(c);
    }

    for (const cand of picked) {
      claimNo++;
      const source: InfoSource = pickWeighted(rng, [
        ['oldMap', 0.45],
        ['survivorNote', 0.3],
        ['deathNote', 0.25],
      ] as const);
      const internalP = drawInternalP(rng, source);

      // §8 解決: roll < p → hold / それ以外 → 外れ方を抽選（resolve.tsの重みに従う）
      const resolution = resolveInfo(rng, internalP, ALLOWED_MISS[cand.kind]);
      let held = resolution.held;
      let missPattern: MissPattern | undefined = resolution.held
        ? undefined
        : resolution.missPattern;
      let claimedPos: Vec = cand.pos;
      let actualPos: Vec | null = cand.pos;
      let actualKind: string = cand.kind;

      if (!held) {
        switch (missPattern) {
          case 'drift': {
            // 位置が少しズレる: 主張位置をずらす。実物は元の場所に在る
            claimedPos = jitterPos(rng, floor, cand.pos);
            break;
          }
          case 'condition': {
            // 内容は合うが条件が違う: 泉は枯れている / 剣は朽ちている
            if (cand.kind === 'spring' && cand.featureId) {
              const f = floor.features.find((x) => x.id === cand.featureId);
              if (f) f.kind = 'driedSpring';
              actualKind = 'driedSpring';
            } else if (cand.kind === 'weapon' && cand.itemId) {
              const it = floor.items.find((x) => x.id === cand.itemId);
              if (it) {
                it.broken = true;
                it.name = '錆びて折れた剣';
              }
              actualKind = 'brokenWeapon';
            }
            break;
          }
          case 'stale': {
            // 古い情報: 通路は崩れている / 罠はもう朽ちている
            if (cand.kind === 'passage') {
              if (!tryPlantCollapse(floor, cand.pos)) {
                // 到達性を壊すなら崩落は置けない → この情報は結果的に正しい
                held = true;
                missPattern = undefined;
              } else {
                actualKind = 'collapse';
              }
            } else if (cand.kind === 'trap' && cand.featureId) {
              const f = floor.features.find((x) => x.id === cand.featureId);
              if (f) f.triggered = true; // 発動済み＝朽ちた残骸
              actualKind = 'brokenTrap';
            }
            break;
          }
          case 'misread': {
            // 主観の誤認: 「金属音」は敵ではなく罠だった（§8の例そのまま）
            if (cand.kind === 'enemy' && cand.enemyId) {
              const e = floor.entities.find((x) => x.id === cand.enemyId);
              if (e) {
                e.alive = false; // 敵は最初から存在しない（誤認だった）
                floor.features.push({
                  id: `f${floor.depth}-misread-${claimNo}`,
                  kind: 'trap',
                  pos: e.pos,
                });
              }
              actualKind = 'trap';
            }
            break;
          }
          case 'false': {
            // 完全な誤情報（稀）: 兄弟インスタンス（別の潜行）由来の主張。
            // 現インスタンスの同種の実物と偶然重ならない位置を選ぶ（重なると「誤情報」でなくなる）
            const sibFloor = sibling.floors[Math.min(floor.depth - 1, sibling.floors.length - 1)];
            const sibCells = shuffle(rng, floorCells(sibFloor));
            const collides = (p: Vec): boolean => {
              const f = floor.features.find((x) => x.pos.x === p.x && x.pos.y === p.y);
              const e = floor.entities.find((x) => x.alive && x.pos.x === p.x && x.pos.y === p.y);
              if (cand.kind === 'spring') return f?.kind === 'spring';
              if (cand.kind === 'trap') return f?.kind === 'trap';
              if (cand.kind === 'enemy') return e !== undefined;
              if (cand.kind === 'weapon')
                return floor.items.some((i) => i.kind === 'weapon' && i.pos?.x === p.x && i.pos?.y === p.y);
              return false;
            };
            claimedPos = sibCells.find((p) => !collides(p)) ?? pick(rng, sibCells);
            actualPos = null;
            actualKind = 'nothing';
            break;
          }
        }
      }

      claims.push({
        id: `c${claimNo}`,
        source,
        internalP,
        kind: cand.kind,
        floorDepth: floor.depth,
        claimedPos,
        text: claimText(source, cand.kind, posPhrase(floor, claimedPos), floor.depth),
        held,
        missPattern,
        actualPos,
        actualKind,
        verified: false,
      });
    }
  }

  return claims;
}
