// 画面HTML組み立て §11
// core の状態を読んで各パネルのHTML片を組み立てるだけ。ゲームロジックは持たない。
// 数字は一切表示しない（憲法5）。
// 色は記号の「種類」と「起きた事実」（被弾=赤・回復や実入り=緑）にだけ使う。
// 情報の信頼度を色分けすることは決してしない——
// 信頼度は字の乱れ・紙の状態の手がかり語彙で読ませる（憲法6の体験を色で先回りしない）。

import { SOURCE_NAMES } from '../core/confidence';
import { assessDanger } from '../core/danger';
import { describeGems } from '../core/economy';
import { gearGauge } from '../core/gear';
import { enemyAt, featureAt, itemAt } from '../core/generate';
import {
  armorWord,
  conditionWord,
  currentFloor,
  eventText,
  eventTone,
  foeAssessment,
  hungerWord,
  KIND_WORD,
  POTION_NAMES,
  torchWord,
  visibleFoes,
  weaponWord,
  type EventLine,
  type GameState,
} from '../core/state';
import type { Vec } from '../core/types';

const key = (p: Vec) => `${p.x},${p.y}`;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- マップ ----

type Cell = { ch: string; cls: string | null };

/** cellChar 相当。文字に加えて種類（＝色クラス）を返す */
function cellInfo(state: GameState, p: Vec, seen: Set<string>, walked: Set<string>): Cell {
  const floor = currentFloor(state);
  if (state.pos.x === p.x && state.pos.y === p.y) return { ch: '@', cls: 'c-you' };

  if (!seen.has(key(p))) {
    // 未知の境界 ?: 見えている床に隣接する未知マス（進めば新情報、ただしリスク §9.2）
    const adj = [
      { x: p.x, y: p.y - 1 },
      { x: p.x, y: p.y + 1 },
      { x: p.x - 1, y: p.y },
      { x: p.x + 1, y: p.y },
    ];
    for (const a of adj) {
      if (seen.has(key(a)) && floor.grid[a.y]?.[a.x]?.kind === 'floor')
        return { ch: '?', cls: 'c-edge' };
    }
    return { ch: ' ', cls: null }; // 未探索の闇
  }

  const tile = floor.grid[p.y][p.x];
  if (tile.kind === 'wall') return { ch: '#', cls: 'c-wall' };

  // 敵は動くため「いま見えている」場合のみ描く（地形の記憶と違い、過去の目撃位置は当てにならない）
  if (state.visibleNow.has(key(p))) {
    const enemy = enemyAt(floor, p);
    if (enemy) return { ch: '&', cls: 'c-enemy' };
  }

  const walkedFloor: Cell = walked.has(key(p))
    ? { ch: '.', cls: 'c-walk' }
    : { ch: ',', cls: 'c-seen' };

  const f = featureAt(floor, p);
  if (f) {
    switch (f.kind) {
      case 'stairsUp':
        return { ch: '<', cls: 'c-stairs' };
      case 'stairsDown':
        return { ch: '>', cls: 'c-stairs' };
      case 'spring':
        return { ch: '~', cls: 'c-water' }; // 良い水も悪い水も同じに見える（見た目では判別できない）
      case 'driedSpring':
        return { ch: '-', cls: 'c-dry' }; // 乾いた窪みは見れば分かる
      case 'chest':
        return f.opened ? walkedFloor : { ch: '[', cls: 'c-chest' };
      case 'treasure':
        return f.taken ? walkedFloor : { ch: '$', cls: 'c-gold' };
      case 'collapse':
        return { ch: 'x', cls: 'c-ruin' };
      case 'trap':
        return f.triggered ? { ch: '^', cls: 'c-ruin' } : walkedFloor; // 未発動の罠は見えない
    }
  }
  const item = itemAt(floor, p);
  if (item) return { ch: '*', cls: 'c-item' };

  return walkedFloor;
}

