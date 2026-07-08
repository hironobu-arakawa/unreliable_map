// 画面テキスト組み立て §11
// core の状態を読んで画面テキストを組み立てるだけ。ゲームロジックは持たない。
// 数字は一切表示しない（憲法5）。

import { confidenceLabel, SOURCE_NAMES } from '../core/confidence';
import { enemyAt, featureAt, itemAt } from '../core/generate';
import {
  armorWord,
  conditionWord,
  currentFloor,
  hungerWord,
  torchWord,
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

  const enemy = enemyAt(floor, p);
  if (enemy) return '&';

  const f = featureAt(floor, p);
  if (f) {
    switch (f.kind) {
      case 'stairsUp':
        return '<';
      case 'stairsDown':
        return '>';
      case 'spring':
      case 'driedSpring':
        return '~';
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

/** 画面全体のテキストを組み立てる（§11 の1画面） */
export function renderScreen(state: GameState): string {
  const parts: string[] = [];
  const floor = currentFloor(state);
  const character = state.instance.character;

  // 終局画面
  if (state.phase === 'dead' && state.deathLog) {
    parts.push(`${character.name}\n`);
    parts.push(state.deathLog.join('\n'));
    parts.push('');
    parts.push(box('最後の出来事', state.events.map((e) => `  ${e}`).join('\n')));
    return parts.join('\n');
  }
  if (state.phase === 'escaped' && state.escapeLog) {
    parts.push(`${character.name}\n`);
    parts.push(state.escapeLog.join('\n'));
    return parts.join('\n');
  }

  // タイトル
  parts.push(`${character.name} B${floor.depth}F`);
  parts.push('');

  // マップ枠
  parts.push(renderMap(state));
  parts.push('');
  parts.push('  @=あなた .=歩いた床 ,=見えている床 #=壁 ?=未知の境界');
  parts.push('  <=上り階段 >=下り階段 ~=泉 $=宝 &=何かいる *=落し物 x=崩落 ^=罠の跡');
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
    `  ${armorWord(p.armorWear)}。${torchWord(p.torch)}。`,
  ];
  if (p.poisonTurns > 0) stateLines.push('  毒が回っている。');
  const carry: string[] = [];
  if (p.hasWeapon) carry.push('剣');
  if (p.potions > 0) carry.push(p.potions > 1 ? '薬（いくつか）' : '薬');
  if (p.food > 0) carry.push(p.food > 1 ? '糧食（いくつか）' : '糧食');
  if (p.hasTreasure) carry.push('井戸の底の宝');
  stateLines.push(`  持ち物：${carry.length > 0 ? carry.join('、') : '何もない'}`);
  parts.push(box('状態', stateLines.join('\n')));

  return parts.join('\n');
}
