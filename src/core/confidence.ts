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
