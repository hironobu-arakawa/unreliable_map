// 信頼度システム §6
// 情報源 → 内部確率 p の基準帯、および p → 表示ラベルの射影。
// ラベルは p の正直な量子化であり、全情報で共通・不変（憲法6）。

import type { InfoSource } from './types';
import type { RNG } from './rng';
import { randRange } from './rng';

/** 情報源ごとの内部確率の基準帯（§6.1）。下限を0に、上限を1にしない（自分の観測を除く） */
export const SOURCE_P_BAND: Record<InfoSource, [number, number]> = {
  traversed: [1.0, 1.0], // 自分が踏破した地形（確定）
  sight: [0.95, 1.0], // 視界内で見た地形
  sense: [0.6, 0.8], // 音・匂い・気配
  oldMap: [0.4, 0.8], // 古い見取り図
  survivorNote: [0.3, 0.7], // 生還者メモ
  deathNote: [0.2, 0.6], // 死亡者メモ
  ownLog: [0.7, 0.9], // 自分の過去ログ
  aiHint: [0.5, 0.75], // AI的な助言（v0.1未使用、枠のみ）
};

/** 情報源の帯から内部確率を1つ引く */
export function drawInternalP(rng: RNG, source: InfoSource): number {
  const [lo, hi] = SOURCE_P_BAND[source];
  if (lo === hi) return lo;
  return randRange(rng, lo, hi);
}

export type ConfidenceLabel = '確か' | 'かなり信じられる' | 'ありそう' | '怪しい' | '噂程度';

/**
 * 内部確率 → 表示ラベル（§6.2）。UIにはこのラベルのみ出す（憲法5）。
 * 帯の対応は全情報で共通・不変。
 */
export function confidenceLabel(p: number): ConfidenceLabel {
  if (p >= 0.95) return '確か';
  if (p >= 0.8) return 'かなり信じられる';
  if (p >= 0.6) return 'ありそう';
  if (p >= 0.4) return '怪しい';
  return '噂程度';
}

/** 情報源の表示名 */
export const SOURCE_NAMES: Record<InfoSource, string> = {
  traversed: '踏破',
  sight: '視界',
  sense: '気配',
  oldMap: '古い見取り図',
  survivorNote: '生還者のメモ',
  deathNote: '死亡者のメモ',
  ownLog: '自分の記録',
  aiHint: '囁き',
};

// ---- 信頼度の物理的手がかり（v0.3） ----
// 「怪しい」等のラベルを直接見せる代わりに、字の乱れ・紙の状態・聞こえ方などの
// 物理描写で信頼度を伝える。語彙は内部確率帯ごとに固定（憲法6: 正直な射影）。
// プレイヤーが学ぶのは「乱れた字≒五分」——翻訳表の学習可能性はそのまま。

/** 書かれたもの（古地図・メモ）の手がかり語彙。帯ごとに固定 */
const WRITTEN_CUES: Record<ConfidenceLabel, string[]> = {
  確か: ['自分の目で確かめたことだ'],
  かなり信じられる: [
    '筆致は落ち着いていて、この迷宮の目印とも合っている',
    'インクはまだ新しく、線に迷いがない',
  ],
  ありそう: [
    '手慣れた筆跡だが、ところどころ滲んでいる',
    '折り目は多いが、線そのものは確かだ',
    '端が焦げているが、要点は読み取れる',
  ],
  怪しい: [
    '字が乱れている。急いで書いたようだ',
    '紙が傷んで、ところどころ判読できない',
    '別の筆跡で書き足された跡がある',
  ],
  噂程度: [
    '血で汚れ、ほとんど読み取れない',
    '紙が妙に綺麗すぎる——本当にここで描かれたのか',
    'この迷宮のことかどうかさえ、確かめようがない',
  ],
};

/** 感覚（気配・見立て）の手がかり語彙。帯ごとに固定 */
const SENSE_CUES: Record<ConfidenceLabel, string[]> = {
  確か: ['この耳ではっきり捉えた'],
  かなり信じられる: ['聞き間違えようがない'],
  ありそう: ['はっきり聞こえた', '匂いまで届いた', '手応えのある見立てだ'],
  怪しい: ['風の音と区別がつかない', '気のせいかもしれない'],
  噂程度: ['ほとんど当てずっぽうだ'],
};

/**
 * 情報源と内部確率から、信頼度の物理的手がかりを1つ引く。
 * 同じ帯からしか引かれない＝手がかりは嘘をつかない
 */
export function drawCue(rng: RNG, source: InfoSource, p: number): string {
  const label = confidenceLabel(p);
  const pool =
    source === 'sense' || source === 'sight' || source === 'traversed'
      ? SENSE_CUES[label]
      : WRITTEN_CUES[label];
  return pool[Math.floor(rng.next() * pool.length)];
}
