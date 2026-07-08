// 情報の当否解決・外れ方の選択 §8
// roll < p なら hold（当たり）。外れる場合も単なる二値にせず、
// 「読めば予測できたかもしれない」外れ方を重みで選ぶ（憲法4）。
// v0.1では「完全な誤情報」の重みを十分低くする。

import type { MissPattern } from './types';
import type { RNG } from './rng';
import { pickWeighted } from './rng';

/** 外れ方の重み（§8の表）。理不尽度の低いものを優先 */
export const MISS_WEIGHTS: readonly (readonly [MissPattern, number])[] = [
  ['drift', 0.32], // 位置が少しズレる（低理不尽・高頻度）
  ['condition', 0.28], // 内容は合うが条件が違う
  ['stale', 0.17], // 古い情報だった
  ['misread', 0.17], // 主観の誤認
  ['false', 0.06], // 完全な誤情報（稀）
];

export type Resolution = { held: true } | { held: false; missPattern: MissPattern };

/**
 * 情報の当否を解決する。
 * @param allowed その情報種別で意味を成す外れ方の候補（省略時は全種）
 */
export function resolveInfo(rng: RNG, internalP: number, allowed?: MissPattern[]): Resolution {
  if (rng.next() < internalP) return { held: true };
  const pool = allowed
    ? MISS_WEIGHTS.filter(([m]) => allowed.includes(m))
    : MISS_WEIGHTS;
  // 候補が空になることは呼び出し側の設計ミスだが、安全側に「drift」へ倒す
  const missPattern = pool.length > 0 ? pickWeighted(rng, pool) : 'drift';
  return { held: false, missPattern };
}

/** 外れ方の内部名 → 開発者向け表示（計測ログ用） */
export const MISS_PATTERN_NAMES: Record<MissPattern, string> = {
  drift: '位置ズレ',
  condition: '条件違い',
  stale: '古い情報',
  misread: '誤認',
  false: '完全な誤情報',
};
