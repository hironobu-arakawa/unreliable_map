// 行動選択 §11
// core の availableActions を読んでボタンを並べ、選択を core に渡すだけ。

import { availableActions, type Action, type GameState } from '../core/state';

const ACTION_LABELS: Record<string, string> = {
  listen: '耳を澄ます',
  rest: '休む',
  descend: '階段を降りる',
  ascend: '階段を上る',
  escape: '地上へ脱出する',
  drinkPotion: '薬を飲む',
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

export function actionLabel(a: Action): string {
  if (a.type === 'move') return DIR_LABELS[a.dir];
  if (a.type === 'throwTalisman') return `${a.pattern}の札を投げる`;
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
    btn.appendChild(document.createTextNode(actionLabel(a)));
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
