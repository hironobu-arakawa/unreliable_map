// ギルドの帳場（店）。台帳画面で、預り金（銀貨）から次の潜行の支度を買い足す。
// 買った品は carryover（次の支度）に積まれ、ギルドの標準を下回る買い物は
// 標準ぶんに上乗せされる（mergeKit の「多い方を採る」で買い物が消えないように）。

import { WEAPON_CAP } from '../core/gear';
import type { StartKit } from '../core/state';
import { BASE_KIT, FOOD_CAP, POTION_TOTAL_CAP, potionTotal, STONE_CAP } from '../core/state';

export type ShopItem = {
  id: string;
  label: string;
  price: number; // 銀貨
  /** 帳場の一言 */
  note: string;
  apply(kit: StartKit): void;
  /** 買えない事情があるか（例: 腰の得物が上限）。省略時は常に買える */
  canBuy?(kit: StartKit): boolean;
};

/** carryover が空の時の器。ギルドの標準そのもの（この上に買い物を積む） */
export function baseKitClone(): StartKit {
  return {
    potions: { ...BASE_KIT.potions },
    food: BASE_KIT.food,
    stones: BASE_KIT.stones,
    spareTorches: BASE_KIT.spareTorches,
    fireOil: BASE_KIT.fireOil,
    weapons: BASE_KIT.weapons.map((w) => ({ ...w })),
    armor: BASE_KIT.armor ? { ...BASE_KIT.armor } : null,
    talismans: {},
  };
}

/** 数もの: ギルド標準を下回っていたら標準まで引き上げてから1つ足す */
function addCount(current: number, base: number): number {
  return Math.max(current, base) + 1;
}

/** 薬が買えるか: 合計の上限（内訳は自由）。標準までの引き上げぶんも数えて判定する */
function canBuyPotion(kit: StartKit, kind: string, base = 0): boolean {
  const cur = kit.potions[kind] ?? 0;
  const delta = addCount(cur, base) - cur;
  return potionTotal(kit.potions) + delta <= POTION_TOTAL_CAP;
}

export const SHOP_ITEMS: ShopItem[] = [
  {
    id: 'salve',
    label: '傷薬',
    price: 8,
    note: '銘は確かだが、効きは穴の水次第だ。',
    apply(kit) {
      kit.potions.salve = addCount(kit.potions.salve ?? 0, BASE_KIT.potions.salve ?? 0);
    },
    canBuy(kit) {
      return canBuyPotion(kit, 'salve', BASE_KIT.potions.salve ?? 0);
    },
  },
  {
    id: 'antidote',
    label: '解毒薬',
    price: 6,
    note: '毒の仕掛けの多い穴なら、安い保険だ。',
    apply(kit) {
      kit.potions.antidote = addCount(kit.potions.antidote ?? 0, 0);
    },
    canBuy(kit) {
      return canBuyPotion(kit, 'antidote');
    },
  },
  {
    id: 'tonic',
    label: '滋養薬',
    price: 6,
    note: '重く甘い。長潜りの友。',
    apply(kit) {
      kit.potions.tonic = addCount(kit.potions.tonic ?? 0, 0);
    },
    canBuy(kit) {
      return canBuyPotion(kit, 'tonic');
    },
  },
  {
    id: 'elixir',
    label: '霊薬',
    price: 22,
    note: '深手を一息に塞ぐ。値は張る。',
    apply(kit) {
      kit.potions.elixir = addCount(kit.potions.elixir ?? 0, 0);
    },
    canBuy(kit) {
      return canBuyPotion(kit, 'elixir');
    },
  },
  {
    id: 'food',
    label: '糧食',
    price: 4,
    note: '飢えは静かに殺しに来る。',
    apply(kit) {
      kit.food = addCount(kit.food, BASE_KIT.food);
    },
    canBuy(kit) {
      return kit.food < FOOD_CAP;
    },
  },
  {
    id: 'torch',
    label: '予備の松明',
    price: 5,
    note: '暗闇は計画の失敗として訪れる。',
    apply(kit) {
      kit.spareTorches = addCount(kit.spareTorches, BASE_KIT.spareTorches);
    },
  },
  {
    id: 'stone',
    label: '石',
    price: 2,
    note: '投げるにはちょうどいい。',
    apply(kit) {
      kit.stones = addCount(kit.stones, BASE_KIT.stones);
    },
    canBuy(kit) {
      return kit.stones < STONE_CAP;
    },
  },
  {
    id: 'fireOil',
    label: '火油の瓶',
    price: 20,
    note: '金物も獣も影も、よく焼ける。だが逃げ場のない場所で使えば、己も焼く。',
    apply(kit) {
      kit.fireOil = (kit.fireOil ?? 0) + 1;
    },
  },
  {
    id: 'sword',
    label: '剣',
    price: 30,
    note: '刃は生きている。手入れもしてある。',
    apply(kit) {
      kit.weapons.push({ kind: 'sword', wear: 10 });
    },
    canBuy(kit) {
      return kit.weapons.length < WEAPON_CAP;
    },
  },
  {
    id: 'dagger',
    label: '短剣',
    price: 10,
    note: '替えの一本。折れた時に効いてくる。',
    apply(kit) {
      kit.weapons.push({ kind: 'dagger', wear: 10 });
    },
    canBuy(kit) {
      return kit.weapons.length < WEAPON_CAP;
    },
  },
  {
    id: 'leather',
    label: '革鎧（仕立て直し）',
    price: 15,
    note: 'ぼろの上からは着られない。着替えだ。',
    apply(kit) {
      kit.armor = { kind: 'leather', wear: 5 };
    },
  },
  {
    id: 'chain',
    label: '鎖帷子',
    price: 50,
    note: '重いが、爪も牙もよく止める。',
    apply(kit) {
      kit.armor = { kind: 'chain', wear: 10 };
    },
  },
  {
    id: 'fine',
    label: '業物の剣',
    price: 100,
    note: '帳場の奥から出てくる逸品。一生ものだ——生きていれば。',
    apply(kit) {
      kit.weapons.push({ kind: 'fine', wear: 5 });
    },
    canBuy(kit) {
      return kit.weapons.length < WEAPON_CAP;
    },
  },
];

/** 整備費: 持ち帰った装備の傷みの合計 × 0.1（切り上げ）。直せるのは地上だけ */
export function repairFee(kit: StartKit | null): number {
  if (!kit) return 0;
  const gear = [...kit.weapons, ...(kit.armor ? [kit.armor] : [])];
  const totalWear = gear.reduce((s, g) => s + g.wear, 0);
  return Math.ceil(totalWear * 0.1);
}

/** 整備の実行: 傷みをすべて新品同様に戻す */
export function repairAll(kit: StartKit): void {
  for (const w of kit.weapons) w.wear = 0;
  if (kit.armor) kit.armor.wear = 0;
}
