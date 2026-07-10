// 古地図・噂の生成 §9.3
//
// 考え方: 古地図・メモは「同じ性格の“別インスタンス”に由来する記録」（§5）。
// 実装では §8 の解決アルゴリズムを生成時に適用する:
//   - hold（roll < p）→ 主張を実態に正確に一致させる
//   - miss → 外れ方を抽選し、「理由の残る形」で主張と実態をズラす
//     （枯れた泉・悪い水・漁られた箱・崩落・罠の残骸などは実態側に痕跡として植え込む）
// すべて runSeed 由来の決定論で、プレイ開始前に確定する。
// 「完全な誤情報」だけは別シードの兄弟インスタンスから主張を持ってくる
// （＝本当に“別の潜行の記録”であり、現インスタンスには存在しない）。
//
// v0.2: 記録の主役は「宝箱を開けるか」「泉の水を飲むか」という不可逆な判断に移した。
// 位置の情報は歩けば無料で検証できるが、箱と水は**検証行為そのものがリスク**。
// だから記録が「地図」ではなく「賭けの資料」になる。

import type {
  Claim,
  ClaimKind,
  DungeonInstance,
  EnemyKind,
  Floor,
  InfoSource,
  Memo,
  MissPattern,
  TalismanEffect,
  Vec,
} from './types';
import { KIND_WORD } from './character';
import { drawCue, drawInternalP } from './confidence';
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

// ---- 文章テンプレ（v0.2はテンプレ文。LLMは後回し §3） ----

