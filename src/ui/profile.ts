// 潜り手の帳面（メタ永続化）。
// 生還すれば装備を持ち出せる、死ねば失う——結末の差はここに残る。
// localStorage に触れるのはUI層のみ（coreは純粋 §4.1）。

import { POTION_NAMES } from '../core/character';
import { armorShortWord, weaponWord } from '../core/gear';
import type { StartKit } from '../core/state';
import type { PlayerState, WeaponGear } from '../core/types';

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
  version: 2;
  wells: Record<string, WellRecord>;
  /** 前回の生還で持ち出した品。死ぬと null（ギルドの標準の支度に戻る） */
  carryover: StartKit | null;
  /** 最後に開いていたギルド支部（台帳画面の復元用） */
  lastBranch?: string;
};

const STORAGE_KEY = 'unreliable-map/profile/v1';

function emptyProfile(): Profile {
  return { version: 2, wells: {}, carryover: null };
}

/** v1（weaponTier/番号の薬）→ v2（装備アイテム）の移行 */
function migrate(parsed: Record<string, unknown>): Profile {
  const p = parsed as unknown as Profile & { version: number };
  if (p.version === 2) return p;
  if (p.version !== 1) return emptyProfile();
  const carry = p.carryover as unknown as {
    potions?: unknown;
    weaponTier?: number;
    weapons?: WeaponGear[];
    armor?: unknown;
  } | null;
  if (carry) {
    // 薬が本数（number）だった頃の持ち越しは傷薬として扱う
    if (typeof carry.potions === 'number') {
      carry.potions = carry.potions > 0 ? { salve: carry.potions } : {};
    }
    // weaponTier → 装備アイテム。鎧の記録はなかったので標準の革鎧に
    const tier = carry.weaponTier ?? 1;
    carry.weapons =
      tier >= 2
        ? [{ kind: 'sword', wear: 30 }]
        : tier === 1
          ? [{ kind: 'dagger', wear: 45 }]
          : [];
    carry.armor = { kind: 'leather', wear: 10 };
    delete carry.weaponTier;
  }
  return { ...p, version: 2 } as Profile;
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProfile();
    return migrate(JSON.parse(raw) as Record<string, unknown>);
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
  const potions: Record<string, number> = {};
  for (const [kind, count] of Object.entries(p.potions)) {
    if (count > 0) potions[kind] = count;
  }
  return {
    potions,
    food: p.food,
    stones: p.stones,
    spareTorches: p.spareTorches,
    weapons: p.weapons.filter((w) => w.wear < 100).map((w) => ({ ...w })),
    armor: p.armor ? { ...p.armor } : null,
    talismans,
  };
}

/** 台帳での持ち越し品の表記（帳場の声なので個数で書く。潜行中の言葉とは別） */
export function describeKit(kit: StartKit): string {
  const parts: string[] = [];
  for (const w of kit.weapons) parts.push(weaponWord(w));
  if (kit.armor) parts.push(armorShortWord(kit.armor));
  for (const [kind, count] of Object.entries(kit.potions)) {
    if (count > 0) parts.push(`${POTION_NAMES[kind] ?? '薬'}×${count}`);
  }
  if (kit.food > 0) parts.push(`糧食×${kit.food}`);
  if (kit.stones > 0) parts.push(`石×${kit.stones}`);
  if (kit.spareTorches > 0) parts.push(`予備の松明×${kit.spareTorches}`);
  for (const [pattern, count] of Object.entries(kit.talismans)) {
    parts.push(`${pattern}の札×${count}`);
  }
  return parts.join('、');
}
