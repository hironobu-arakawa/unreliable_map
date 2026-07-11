// 行動選択 §11
// core の availableActions を読んでボタンを並べ、選択を core に渡すだけ。
// v0.10.1: 行動が増えたため2段階メニューにする。
//   1段目 = 移動・挑む/退く・その場の行動。「投げる…」「荷袋…」はカテゴリボタン。
//   2段目 = カテゴリの中身＋「戻る」。中身が1件だけなら畳まず1段目に直接出す。
// メニューの開閉はUIの状態であり、coreのターンは一切進まない。

import { armorShortWord, weaponWord } from '../core/gear';
import { itemAt } from '../core/generate';
import {
  availableActions,
  currentFloor,
  POTION_NAMES,
  type Action,
  type GameState,
} from '../core/state';

const ACTION_LABELS: Record<string, string> = {
  listen: '耳を澄ます',
  rest: '休む',
  checkPack: '荷を検める',
  steal: '眠る相手の懐を探る',
  throwFireOil: '火油の瓶を投げる',
  descend: '階段を降りる',
  ascend: '階段を上る',
  escape: '地上へ脱出する',
  eat: '糧食を食べる',
  drink: '泉の水を飲む',
  open: '箱を開ける',
  inspect: '調べる',
  engage: '挑む',
  retreat: '退く',
  throwStone: '石を投げる',
};

const DIR_LABELS: Record<string, string> = {
  north: '北へ',
  south: '南へ',
  west: '西へ',
  east: '東へ',
};

export function actionLabel(a: Action, state?: GameState): string {
  if (a.type === 'move') return DIR_LABELS[a.dir];
  if (a.type === 'throwTalisman') return `${a.pattern}の札を投げる`;
  if (a.type === 'drinkPotion') return `${POTION_NAMES[a.kind] ?? '薬'}を飲む`;
  // 打ち合いが始まったら「挑む」ではなく「打ち込む」（ターン制戦闘の一手）
  if (a.type === 'engage' && state?.pending && state.pending.rounds > 0) return '打ち込む';
  if (a.type === 'equipWeapon') {
    const w = state?.player.weapons[a.index];
    return w ? `${weaponWord(w)}に持ち替える` : '持ち替える';
  }
  if (a.type === 'equipArmor') {
    if (!state) return '着替える';
    const it = itemAt(currentFloor(state), state.pos);
    return it?.armorGear ? `${armorShortWord(it.armorGear)}に着替える` : '着替える';
  }
  return ACTION_LABELS[a.type] ?? a.type;
}

// ---- 2段階メニュー ----

export type MenuCategory = 'throw' | 'bag';

const CATEGORY_LABELS: Record<MenuCategory, string> = {
  throw: '投げる',
  bag: '荷袋',
};

/**
 * 行動のカテゴリ分け。null は1段目に直接出す。
 * 「荷を検める」「持ち替え/着替え」は狙って探す行動なので畳まず1段目に置く
 * （荷袋に畳むのは、増えがちな消耗品＝薬・糧食だけ）。
 */
function categoryOf(a: Action): MenuCategory | null {
  switch (a.type) {
    case 'throwStone':
    case 'throwFireOil':
    case 'throwTalisman':
      return 'throw';
    case 'drinkPotion':
    case 'eat':
      return 'bag';
    default:
      return null;
  }
}

export type MenuEntry =
  | { kind: 'action'; action: Action }
  | { kind: 'category'; category: MenuCategory; count: number }
  | { kind: 'back' };

/** いま画面に並べるべきボタンの一覧（ボタン描画とキーボードで共有する） */
export function menuEntries(state: GameState, menu: MenuCategory | null): MenuEntry[] {
  const actions = availableActions(state);
  if (menu) {
    const inside: MenuEntry[] = actions
      .filter((a) => categoryOf(a) === menu)
      .map((a) => ({ kind: 'action', action: a }));
    inside.push({ kind: 'back' });
    return inside;
  }
  const top: MenuEntry[] = [];
  const counts = new Map<MenuCategory, number>();
  for (const a of actions) {
    const c = categoryOf(a);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    else top.push({ kind: 'action', action: a });
  }
  for (const [category, count] of counts) {
    if (count === 1) {
      // 1件だけのカテゴリは畳まない（ワンクッションの意味がない）
      const only = actions.find((a) => categoryOf(a) === category)!;
      top.push({ kind: 'action', action: only });
    } else {
      top.push({ kind: 'category', category, count });
    }
  }
  return top;
}

function entryLabel(e: MenuEntry, state: GameState): string {
  if (e.kind === 'action') return actionLabel(e.action, state);
  if (e.kind === 'category') return `${CATEGORY_LABELS[e.category]}…（${e.count}）`;
  return '戻る';
}

/** 行動ボタンを描画する。番号キー・矢印キーでも選べる */
export function renderActions(
  container: HTMLElement,
  state: GameState,
  onAction: (a: Action) => void,
  menu: MenuCategory | null,
  onMenu: (m: MenuCategory | null) => void,
): void {
  container.innerHTML = '';
  const entries = menuEntries(state, menu);
  entries.forEach((e, i) => {
    const btn = document.createElement('button');
    if (i < 9) {
      const kbd = document.createElement('kbd');
      kbd.textContent = `${i + 1}`;
      btn.appendChild(kbd);
    }
    btn.appendChild(document.createTextNode(entryLabel(e, state)));
    if (e.kind !== 'action') btn.classList.add('cat');
    btn.addEventListener('click', () => {
      if (e.kind === 'action') onAction(e.action);
      else if (e.kind === 'category') onMenu(e.category);
      else onMenu(null);
    });
    container.appendChild(btn);
  });
}

/** キーボード入力（矢印=移動、数字=ボタン順、Esc=メニューを閉じる）。台帳画面では state が無い */
export function bindKeyboard(
  getState: () => GameState | null,
  onAction: (a: Action) => void,
  getMenu: () => MenuCategory | null,
  onMenu: (m: MenuCategory | null) => void,
): void {
  window.addEventListener('keydown', (ev) => {
    const state = getState();
    if (!state) return;
    const menu = getMenu();

    if (ev.key === 'Escape' && menu) {
      ev.preventDefault();
      onMenu(null);
      return;
    }

    // 矢印はいつでも移動（サブメニューを開いていても、動けば閉じる）
    const dirByKey: Record<string, 'north' | 'south' | 'west' | 'east'> = {
      ArrowUp: 'north',
      ArrowDown: 'south',
      ArrowLeft: 'west',
      ArrowRight: 'east',
    };
    const dir = dirByKey[ev.key];
    if (dir) {
      const move = availableActions(state).find((a) => a.type === 'move' && a.dir === dir);
      if (move) {
        ev.preventDefault();
        onAction(move);
      }
      return;
    }

    const entries = menuEntries(state, menu);
    const n = Number(ev.key);
    if (Number.isInteger(n) && n >= 1 && n <= entries.length) {
      ev.preventDefault();
      const e = entries[n - 1];
      if (e.kind === 'action') onAction(e.action);
      else if (e.kind === 'category') onMenu(e.category);
      else onMenu(null);
    }
  });
}