function renderMapHtml(state: GameState): string {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const lines: string[] = [];
  for (let y = 0; y < floor.height; y++) {
    let line = '';
    for (let x = 0; x < floor.width; x++) {
      const p = { x, y };
      const cell = cellInfo(state, p, know.seen, know.walked);
      if (!cell.cls) {
        line += cell.ch;
        continue;
      }
      const visible = state.visibleNow.has(key(p)) || cell.ch === '@';
      line += `<span class="${cell.cls}${visible ? ' v' : ''}">${escapeHtml(cell.ch)}</span>`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** 松明の帯→マップの明るさクラス。帯は torchWord と同じ粗さ（数字は漏れない） */
function torchClass(torch: number): string {
  if (torch > 60) return 'torch-bright';
  if (torch > 30) return 'torch-flicker';
  if (torch > 0) return 'torch-low';
  return 'torch-dark';
}

// ---- 各パネル ----

/** 出来事: 直近ターンが明るく、過去は薄れる（履歴はUI層が持つ）。
 *  被弾・悪化は赤、回復・実入りは緑（toneはcoreが「起きた事実」にだけ付ける） */
function renderEventsHtml(history: EventLine[][]): string {
  const shown = history.slice(-3);
  const items: string[] = [];
  shown.forEach((group, i) => {
    const age = shown.length - 1 - i; // 0=最新
    for (const line of group) {
      const tone = eventTone(line);
      const classes = [age > 0 ? `old${age}` : '', tone ? `t-${tone}` : ''].filter(Boolean);
      const cls = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
      items.push(`<li${cls}>${escapeHtml(eventText(line))}</li>`);
    }
  });
  return items.join('');
}

/**
 * 対峙: いま見えている敵と、その危険度ラベル（§7）を常時出す。
 * 敵の方へ動けば攻撃になるので、踏み込む前にここで読める（憲法5: ラベルは言葉、数字は出さない）。
 * 危険度を押し上げている要因（傷み・空腹・囲まれ）も添える——死亡ログと同じ材料。
 */
function renderFoesHtml(state: GameState): string {
  const foes = visibleFoes(state);
  if (foes.length === 0) return '';
  return foes
    .map((e) => {
      const a = foeAssessment(state, e);
      const dir = foeDirWord(state, e.pos);
      const adjacent = Math.abs(e.pos.x - state.pos.x) + Math.abs(e.pos.y - state.pos.y) === 1;
      const sleeping = (e.sleepTurns ?? 0) > 0;
      const danger = `危険度：${a.label}`;
      const dangerHtml =
        a.label === 'かなり危険' || a.label === '死の気配'
          ? `<span class="foe-danger bad">${danger}</span>`
          : `<span class="foe-danger">${danger}</span>`;
      const note = sleeping ? '（眠っている）' : adjacent ? '（間合いの内だ）' : '';
      const factors = a.factors.length > 0 ? `<span class="meta">——${escapeHtml(a.factors.join('・'))}</span>` : '';
      return `<li>${escapeHtml(`${dir}に${e.name}`)}${escapeHtml(note)}｜${dangerHtml}${factors}</li>`;
    })
    .join('');
}

/** プレイヤーから見た敵の方角の言葉（8方位） */
function foeDirWord(state: GameState, pos: Vec): string {
  const dx = pos.x - state.pos.x;
  const dy = pos.y - state.pos.y;
  const ns = dy < 0 ? '北' : dy > 0 ? '南' : '';
  const we = dx < 0 ? '西' : dx > 0 ? '東' : '';
  return ns + we || 'すぐ近く';
}

function renderSensesHtml(state: GameState): string {
  const floor = currentFloor(state);
  const senses = state.senses.filter((s) => s.floorDepth === floor.depth && !s.verified);
  return senses
    .map(
      (s) =>
        `<li>${escapeHtml(s.text)}<span class="meta">（気配——${escapeHtml(s.cue)}）</span></li>`,
    )
    .join('');
}

function renderClaimsHtml(state: GameState): string {
  const floor = currentFloor(state);
  // この階の記録＋場所に紐付かない知識を「一枚の紙」単位で見せる。
  // 信頼度は字の乱れ・紙の状態などの手がかりで伝える——数字もラベルも出さない（§9.1・憲法5）。
  // 手がかりは文書の見出しに付く: 同じ紙に書かれた行は、同じ目で疑える。
  const relevant = state.claims.filter((c) => c.floorDepth === floor.depth || c.floorDepth === 0);
  const parts: string[] = [];
  // 酒場の噂: 穴の性格について聞いた話。潜行中いつでも読み返せる一枚
  const rumors = state.instance.character.traitRumors;
  if (rumors.length > 0) {
    const head = `<div class="memo-head">酒場の噂<span class="meta">——聞いた話の寄せ集めだ。誰も真偽は請け負わない</span></div>`;
    const body = rumors.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
    parts.push(`<li class="memo">${head}<ul class="memo-body">${body}</ul></li>`);
  }
  for (const memo of state.memos) {
    const lines = relevant.filter((c) => c.memoId === memo.id);
    if (lines.length === 0) continue;
    const head = `<div class="memo-head">${SOURCE_NAMES[memo.source]}<span class="meta">——${escapeHtml(memo.cue)}</span></div>`;
    const body = lines
      .map((c) => {
        const done = c.verified ? '<span class="ok">〔検証済み〕</span>' : '';
        return `<li>${escapeHtml(c.text)}${done}</li>`;
      })
      .join('');
    parts.push(`<li class="memo">${head}<ul class="memo-body">${body}</ul></li>`);
  }
  // 文書に属さない記録（保険。現行の生成では発生しない）
  for (const c of relevant) {
    if (c.memoId) continue;
    const done = c.verified ? '<span class="ok">〔検証済み〕</span>' : '';
    parts.push(
      `<li>${escapeHtml(c.text)}<span class="meta">（${SOURCE_NAMES[c.source]}——${escapeHtml(c.cue)}）</span>${done}</li>`,
    );
  }
  return parts.join('');
}

function renderStatusHtml(state: GameState): string {
  const p = state.player;
  // 荷を検めた後は個数で書く（観測済みの事実は数字を出してよい。曖昧なのは検めるまで）
  const n = (name: string, count: number, vague: string): string =>
    state.counted ? `${name}×${count}` : `${name}${count > 1 ? vague : ''}`;
  // 傷みの目盛り（見れば分かる事実。折れかけ・ぼろぼろは赤）
  const gauge = (wear: number): string =>
    `<span class="gauge${wear >= 70 ? ' worn' : ''}">${gearGauge(wear)}</span>`;
  // 装備の段: 手にしている得物と着ている鎧（どちらも目盛り付き）。替えの得物は持ち物の段に置く
  const weaponPart = p.weapons[0]
    ? `得物は${escapeHtml(weaponWord(p.weapons[0]))}${gauge(p.weapons[0].wear)}`
    : '得物は素手';
  const lines: string[] = [
    `<div class="line">${conditionWord(p.condition)}。${hungerWord(p.hunger)}。</div>`,
    `<div class="line">${weaponPart}。${escapeHtml(armorWord(p.armor))}${p.armor ? gauge(p.armor.wear) : ''}。</div>`,
    `<div class="line">${torchWord(p.torch, p.spareTorches, state.counted)}。</div>`,
  ];
  if (p.poisonTurns > 0) lines.push('<div class="line bad">毒が回っている。</div>');
  if (p.numbTurns > 0) lines.push('<div class="line bad">体が痺れている。</div>');
  if (p.hasteTurns > 0) lines.push('<div class="line good">体が羽のように軽い。</div>');
  const carry: string[] = [];
  for (const w of p.weapons.slice(1)) carry.push(`替えの${escapeHtml(weaponWord(w))}${gauge(w.wear)}`);
  for (const [kind, count] of Object.entries(p.potions)) {
    if (count <= 0) continue;
    carry.push(n(POTION_NAMES[kind] ?? '薬', count, '（いくつか）'));
  }
  if (p.food > 0) carry.push(n('糧食', p.food, '（いくつか）'));
  if (p.stones > 0) carry.push(n('石', p.stones, '（いくつか）'));
  if (p.fireOil > 0) carry.push(n('火油の瓶', p.fireOil, '（いくつか）'));
  for (const [pattern, count] of Object.entries(p.talismans)) {
    if (count <= 0) continue;
    // 自分で投げて見た効果は確定の知識として添える（憲法2）
    const known = Object.entries(state.talismanKnowledge[pattern] ?? {})
      .map(([kind, eff]) =>
        eff === 'strong'
          ? `${KIND_WORD[kind]}に効いた`
          : eff === 'backfire'
            ? `${KIND_WORD[kind]}には逆効き`
            : `${KIND_WORD[kind]}には並`,
      )
      .join('・');
    carry.push(`${n(`${pattern}の札`, count, '（数枚）')}${known ? `〔${known}〕` : ''}`);
  }
  carry.push(...describeGems(p.gems).map(escapeHtml));
  if (p.hasTreasure) carry.push('迷宮の底の宝');
  // 装備エントリはゲージのspanを含むため、ここでは再エスケープしない（各エントリで済ませてある）
  lines.push(`<div class="line">持ち物：${carry.length > 0 ? carry.join('、') : '荷袋は空だ'}</div>`);
  return lines.join('');
}

/** 結末（死亡ログ/生還記録）。持ち越し等のメタ行はUI層（main.ts）が追記する */
function renderEndHtml(lines: string[]): string {
  return lines
    .map((l, i) =>
      i === 0
        ? `<div class="head">${escapeHtml(l)}</div>`
        : `<div class="line">${escapeHtml(l)}</div>`,
    )
    .join('');
}

// ---- デバッグ枠（開発者向け・内部数値の全表示。§12の精神——開発者は数字で握る） ----

function renderDebug(state: GameState): string {
  const floor = currentFloor(state);
  const p = state.player;
  const lines: string[] = [];
  lines.push(
    `seed=${state.instance.runSeed} turn=${state.turn} phase=${state.phase} B${floor.depth}F pos=(${state.pos.x},${state.pos.y}) 宝=${state.instance.treasureMode}`,
  );
  lines.push(
    `札: ${Object.entries(state.instance.talismanLore)
      .map(([pt, l]) => `${pt}→系統:${l.effect}/効く:${l.strongVs}/逆:${l.backfireVs}`)
      .join(' ')} 石=${state.player.stones} 札所持=${JSON.stringify(state.player.talismans)}`,
  );
  const gearTag = (kind: string, wear: number, bonus?: number) =>
    `${kind}${bonus ? (bonus > 0 ? `+${bonus}` : bonus) : ''}:${wear.toFixed(0)}`;
  lines.push(
    `condition=${p.condition.toFixed(1)} hunger=${p.hunger.toFixed(1)} armor=${p.armor ? gearTag(p.armor.kind, p.armor.wear, p.armor.bonus) : 'none'} torch=${p.torch.toFixed(1)}+${p.spareTorches}本 poison=${p.poisonTurns} numb=${p.numbTurns} haste=${p.hasteTurns} weapons=${p.weapons.map((w) => gearTag(w.kind, w.wear, w.bonus)).join('/') || 'fists'} treasure=${p.hasTreasure} 薬=${JSON.stringify(p.potions)}`,
  );
  const engIds = Object.keys(state.engagements);
  if (engIds.length > 0) {
    lines.push(
      `engagements: ${engIds.map((id) => `${id}=${state.engagements[id].label}`).join(' ')}`,
    );
  }
  for (const e of floor.entities) {
    if (!e.alive) continue;
    const risk = assessDanger(p, e, state.instance.character);
    lines.push(
      `敵 ${e.id} ${e.name} (${e.pos.x},${e.pos.y}) str=${e.strength.toFixed(2)} speed=1/${e.moveEvery}` +
        ` carry=${e.carry}${e.dormant ? ' 潜伏' : (e.sleepTurns ?? 0) > 0 ? ` 睡眠${e.sleepTurns}` : e.chasing ? ` 追跡中 lastSeen=(${e.lastSeen?.x},${e.lastSeen?.y}) lost=${e.lostTurns}` : ' 徘徊'}` +
        ` risk=${risk.internalRisk.toFixed(2)}（${risk.label}）`,
    );
  }
  for (const f of floor.features) {
    if (f.kind === 'chest') {
      lines.push(`箱 ${f.id} (${f.pos.x},${f.pos.y}) 中身=${f.chestContent}${f.opened ? ' 開封済' : ''}`);
    }
    if (f.kind === 'spring') {
      lines.push(`泉 ${f.id} (${f.pos.x},${f.pos.y}) ${f.badWater ? '悪い水' : '良い水'}`);
    }
    if (f.kind === 'trap') {
      lines.push(`罠 ${f.id} (${f.pos.x},${f.pos.y}) 種=${f.trapKind ?? 'poison'}${f.triggered ? ' 発動済' : ''}`);
    }
  }
  for (const c of [...state.claims, ...state.senses]) {
    if (c.floorDepth !== floor.depth && c.floorDepth !== 0) continue;
    lines.push(
      `情報 ${c.id} ${c.source} p=${c.internalP.toFixed(2)} ${c.held ? 'HOLD' : `MISS(${c.missPattern})`}` +
        ` ${c.kind}${c.assertedSafety ? `:${c.assertedSafety}` : ''} claimed=${c.claimedPos ? `(${c.claimedPos.x},${c.claimedPos.y})` : '-'}` +
        ` actual=${c.actualKind}${c.actualPos ? `@(${c.actualPos.x},${c.actualPos.y})` : ''}${c.verified ? ' 済' : ''}`,
    );
  }
  return lines.join('\n');
}

// ---- 画面全体 ----

export type RenderOptions = {
  debug?: boolean;
  /** 出来事の履歴（新しいものが末尾。UI層が保持する） */
  eventHistory?: EventLine[][];
};

export type ScreenView = {
  title: string;
  mapHtml: string;
  /** #map に付ける明るさクラス（松明の帯と連動） */
  torchClass: string;
  eventsHtml: string;
  /** 対峙: 見えている敵と危険度ラベル（常時表示） */
  foesHtml: string;
  sensesHtml: string;
  claimsHtml: string;
  statusHtml: string;
  end: { kind: 'dead' | 'escaped'; bodyHtml: string } | null;
  debugText: string | null;
};

/** 1画面ぶんのHTML片を組み立てる（§11）。DOMへの反映は main.ts が行う */
export function renderView(state: GameState, opts: RenderOptions = {}): ScreenView {
  const floor = currentFloor(state);
  const character = state.instance.character;
  const history = opts.eventHistory ?? [state.events];

  let end: ScreenView['end'] = null;
  if (state.phase === 'dead' && state.deathLog) {
    end = { kind: 'dead', bodyHtml: renderEndHtml(state.deathLog) };
  } else if (state.phase === 'escaped' && state.escapeLog) {
    end = { kind: 'escaped', bodyHtml: renderEndHtml(state.escapeLog) };
  }

  return {
    title: `${character.name} B${floor.depth}F`,
    mapHtml: renderMapHtml(state),
    torchClass: torchClass(state.player.torch),
    eventsHtml: renderEventsHtml(history),
    foesHtml: renderFoesHtml(state),
    sensesHtml: renderSensesHtml(state),
    claimsHtml: renderClaimsHtml(state),
    statusHtml: renderStatusHtml(state),
    end,
    debugText: opts.debug ? renderDebug(state) : null,
  };
}