/** variant: 'good'=当たり/安全を主張 'bad'=危険/価値なしを主張 */
function claimText(
  source: InfoSource,
  kind: ClaimKind,
  phrase: string,
  depth: number,
  variant: 'good' | 'bad',
  carryHint?: string,
): string {
  const t: Record<string, Record<string, string>> = {
    spring_good: {
      oldMap: `${phrase}の泉に「良い水」と書き添えられている。`,
      survivorNote: `「${phrase}の水で命拾いした」と走り書きがある。`,
      deathNote: `「水はある。${phrase}だ。あれを飲めば」……メモはそこで乱れている。`,
    },
    spring_bad: {
      oldMap: `${phrase}の泉の印に、バツが重ねて描かれている。`,
      survivorNote: `「${phrase}の水は飲むな。腹を下して死にかけた」とある。`,
      deathNote: `「喉が焼ける。${phrase}の水のせいだ」……筆跡は最後まで震えている。`,
    },
    chest_good: {
      oldMap: `${phrase}に箱の印と「当たり」の書き込みがある。`,
      survivorNote: `「${phrase}の箱の中身に救われた。まだ残っているはずだ」とある。`,
      deathNote: `「${phrase}の箱を開ければ助かる。あと少し」……記述はそこまでだ。`,
    },
    chest_bad: {
      oldMap: `${phrase}の箱の印に「触るな」と殴り書きがある。`,
      survivorNote: `「${phrase}の箱は開けるな。相棒はそれで逝った」とある。`,
      deathNote: `「箱が。${phrase}の箱が」……血の跡が箱の方角を指している。`,
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
  const tableKey =
    kind === 'spring' || kind === 'chest' ? `${kind}_${variant}` : kind;
  const byKind = t[tableKey];
  let text = byKind[source] ?? byKind.oldMap;
  if (carryHint) text += carryHint;
  return `B${depth}F——${text}`;
}

/** 敵の持ち物のヒント文（held の敵情報にだけ付く＝挑む動機になる） */
function carryHintText(carry: string): string | undefined {
  switch (carry) {
    case 'weapon':
      return '「あれは誰かの剣を引きずっていた」とも。';
    case 'potion':
      return '「奴の巣に薬瓶が転がっていた」とも。';
    case 'food':
      return '「誰かの糧袋を漁っていた」とも。';
    case 'gem':
      return '「奴の腹の底で、何かが光っていた」とも。';
    default:
      return undefined;
  }
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

/** 通路らしい床セル（直線の途中）を1つ探す。
 *  敵の立つセルは避ける——敵情報が「誤認」に解決されると、その位置に罠の残骸が
 *  植えられるため、held な通路情報と同じセルで衝突し得る（憲法1が壊れる） */
function findCorridorCell(rng: RNG, floor: Floor): Vec | null {
  const cells = shuffle(rng, floorCells(floor));
  for (const c of cells) {
    if (featureAt(floor, c)) continue;
    if (floor.entities.some((e) => e.alive && e.pos.x === c.x && e.pos.y === c.y)) continue;
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

/** 階段↔階段（＋宝箱）の到達性を壊さずに崩落を置けるか確認して置く */
function tryPlantCollapse(floor: Floor, pos: Vec): boolean {
  const anchors = floor.features.filter(
    (f) => f.kind === 'stairsUp' || f.kind === 'stairsDown' || f.kind === 'chest',
  );
  for (let i = 0; i + 1 < anchors.length; i++) {
    if (!isConnected(floor, anchors[i].pos, anchors[i + 1].pos, pos)) return false;
  }
  floor.features.push({ id: `f${floor.depth}-collapse-${pos.x}-${pos.y}`, kind: 'collapse', pos });
  return true;
}

// ---- 生成本体 ----

type Candidate = {
  kind: ClaimKind;
  pos: Vec;
  enemyId?: string;
  featureId?: string;
  itemId?: string;
};

function collectCandidates(rng: RNG, floor: Floor): Candidate[] {
  const out: Candidate[] = [];
  for (const f of floor.features) {
    if (f.kind === 'spring') out.push({ kind: 'spring', pos: f.pos, featureId: f.id });
    // 生成時から空の箱は記録の対象にしない（空箱の噂は判断を生まない。空は「古い情報」の外れ方から生まれる）
    // 宝入りの箱は「宝の情報」として別枠で扱う
    if (f.kind === 'chest' && f.chestContent !== 'empty' && f.chestContent !== 'treasure')
      out.push({ kind: 'chest', pos: f.pos, featureId: f.id });
    if (f.kind === 'chest' && f.chestContent === 'treasure')
      out.push({ kind: 'treasure', pos: f.pos, featureId: f.id });
  }
  for (const e of floor.entities) {
    if (e.dormant) continue;
    // 深部の主は「宝の情報」として扱う（近寄るな、ではなく「宝は抱かれている」）
    if (e.boss) out.push({ kind: 'treasure', pos: e.pos, enemyId: e.id });
    else out.push({ kind: 'enemy', pos: e.pos, enemyId: e.id });
  }
  for (const f of floor.features) {
    if (f.kind === 'trap') out.push({ kind: 'trap', pos: f.pos, featureId: f.id });
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
  chest: ['drift', 'stale', 'misread', 'false'],
  enemy: ['misread', 'false'], // 敵は動き回るので「位置ズレ」は外れ方として意味を成さない
  trap: ['drift', 'stale', 'false'],
  treasure: ['drift'], // 宝は必ず存在する（勝利条件）。外れは位置ズレのみ
  passage: ['stale'],
  weapon: ['drift', 'condition', 'false'],
  lore: ['misread'], // 相性の噂の外れは「別の種族と取り違えた」のみ
};

/** 箱の中身から「当たりか」を判定 */
function chestIsGood(content: string | undefined): boolean {
  return (
    content === 'weapon' ||
    content === 'armor' ||
    content === 'potion' ||
    content === 'food' ||
    content === 'gem'
  );
}

/** 古地図・メモの生成結果。claims は memos のいずれかに属する（memoId） */
export type Hearsay = { memos: Memo[]; claims: Claim[] };

/**
 * 古地図・生還者メモ・死亡者メモを生成し、当否を解決する。
 * miss の場合は実態に「理由」を植え込む（インスタンスを変異させる）ため、
 * 必ずプレイ開始前・生成パイプラインの一部として呼ぶこと。
 *
 * v0.6: 記録は「一枚の紙」（Memo）に束ねる。手がかり（紙の状態・字の乱れ）と
 * 内部確率は文書に属し、中身の各行は文書の p で個別に解決される。
 * 同じ乱れた字で書かれた2行は、だいたい同じ割合で当たる——だから紙を読む目が育つ。
 */
export function applyHearsay(instance: DungeonInstance, runSeed: number): Hearsay {
  const rng = mulberry32(hashSeed(runSeed, 'hearsay'));
  // 兄弟インスタンス: 同じ性格・別シードの「過去の誰かの潜行」。完全な誤情報の出所
  const sibling = generateInstance(instance.character, hashSeed(runSeed, 'sibling'));

  const memos: Memo[] = [];
  const claims: Claim[] = [];
  let claimNo = 0;
  let memoNo = 0;

  for (const floor of instance.floors) {
    const candidates = shuffle(rng, collectCandidates(rng, floor));
    // 各階2〜3件。箱・泉（＝賭けの対象）を優先し、最深階は宝の情報を必ず入れる
    const picked: Candidate[] = [];
    const treasureCand = candidates.find((c) => c.kind === 'treasure');
    if (treasureCand) picked.push(treasureCand);
    const bets = candidates.filter((c) => c.kind === 'chest' || c.kind === 'spring');
    for (const c of bets) {
      if (picked.length >= 3) break;
      picked.push(c);
    }
    for (const c of candidates) {
      if (picked.length >= 3) break;
      if (picked.includes(c)) continue;
      picked.push(c);
    }

    // 文書に束ねる: 1枚の紙に1〜2行。信頼度と手がかりは紙に属する
    const memoOf = new Map<Candidate, Memo>();
    let cursor = 0;
    while (cursor < picked.length) {
      const take = picked.length - cursor >= 2 && rng.next() < 0.55 ? 2 : 1;
      memoNo++;
      const source: InfoSource = pickWeighted(rng, [
        ['oldMap', 0.45],
        ['survivorNote', 0.3],
        ['deathNote', 0.25],
      ] as const);
      const internalP = drawInternalP(rng, source);
      const memo: Memo = {
        id: `m${memoNo}`,
        source,
        internalP,
        cue: drawCue(rng, source, internalP),
      };
      memos.push(memo);
      for (let k = 0; k < take; k++) memoOf.set(picked[cursor + k], memo);
      cursor += take;
    }

    for (const cand of picked) {
      claimNo++;
      const memo = memoOf.get(cand)!;
      const source = memo.source;
      const internalP = memo.internalP;

      // §8 解決: roll < p → hold / それ以外 → 外れ方を抽選（resolve.tsの重みに従う）
      const resolution = resolveInfo(rng, internalP, ALLOWED_MISS[cand.kind]);
      let held = resolution.held;
      let missPattern: MissPattern | undefined = resolution.held
        ? undefined
        : resolution.missPattern;
      let claimedPos: Vec = cand.pos;
      let actualPos: Vec | null = cand.pos;
      let actualKind: string = cand.kind;
      let variant: 'good' | 'bad' = 'good';
      let carryHint: string | undefined;

      const feature = cand.featureId
        ? floor.features.find((x) => x.id === cand.featureId)
        : undefined;
      const enemy = cand.enemyId
        ? floor.entities.find((x) => x.id === cand.enemyId)
        : undefined;

      // 実態から文面の主張（安全/危険）を決める（heldならそのまま、missなら後で歪む）
      if (cand.kind === 'spring') {
        variant = feature?.badWater ? 'bad' : 'good';
        actualKind = feature?.badWater ? 'badSpring' : 'goodSpring';
      } else if (cand.kind === 'chest') {
        variant = chestIsGood(feature?.chestContent) ? 'good' : 'bad';
        actualKind = `chest_${feature?.chestContent}`;
      }

      if (held) {
        if (cand.kind === 'enemy' && enemy) {
          carryHint = carryHintText(enemy.carry);
        }
      } else {
        switch (missPattern) {
          case 'drift': {
            // 位置が少しズレる: 主張位置をずらす。実物は元の場所に在る（文面の中身は正しい）
            claimedPos = jitterPos(rng, floor, cand.pos);
            break;
          }
          case 'condition': {
            // 内容は合うが条件が違う:
            //  泉→「良い水」と言うが、実際は涸れている/悪い水 / 剣→朽ちている
            if (cand.kind === 'spring' && feature) {
              variant = 'good'; // 文面は当たりを主張する
              if (feature.badWater) {
                actualKind = 'badSpring'; // 既に悪い水: 記録が古く、当時は良かったのだろう
              } else if (rng.next() < 0.5) {
                feature.kind = 'driedSpring';
                actualKind = 'driedSpring';
              } else {
                feature.badWater = true;
                actualKind = 'badSpring';
              }
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
            // 古い情報: 通路は崩れている / 罠は朽ちている / 箱は先に漁られて空
            if (cand.kind === 'passage') {
              if (!tryPlantCollapse(floor, cand.pos)) {
                held = true; // 到達性を壊すなら崩落は置けない → 結果的に正しい情報
                missPattern = undefined;
              } else {
                actualKind = 'collapse';
              }
            } else if (cand.kind === 'trap' && feature) {
              feature.triggered = true; // 発動済み＝朽ちた残骸
              actualKind = 'brokenTrap';
            } else if (cand.kind === 'chest' && feature) {
              if (chestIsGood(feature.chestContent)) {
                variant = 'good'; // 「当たりの箱」と言うが、先に漁られている
                feature.chestContent = 'empty';
                actualKind = 'chest_empty';
              } else {
                // 危険な箱が「古い情報」になるのは不自然 → 誤認に振り替える
                missPattern = 'misread';
                variant = chestIsGood(feature.chestContent) ? 'bad' : 'good';
                actualKind = `chest_${feature.chestContent}`;
              }
            }
            break;
          }
          case 'misread': {
            // 主観の誤認:
            //  敵→「金属音」は罠だった / 箱→安全と危険を取り違えた警告
            if (cand.kind === 'enemy' && enemy) {
              enemy.alive = false; // 敵は最初から存在しない（誤認だった）
              floor.features.push({
                id: `f${floor.depth}-misread-${claimNo}`,
                kind: 'trap',
                pos: enemy.pos,
              });
              actualKind = 'trap';
            } else if (cand.kind === 'chest' && feature) {
              // 文面は実態の逆を主張する（安全な箱に「触るな」/ 危険な箱に「当たり」）
              variant = chestIsGood(feature.chestContent) ? 'bad' : 'good';
              actualKind = `chest_${feature.chestContent}`;
            }
            break;
          }
          case 'false': {
            // 完全な誤情報（稀）: 兄弟インスタンス（別の潜行）由来の主張。
            // 現インスタンスの同種の実物と偶然重ならない位置を選ぶ
            const sibFloor = sibling.floors[Math.min(floor.depth - 1, sibling.floors.length - 1)];
            const sibCells = shuffle(rng, floorCells(sibFloor));
            const collides = (p: Vec): boolean => {
              const f = floor.features.find((x) => x.pos.x === p.x && x.pos.y === p.y);
              const e = floor.entities.find(
                (x) => x.alive && !x.dormant && x.pos.x === p.x && x.pos.y === p.y,
              );
              if (cand.kind === 'spring') return f?.kind === 'spring';
              if (cand.kind === 'chest') return f?.kind === 'chest';
              if (cand.kind === 'trap') return f?.kind === 'trap';
              if (cand.kind === 'enemy') return e !== undefined;
              if (cand.kind === 'weapon')
                return floor.items.some(
                  (i) => i.kind === 'weapon' && i.pos?.x === p.x && i.pos?.y === p.y,
                );
              return false;
            };
            claimedPos = sibCells.find((p) => !collides(p)) ?? pick(rng, sibCells);
            actualPos = null;
            actualKind = 'nothing';
            variant = 'good'; // 誤情報は「そこに何かある」と言う
            break;
          }
        }
      }

      // 宝の情報はモードで文面が変わる（箱の中か、主が抱いているか）
      let text: string;
      if (cand.kind === 'treasure') {
        const phrase = posPhrase(floor, claimedPos);
        text =
          instance.treasureMode === 'chest'
            ? `B${floor.depth}F——「宝は${phrase}の箱の中だ」とある。`
            : `B${floor.depth}F——「宝は大きなものが抱いている。${phrase}で見た」とある。`;
        if (cand.enemyId) actualKind = 'treasureBoss';
      } else {
        text = claimText(source, cand.kind, posPhrase(floor, claimedPos), floor.depth, variant, carryHint);
      }

      claims.push({
        id: `c${claimNo}`,
        source,
        memoId: memo.id,
        internalP,
        kind: cand.kind,
        floorDepth: floor.depth,
        claimedPos,
        text,
        cue: memo.cue,
        held,
        missPattern,
        actualPos,
        actualKind,
        assertedSafety: cand.kind === 'spring' || cand.kind === 'chest' ? variant : undefined,
        // 動き回る敵・主についての情報は、本体の目視/撃破で検証する
        aboutEnemyId:
          cand.kind === 'treasure' && cand.enemyId
            ? cand.enemyId
            : held && cand.kind === 'enemy'
              ? cand.enemyId
              : undefined,
        verified: false,
      });
    }
  }

  // ---- 札の相性の噂（場所に紐付かない知識。floorDepth=0＝全域） ----
  // 投げて確かめるまで真偽は分からない——箱・水と同じく「賭けた者だけが答えを知る」
  const patterns = Object.keys(instance.talismanLore);
  const loreCount = 1 + (rng.next() < 0.5 ? 1 : 0);
  const kinds: EnemyKind[] = ['metallic', 'beast', 'shade'];
  const noteMemos = memos.filter((m) => m.source === 'survivorNote' || m.source === 'deathNote');
  for (let i = 0; i < loreCount && patterns.length > 0; i++) {
    claimNo++;
    const pattern = pick(rng, patterns);
    const truth = instance.talismanLore[pattern];
    // 手記の端の書き込み: 既存の手記の余白にあるか、独立した走り書きか
    let memo: Memo;
    if (noteMemos.length > 0 && rng.next() < 0.6) {
      memo = pick(rng, noteMemos);
    } else {
      memoNo++;
      const source: InfoSource = pickWeighted(rng, [
        ['survivorNote', 0.5],
        ['deathNote', 0.5],
      ] as const);
      const internalP = drawInternalP(rng, source);
      memo = { id: `m${memoNo}`, source, internalP, cue: drawCue(rng, source, internalP) };
      memos.push(memo);
    }
    const source = memo.source;
    const internalP = memo.internalP;
    const resolution = resolveInfo(rng, internalP, ['misread']);
    const held = resolution.held;
    // 「効く」の主張か「向けるな」の警告か
    const aspect: 'strong' | 'backfire' = rng.next() < 0.6 ? 'strong' : 'backfire';
    let targetKind: EnemyKind = aspect === 'strong' ? truth.strongVs : truth.backfireVs;
    if (!held) {
      // 誤認: 別の種族の名を挙げてしまっている
      const wrong = kinds.filter((k) => k !== targetKind);
      targetKind = pick(rng, wrong);
    }
    // 「効く」の噂は系統まで語る（系統は真実。外れるのは相手の取り違えだけ）
    const strongText: Record<TalismanEffect, string> = {
      burn: `「${pattern}の札は${KIND_WORD[targetKind]}を灼く」と手記の端にある。`,
      slow: `「${pattern}の札は${KIND_WORD[targetKind]}の足を縛る」と手記の端にある。`,
      sleep: `「${pattern}の札は${KIND_WORD[targetKind]}を眠らせる」と手記の端にある。`,
      haste: `「${KIND_WORD[targetKind]}に遭ったら${pattern}の札を切れ。翼が生える」と手記の端にある。`,
    };
    const text =
      aspect === 'strong'
        ? strongText[truth.effect]
        : `「${pattern}の札を${KIND_WORD[targetKind]}に向けるな」と走り書きがある。`;
    claims.push({
      id: `c${claimNo}`,
      source,
      memoId: memo.id,
      internalP,
      kind: 'lore',
      floorDepth: 0,
      claimedPos: null,
      text,
      cue: memo.cue,
      held,
      missPattern: held ? undefined : 'misread',
      actualPos: null,
      actualKind: `lore_${pattern}_${aspect}`,
      assertedSafety: aspect === 'strong' ? 'good' : 'bad',
      lorePattern: pattern,
      loreTargetKind: targetKind,
      verified: false,
    });
  }

  return { memos, claims };
}
