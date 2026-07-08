// 単一のシード付きPRNG（mulberry32）。
// 憲法・§4.2: core内で Math.random() の使用を禁止。乱数はすべてこのモジュール経由。

export type RNG = {
  /** 0以上1未満の一様乱数 */
  next(): number;
};

/** mulberry32: 小さく高速で再現性のあるPRNG */
export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * runSeed から用途別のサブシードを決定論的に導出する。
 * 例: hashSeed(runSeed, 'hearsay', 2) → 古地図生成用の別シード
 */
export function hashSeed(...parts: (number | string)[]): number {
  // FNV-1a 風の単純ハッシュ（暗号用途ではない。再現性のみが目的）
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x9e3779b9;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** min以上max以下の整数 */
export function randInt(rng: RNG, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

/** min以上max未満の実数 */
export function randRange(rng: RNG, min: number, max: number): number {
  return min + rng.next() * (max - min);
}

/** 配列から1つ選ぶ */
export function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.floor(rng.next() * arr.length)];
}

/** 重み付き抽選。重みの合計は1でなくてよい */
export function pickWeighted<T>(rng: RNG, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [value, w] of items) {
    r -= w;
    if (r <= 0) return value;
  }
  return items[items.length - 1][0];
}

/** 配列をシャッフルした新配列を返す（Fisher–Yates） */
export function shuffle<T>(rng: RNG, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
