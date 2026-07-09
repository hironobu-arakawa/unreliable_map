// 潜り手の帳面（メタ永続化）。
// 生還すれば装備を持ち出せる、死ねば失う——結末の差はここに残る。
// localStorage に触れるのはUI層のみ（coreは純粋 §4.1）。

import type { StartKit } from '../core/state';
import type { PlayerState } from '../core/types';

/** 穴（性格）ごとの戦績。台帳に載る歴史的事実であり、内部確率ではない */
export type WellRecord = {
  dives: number;
  escapes: number;
  treasures: number;
  deaths: number;
  /** 生還して報告できた最深階。死者は深さを報告できない */
  deepest: number;
};

export type Profile = {
  version: 1;
  wells: Record<string, WellRecord>;
  /** 前回の生還で持ち出した品。死ぬと null（組合の標準の支度に戻る） */
  carryover: StartKit | null;
};

const STORAGE_KEY = 'unreliable-map/profile/v1';

function emptyProfile(): Profile {
  return { version: 1, wells: {}, carryover: null };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as Profile;
    if (parsed.version !== 1) return emptyProfile();
    return parsed;
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // プライベートモード等で保存できなくても、その場のプレイは続けられる
  }
}

export function wellRecord(profile: Profile, characterId: string): WellRecord {
  const rec = (profile.wells[characterId] ??= {
    dives: 0,
    escapes: 0,
    treasures: 0,
    deaths: 0,
    deepest: 0,
  });
  return rec;
}

/** 生還時: いま担いでいる品がそのまま次の支度になる（燃えさしの松明は数えない） */
export function kitFromPlayer(p: PlayerState): StartKit {
  const talismans: Record<string, number> = {};
  for (const [pattern, count] of Object.entries(p.talismans)) {
    if (count > 0) talismans[pattern] = count;
  }
  return {
    potions: p.potions,
    food: p.food,
    stones: p.stones,
    spareTorches: p.spareTorches,
    weaponTier: p.weaponTier,
    talismans,
  };
}

/** 台帳での持ち越し品の表記（帳場の声なので個数で書く。潜行中の言葉とは別） */
export function describeKit(kit: StartKit): string {
  const parts: string[] = [];
  if (kit.weaponTier >= 2) parts.push('剣');
  if (kit.potions > 0) parts.push(`薬×${kit.potions}`);
  if (kit.food > 0) parts.push(`糧食×${kit.food}`);
  if (kit.stones > 0) parts.push(`石×${kit.stones}`);
  if (kit.spareTorches > 0) parts.push(`予備の松明×${kit.spareTorches}`);
  for (const [pattern, count] of Object.entries(kit.talismans)) {
    parts.push(`${pattern}の札×${count}`);
  }
  return parts.join('、');
}
