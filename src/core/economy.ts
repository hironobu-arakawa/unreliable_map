// 宝石と銀貨 v0.7
// 宝石は迷宮で拾い、生還すればギルドの帳場が銀貨に換える。死ねば大地に還る。
// 銀貨はギルドの預り金として帳面（profile）に残り、支度の買い足しに使える。
// 価値は歴史的事実（台帳の数字）なので、数字で見せてよい——内部確率ではない（憲法5の範囲外）。

import type { RNG } from './rng';
import { pickWeighted } from './rng';
import type { GemKind } from './types';

export const GEM_DATA: Record<GemKind, { name: string; value: number }> = {
  garnet: { name: '小粒の紅玉', value: 25 },
  moonstone: { name: '月長石', value: 40 },
  sapphire: { name: '澄んだ青玉', value: 70 },
};

/** 深さに応じて宝石の種類を引く（深いほど良い石が眠る） */
export function rollGemKind(rng: RNG, depthFrac: number): GemKind {
  return pickWeighted(rng, [
    ['garnet', 0.6 - depthFrac * 0.3],
    ['moonstone', 0.3],
    ['sapphire', 0.1 + depthFrac * 0.35],
  ] as const);
}

/** 手持ちの宝石の換金総額（銀貨） */
export function gemTotal(gems: Record<string, number>): number {
  let total = 0;
  for (const [kind, count] of Object.entries(gems)) {
    total += (GEM_DATA[kind as GemKind]?.value ?? 0) * count;
  }
  return total;
}

/** 手持ちの宝石の言葉での列挙（例: 小粒の紅玉、月長石×2） */
export function describeGems(gems: Record<string, number>): string[] {
  const parts: string[] = [];
  for (const [kind, count] of Object.entries(gems)) {
    if (count <= 0) continue;
    const name = GEM_DATA[kind as GemKind]?.name ?? '石';
    parts.push(count > 1 ? `${name}×${count}` : name);
  }
  return parts;
}
