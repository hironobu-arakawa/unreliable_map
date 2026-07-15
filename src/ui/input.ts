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

/** プレイヤーから見た敵の方角の言葉（8方位）。狙いを撃ち分けるための目印 */
function foeDir(state: GameState, targetId: string): { dir: string; name: string } | null {
  const floor = currentFloor(state);
  const e = floor.entities.find((x) => x.id === targetId && x.alive);
  if (!e) return null;
  const dx = e.pos.x - state.pos.x;
  const dy = e.pos.y - state.pos.y;
  const ns = dy < 0 ? '北' : dy > 0 ? '南' : '';
  const we = dx < 0 ? '西' : dx > 0 ? '東' : '';
  return { dir: ns + we || 'すぐ近く', name: e.name };
}

export function actionLabel(a: Action, state?: GameState): string {
  if (a.type === 'move') return DIR_LABELS[a.dir];
  if (a.type === 'drinkPotion') return `${POTION_NAMES[a.kind] ?? '薬'}を飲む`;
  if (a.type === 'throwStone' || a.type === 'throwFireOil' || a.type === 'throwTalisman') {
    const what =
      a.type === 'throwStone' ? '石' : a.type === 'throwFireOil' ? '火油' : `${a.pattern}の札`;
    const f = state ? foeDir(state, a.targetId) : null;
    return f ? `${what}を投げる（${f.dir}の${f.name}）` : `${what}を投げる`;
  }
  if (a.type === 'steal') {
    const f = state ? foeDir(state, a.targetId) : null;
    return f ? `眠る${f.name}の懐を探る` : '懐を探る';
  }
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

// ---- 多段メニュー（投げるは「何を→どこへ」の2段） ----

/** 投げる対象の品目 */
type ThrowWhat = { t: 'stone' } | { t: 'fireOil' } | { t: 'talisman'; pattern: string };

/** メニューの状態。null = 1段目 */
export type MenuState =
  | null
  | { m: 'bag' } // 荷袋（薬・糧食）
  | { m: 'throw' } // 投げる: 何を投げるか
  | { m: 'aim'; what: ThrowWhat }; // 投げる: どの敵（方向）へ

/** 品目の識別キー（同じ品目の投擲行動をまとめる） */
function throwKey(a: Action): string | null {
  if (a.type === 'throwStone') return 'stone';
  if (a.type === 'throwFireOil') return 'fireOil';
  if (a.type === 'throwTalisman') return `talisman:${a.pattern}`;
  return null;
}
function whatKey(w: ThrowWhat): string {
  return w.t === 'talisman' ? `talisman:${w.pattern}` : w.t;
}
function whatLabel(w: ThrowWhat): string {
  return w.t === 'stone' ? '石' : w.t === 'fireOil' ? '火油の瓶' : `${w.pattern}の札`;
}
function whatOf(a: Action): ThrowWhat | null {
  if (a.type === 'throwStone') return { t: 'stone' };
  if (a.type === 'throwFireOil') return { t: 'fireOil' };
  if (a.type === 'throwTalisman') return { t: 'talisman', pattern: a.pattern };
  return null;
}

export type MenuEntry =
  | { kind: 'action'; action: Action }
  | { kind: 'nav'; to: MenuState; label: string }
  | { kind: 'back'; to: MenuState };

/** 投げる対象の敵1体への行動ラベル（方向で撃ち分ける） */
function aimLabel(a: Action, state: GameState): string {
  const id =
    a.type === 'throwStone' || a.type === 'throwFireOil' || a.type === 'throwTalisman'
      ? a.targetId
      : '';
  const f = foeDir(state, id);
  return f ? `${f.dir}の${f.name}へ` : '投げる';
}

/** いま画面に並べるべきボタンの一覧（ボタン描画とキーボードで共有する） */
export function menuEntries(state: GameState, menu: MenuState): MenuEntry[] {
  const actions = availableActions(state);
  const throwActions = actions.filter((a) => throwKey(a) !== null);
  const bagActions = actions.filter((a) => a.type === 'drinkPotion' || a.type === 'eat');

  // --- サブ: 投げる（何を投げるか） ---
  if (menu && menu.m === 'throw') {
    const entries: MenuEntry[] = [];
    const seen = new Set<string>();
    for (const a of throwActions) {
      const w = whatOf(a)!;
      const k = whatKey(w);
      if (seen.has(k)) continue;
      seen.add(k);
      const targets = throwActions.filter((b) => throwKey(b) === throwKey(a));
      if (targets.length === 1) {
        // 狙える敵が1体だけなら方向選択を省いて直接投げる
        entries.push({ kind: 'action', action: targets[0] });
      } else {
        entries.push({ kind: 'nav', to: { m: 'aim', what: w }, label: `${whatLabel(w)}を投げる` });
      }
    }
    entries.push({ kind: 'back', to: null });
    return entries;
  }

  // --- サブ: 投げる先（方向＝敵）を選ぶ ---
  if (menu && menu.m === 'aim') {
    const target = whatKey(menu.what);
    const entries: MenuEntry[] = throwActions
      .filter((a) => throwKey(a) === target)
      .map((a) => ({ kind: 'action', action: a }) as MenuEntry);
    entries.push({ kind: 'back', to: { m: 'throw' } });
    return entries;
  }

  // --- サブ: 荷袋 ---
  if (menu && menu.m === 'bag') {
    const entries: MenuEntry[] = bagActions.map((a) => ({ kind: 'action', action: a }));
    entries.push({ kind: 'back', to: null });
    return entries;
  }

  // --- 1段目 ---
  const top: MenuEntry[] = [];
  for (const a of actions) {
    if (throwKey(a) !== null || a.type === 'drinkPotion' || a.type === 'eat') continue;
    top.push({ kind: 'action', action: a });
  }
  // 投げる: 品目が1つ×敵が1体なら直接、そうでなければ「投げる…」で畳む
  const throwItems = new Set(throwActions.map((a) => throwKey(a)!));
  if (throwActions.length === 1) {
    top.push({ kind: 'action', action: throwActions[0] });
  } else if (throwActions.length > 1) {
    top.push({ kind: 'nav', to: { m: 'throw' }, label: `投げる…（${throwItems.size}）` });
  }
  // 荷袋: 1件だけなら直接、複数なら畳む
  if (bagActions.length === 1) {
    top.push({ kind: 'action', action: bagActions[0] });
  } else if (bagActions.length > 1) {
    top.push({ kind: 'nav', to: { m: 'bag' }, label: `荷袋…（${bagActions.length}）` });
  }
  return top;
}

function entryLabel(e: MenuEntry, state: GameState): string {
  if (e.kind === 'back') return '戻る';
  if (e.kind === 'nav') return e.label;
  // aim サブメニューの中は「方向＝敵」で見せる
  return aimLabel(e.action, state);
}

/** 行動ボタンを描画する。番号キー・矢印キーでも選べる */
export function renderActions(
  container: HTMLElement,
  state: GameState,
  onAction: (a: Action) => void,
  menu: MenuState,
  onMenu: (m: MenuState) => void,
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
    // aim サブメニューのアクションだけ「方向＝敵」ラベル、それ以外は通常ラベル
    const label =
      e.kind === 'action' && menu && menu.m === 'aim'
        ? aimLabel(e.action, state)
        : e.kind === 'action'
          ? actionLabel(e.action, state)
          : entryLabel(e, state);
    btn.appendChild(document.createTextNode(label));
    if (e.kind !== 'action') btn.classList.add('cat');
    btn.addEventListener('click', () => {
      if (e.kind === 'action') onAction(e.action);
      else onMenu(e.to);
    });
    container.appendChild(btn);
  });
}

/** キーボード入力（矢印=移動、数字=ボタン順、Esc=一段戻る）。台帳画面では state が無い */
export function bindKeyboard(
  getState: () => GameState | null,
  onAction: (a: Action) => void,
  getMenu: () => MenuState,
  onMenu: (m: MenuState) => void,
): void {
  window.addEventListener('keydown', (ev) => {
    const state = getState();
    if (!state) return;
    const menu = getMenu();

    if (ev.key === 'Escape' && menu) {
      ev.preventDefault();
      // aim からは投げる選択へ、それ以外は1段目へ
      onMenu(menu.m === 'aim' ? { m: 'throw' } : null);
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
      else onMenu(e.to);
    }
  });
}
