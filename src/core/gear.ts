// 装備（得物・鎧）v0.6
// 武器・防具は段階値ではなく「個別の傷みを持つアイテム」。
// 拾い、持ち替え、擦り減らし、生還すれば持ち越す（死ねば失う）。
// 数字はUIに出さない——傷みは言葉で見せる（憲法5）。

import type { RNG } from './rng';
import { pickWeighted } from './rng';
import type { ArmorGear, ArmorKind, WeaponGear, WeaponKind } from './types';

export const WEAPON_DATA: Record<WeaponKind, { name: string; power: number }> = {
  dagger: { name: '短剣', power: 0.16 },
  sword: { name: '剣', power: 0.26 },
  fine: { name: '業物の剣', power: 0.33 }, // 帳場でしか手に入らない長期目標
};

export const ARMOR_DATA: Record<ArmorKind, { name: string; guard: number }> = {
  leather: { name: '革鎧', guard: 0.15 },
  chain: { name: '鎖帷子', guard: 0.35 },
};

/** 素手の打撃力（得物がないとき） */
export const FIST_POWER = 0.09;

/** 拵えの出来（bonus）1段あたりの効き。武器は威力、鎧はガードに足される */
export const WEAPON_BONUS_STEP = 0.02;
export const ARMOR_BONUS_STEP = 0.03;

/** 拵えの表示（+2 / -1）。0は付けない */
export function bonusSuffix(bonus: number | undefined): string {
  const b = bonus ?? 0;
  if (b === 0) return '';
  return b > 0 ? `+${b}` : `${b}`;
}

/**
 * 拾い物の拵えの出来を引く（-2〜+3）。深いほど良い拵えが眠る。
 * 帳場で売る品は検分済みなので常に0（掘る楽しみは迷宮の側に置く）
 */
export function rollGearBonus(rng: RNG, depthFrac: number): number {
  return pickWeighted(rng, [
    [-2, 0.07 * (1 - depthFrac * 0.5)],
    [-1, 0.15 * (1 - depthFrac * 0.4)],
    [0, 0.45],
    [1, 0.15 + depthFrac * 0.08],
    [2, 0.08 + depthFrac * 0.08],
    [3, 0.03 + depthFrac * 0.06],
  ] as const);
}

/** いま手にしている得物の実効打撃力。傷んだ刃は威力が落ちる */
export function weaponPower(w: WeaponGear | undefined): number {
  if (!w) return FIST_POWER;
  const base = WEAPON_DATA[w.kind].power + (w.bonus ?? 0) * WEAPON_BONUS_STEP;
  return w.wear >= 70 ? base * 0.8 : base;
}

/** 鎧の実効ガード（受けた打撃をどれだけ殺すか 0..1）。傷んだ鎧は守りが薄い */
export function armorGuard(a: ArmorGear | null): number {
  if (!a) return 0;
  const base = Math.max(0.02, ARMOR_DATA[a.kind].guard + (a.bonus ?? 0) * ARMOR_BONUS_STEP);
  return a.wear >= 70 ? base * 0.4 : a.wear >= 40 ? base * 0.7 : base;
}

/** 得物の言葉（例: 傷んだ短剣・折れかけの剣+2）。wear帯→語は固定＝数字は漏れない */
export function weaponWord(w: WeaponGear | undefined): string {
  if (!w) return '素手';
  const base = WEAPON_DATA[w.kind].name + bonusSuffix(w.bonus);
  if (w.wear >= 70) return `折れかけの${base}`;
  if (w.wear >= 40) return `傷んだ${base}`;
  return base;
}

/** 鎧の短い呼び名（例: 傷んだ革鎧+1）。台帳・持ち物向け */
export function armorShortWord(a: ArmorGear): string {
  const base = ARMOR_DATA[a.kind].name + bonusSuffix(a.bonus);
  if (a.wear >= 70) return `ぼろぼろの${base}`;
  if (a.wear >= 40) return `傷んだ${base}`;
  return base;
}

/** 鎧の言葉（状態行に出す一文） */
export function armorWord(a: ArmorGear | null): string {
  if (!a) return '身を守るものがない';
  const base = ARMOR_DATA[a.kind].name + bonusSuffix(a.bonus);
  if (a.wear >= 70) return `${base}はぼろぼろだ`;
  if (a.wear >= 40) return `${base}は傷んでいる`;
  return `${base}はまだ保つ`;
}

/** 得物どうしの優劣（持ち替え判断）。拵え込みの威力が高い方、同威力なら傷みの浅い方 */
export function weaponBetter(a: WeaponGear, b: WeaponGear): boolean {
  const pa = WEAPON_DATA[a.kind].power + (a.bonus ?? 0) * WEAPON_BONUS_STEP;
  const pb = WEAPON_DATA[b.kind].power + (b.bonus ?? 0) * WEAPON_BONUS_STEP;
  if (pa !== pb) return pa > pb;
  return a.wear < b.wear;
}

/** 手持ちに加え、最良の得物が先頭（＝手にしている）になるよう並べる */
export function addWeapon(weapons: WeaponGear[], w: WeaponGear): void {
  weapons.push(w);
  weapons.sort((x, y) => (weaponBetter(x, y) ? -1 : 1));
}
