// 行動選択 §11
// core の availableActions を読んでボタンを並べ、選択を core に渡すだけ。

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

/** 行動ボタンを描画する。番号キー・矢印キーでも選べる */
export function renderActions(
  container: HTMLElement,
  state: GameState,
  onAction: (a: Action) => void,
): void {
  container.innerHTML = '';
  const actions = availableActions(state);
  actions.forEach((a, i) => {
    const btn = document.createElement('button');
    if (i < 9) {
      const kbd = document.createElement('kbd');
      kbd.textContent = `${i + 1}`;
      btn.appendChild(kbd);
    }
    btn.appendChild(document.createTextNode(actionLabel(a, state)));
    btn.addEventListener('click', () => onAction(a));
    container.appendChild(btn);
  });
}

/** キーボード入力（矢印=移動、数字=ボタン順）。台帳画面では state が無い */
export function bindKeyboard(
  getState: () => GameState | null,
  onAction: (a: Action) => void,
): void {
  window.addEventListener('keydown', (ev) => {
    const state = getState();
    if (!state) return;
    const actions = availableActions(state);
    if (actions.length === 0) return;

    const dirByKey: Record<string, 'north' | 'south' | 'west' | 'east'> = {
      ArrowUp: 'north',
      ArrowDown: 'south',
      ArrowLeft: 'west',
      ArrowRight: 'east',
    };
    const dir = dirByKey[ev.key];
    if (dir) {
      const move = actions.find((a) => a.type === 'move' && a.dir === dir);
      if (move) {
        ev.preventDefault();
        onAction(move);
      }
      return;
    }
    const n = Number(ev.key);
    if (Number.isInteger(n) && n >= 1 && n <= actions.length) {
      ev.preventDefault();
      onAction(actions[n - 1]);
    }
  });
}
