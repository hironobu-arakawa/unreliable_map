// ギルドの帳場（店）。台帳画面で、預り金（銀貨）から次の潜行の支度を買い足す。
// 買った品は carryover（次の支度）に積まれ、ギルドの標準を下回る買い物は
// 標準ぶんに上乗せされる（mergeKit の「多い方を採る」で買い物が消えないように）。

import type { StartKit } from '../core/state';
import { BASE_KIT } from '../core/state';

export type ShopItem = {
  id: string;
  label: string;
  price: number; // 銀貨
  /** 帳場の一言 */
  note: string;
  apply(kit: StartKit): void;
};

/** carryover が空の時の器。ギルドの標準そのもの（この上に買い物を積む） */
export function baseKitClone(): StartKit {
  return {
    potions: { ...BASE_KIT.potions },
    food: BASE_KIT.food,
    stones: BASE_KIT.stones,
    spareTorches: BASE_KIT.spareTorches,
    weapons: BASE_KIT.weapons.map((w) => ({ ...w })),
    armor: BASE_KIT.armor ? { ...BASE_KIT.armor } : null,
    talismans: {},
  };
}

/** 数もの: ギルド標準を下回っていたら標準まで引き上げてから1つ足す */
function addCount(current: number, base: number): number {
  return Math.max(current, base) + 1;
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
  },
  {
    id: 'antidote',
    label: '解毒薬',
    price: 6,
    note: '毒の仕掛けの多い穴なら、安い保険だ。',
    apply(kit) {
      kit.potions.antidote = addCount(kit.potions.antidote ?? 0, 0);
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
  },
  {
    id: 'elixir',
    label: '霊薬',
    price: 22,
    note: '深手を一息に塞ぐ。値は張る。',
    apply(kit) {
      kit.potions.elixir = addCount(kit.potions.elixir ?? 0, 0);
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
  },
  {
    id: 'sword',
    label: '剣',
    price: 30,
    note: '刃は生きている。手入れもしてある。',
    apply(kit) {
      kit.weapons.push({ kind: 'sword', wear: 10 });
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
];
