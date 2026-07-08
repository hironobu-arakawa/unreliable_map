// 画面テキスト組み立て §11
// core の状態を読んで画面テキストを組み立てるだけ。ゲームロジックは持たない。
// 数字は一切表示しない（憲法5）。

import { confidenceLabel, SOURCE_NAMES } from '../core/confidence';
import { assessDanger } from '../core/danger';
import { enemyAt, featureAt, itemAt } from '../core/generate';
import {
  armorWord,
  conditionWord,
  currentFloor,
  hungerWord,
  torchWord,
  weaponWord,
  type GameState,
} from '../core/state';
import type { Vec } from '../core/types';

const key = (p: Vec) => `${p.x},${p.y}`;

/** 3層マップの描画（踏破・視界は事実のみ。未知の境界は ? §9.2） */
function renderMap(state: GameState): string {
  const floor = currentFloor(state);
  const know = state.knowledge[state.floorIndex];
  const lines: string[] = [];
  for (let y = 0; y < floor.height; y++) {
    let line = '  ';
    for (let x = 0; x < floor.width; x++) {
      const p = { x, y };
      line += cellChar(state, p, know.seen, know.walked);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function cellChar(state: GameState, p: Vec, seen: Set<string>, walked: Set<string>): string {
  const floor = currentFloor(state);
  if (state.pos.x === p.x && state.pos.y === p.y) return '@';

  if (!seen.has(key(p))) {
    // 未知の境界 ?: 見えている床に隣接する未知マス（進めば新情報、ただしリスク §9.2）
    const adj = [
      { x: p.x, y: p.y - 1 },
      { x: p.x, y: p.y + 1 },
      { x: p.x - 1, y: p.y },
      { x: p.x + 1, y: p.y },
    ];
    for (const a of adj) {
      if (seen.has(key(a)) && floor.grid[a.y]?.[a.x]?.kind === 'floor') return '?';
    }
    return ' '; // 未探索の闇
  }

  const tile = floor.grid[p.y][p.x];
  if (tile.kind === 'wall') return '#';

  // 敵は動くため「いま見えている」場合のみ描く（地形の記憶と違い、過去の目撃位置は当てにならない）
  if (state.visibleNow.has(key(p))) {
    const enemy = enemyAt(floor, p);
    if (enemy) return '&';
  }

  const f = featureAt(floor, p);
  if (f) {
    switch (f.kind) {
      case 'stairsUp':
        return '<';
      case 'stairsDown':
        return '>';
      case 'spring':
        return '~'; // 良い水も悪い水も同じに見える（見た目では判別できない）
      case 'driedSpring':
        return '-'; // 乾いた窪みは見れば分かる
      case 'chest':
        return f.opened ? '.' : '[';
      case 'treasure':
        return f.taken ? '.' : '$';
      case 'collapse':
        return 'x';
      case 'trap':
        return f.triggered ? '^' : walked.has(key(p)) ? '.' : ','; // 未発動の罠は見えない
    }
  }
  const item = itemAt(floor, p);
  if (item) return '*';

  return walked.has(key(p)) ? '.' : ',';
}

function box(title: string, body: string): string {
  if (!body.trim()) return '';
  return `─── ${title} ───\n${body}\n`;
}

/** デバッグ枠（開発者向け・内部数値の全表示。§12の精神——開発者は数字で握る） */
function renderDebug(state: GameState): string {
  const floor = currentFloor(state);
  const p = state.player;
  const lines: string[] = [];
  lines.push(
    `  seed=${state.instance.runSeed} turn=${state.turn} phase=${state.phase} B${floor.depth}F pos=(${state.pos.x},${state.pos.y})`,
  );
  lines.push(
    `  condition=${p.condition.toFixed(1)} hunger=${p.hunger.toFixed(1)} armorWear=${p.armorWear.toFixed(1)} torch=${p.torch.toFixed(1)}+${p.spareTorches}本 poison=${p.poisonTurns} weapon=T${p.weaponTier} treasure=${p.hasTreasure}`,
  );
  if (state.pending) {
    const a = state.pending.assessment;
    lines.push(`  encounter: risk=${a.internalRisk.toFixed(2)}（${a.label}）`);
  }
  for (const e of floor.entities) {
    if (!e.alive) continue;
    const risk = assessDanger(p, e, state.instance.character);
    lines.push(
      `  敵 ${e.id} ${e.name} (${e.pos.x},${e.pos.y}) str=${e.strength.toFixed(2)} speed=1/${e.moveEvery}` +
        ` carry=${e.carry}${e.dormant ? ' 潜伏' : e.chasing ? ` 追跡中 lastSeen=(${e.lastSeen?.x},${e.lastSeen?.y}) lost=${e.lostTurns}` : ' 徘徊'}` +
        ` risk=${risk.internalRisk.toFixed(2)}（${risk.label}）`,
    );
  }
  for (const f of floor.features) {
    if (f.kind === 'chest') {
      lines.push(`  箱 ${f.id} (${f.pos.x},${f.pos.y}) 中身=${f.chestContent}${f.opened ? ' 開封済' : ''}`);
    }
    if (f.kind === 'spring') {
      lines.push(`  泉 ${f.id} (${f.pos.x},${f.pos.y}) ${f.badWater ? '悪い水' : '良い水'}`);
    }
  }
  for (const c of [...state.claims, ...state.senses]) {
    if (c.floorDepth !== floor.depth) continue;
    lines.push(
      `  情報 ${c.id} ${c.source} p=${c.internalP.toFixed(2)} ${c.held ? 'HOLD' : `MISS(${c.missPattern})`}` +
        ` ${c.kind}${c.assertedSafety ? `:${c.assertedSafety}` : ''} claimed=${c.claimedPos ? `(${c.claimedPos.x},${c.claimedPos.y})` : '-'}` +
        ` actual=${c.actualKind}${c.actualPos ? `@(${c.actualPos.x},${c.actualPos.y})` : ''}${c.verified ? ' 済' : ''}`,
    );
  }
  return lines.join('\n');
}

export type RenderOptions = { debug?: boolean };

/** 画面全体のテキストを組み立てる（§11 の1画面） */
export function renderScreen(state: GameState, opts: RenderOptions = {}): string {
  const parts: string[] = [];
  const floor = currentFloor(state);
  const character = state.instance.character;

  // 終局画面
  if (state.phase === 'dead' && state.deathLog) {
    parts.push(`${character.name}\n`);
    parts.push(state.deathLog.join('\n'));
    parts.push('');
    parts.push(box('最後の出来事', state.events.map((e) => `  ${e}`).join('\n')));
    if (opts.debug) parts.push(box('DEBUG（開発者用・内部数値）', renderDebug(state)));
    return parts.join('\n');
  }
  if (state.phase === 'escaped' && state.escapeLog) {
    parts.push(`${character.name}\n`);
    parts.push(state.escapeLog.join('\n'));
    if (opts.debug) parts.push('\n' + box('DEBUG（開発者用・内部数値）', renderDebug(state)));
    return parts.join('\n');
  }

  // タイトル
  parts.push(`${character.name} B${floor.depth}F`);
  parts.push('');

  // マップ枠
  parts.push(renderMap(state));
  parts.push('');
  parts.push('  @=あなた .=歩いた床 ,=見えている床 #=壁 ?=未知の境界');
  parts.push('  <=上り階段 >=下り階段 ~=泉 -=涸れた泉 [=宝箱 $=宝 &=何かいる *=落し物 x=崩落 ^=罠の跡');
  parts.push('');

  // 情景テキスト（直近の出来事: 行動後の結果と事前情報の対応 §10）
  if (state.events.length > 0) {
    parts.push(box('出来事', state.events.map((e) => `  ${e}`).join('\n')));
  }

  // 気配（方向ごとの音・匂い。信頼度ラベル付き）
  const senses = state.senses.filter((s) => s.floorDepth === floor.depth && !s.verified);
  if (senses.length > 0) {
    parts.push(
      box(
        '気配',
        senses.map((s) => `  ${s.text}（気配：${confidenceLabel(s.internalP)}）`).join('\n'),
      ),
    );
  }

  // 古地図/噂枠（この階に関する記録。信頼度ラベル付き §9.1）
  const claims = state.claims.filter((c) => c.floorDepth === floor.depth);
  if (claims.length > 0) {
    parts.push(
      box(
        '手元の記録',
        claims
          .map((c) => {
            const label = `${SOURCE_NAMES[c.source]}：${confidenceLabel(c.internalP)}`;
            const done = c.verified ? '〔検証済み〕' : '';
            return `  ${c.text}（${label}）${done}`;
          })
          .join('\n'),
      ),
    );
  }

  // 状態枠（言葉のみ）
  const p = state.player;
  const stateLines = [
    `  ${conditionWord(p.condition)}。${hungerWord(p.hunger)}。`,
    `  ${armorWord(p.armorWear)}。${torchWord(p.torch, p.spareTorches)}。`,
  ];
  if (p.poisonTurns > 0) stateLines.push('  毒が回っている。');
  const carry: string[] = [`得物は${weaponWord(p.weaponTier)}`];
  if (p.potions > 0) carry.push(p.potions > 1 ? '薬（いくつか）' : '薬');
  if (p.food > 0) carry.push(p.food > 1 ? '糧食（いくつか）' : '糧食');
  if (p.hasTreasure) carry.push('井戸の底の宝');
  stateLines.push(`  持ち物：${carry.join('、')}`);
  parts.push(box('状態', stateLines.join('\n')));

  // デバッグ枠（?debug=1 またはバッククォートでトグル。通常プレイでは一切出ない＝憲法5維持）
  if (opts.debug) {
    parts.push(box('DEBUG（開発者用・内部数値）', renderDebug(state)));
  }

  return parts.join('\n');
}
