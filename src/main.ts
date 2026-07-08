// エントリポイント: core と ui を結線する。
// runSeed は URL の ?seed= で固定でき、固定すれば潜行は完全に再現可能（§4.2・受け入れ条件9）。

import { SILENT_WELL } from './core/character';
import { newGame, step, type Action, type GameState } from './core/state';
import { hitRateByLabel, dangerRateByLabel } from './core/telemetry';
import { bindKeyboard, renderActions } from './ui/input';
import { renderScreen } from './ui/render';

function seedFromUrl(): number {
  const raw = new URLSearchParams(location.search).get('seed');
  if (raw !== null && /^\d+$/.test(raw)) return Number(raw) >>> 0;
  // UI層のみ許される非決定性: 新しい潜行のシード起こし（core内では禁止 §4.2）
  return (Date.now() ^ (performance.now() * 1000)) >>> 0;
}

const screenEl = document.getElementById('screen')!;
const actionsEl = document.getElementById('actions')!;

let state: GameState = newGame(SILENT_WELL, seedFromUrl());

// ---- 計測フック（開発者向け・非表示 §12） ----
// UIには一切出さない。コンソールと window.__telemetry で数字を握る
declare global {
  interface Window {
    __telemetry: unknown;
    dumpTelemetry: () => void;
  }
}
function exposeTelemetry(): void {
  window.__telemetry = state.telemetry;
  window.dumpTelemetry = () => {
    console.log(JSON.stringify(state.telemetry, null, 2));
    console.table(hitRateByLabel([state.telemetry]));
    console.table(dangerRateByLabel([state.telemetry]));
  };
}
console.info(
  `[unreliable-map] runSeed=${state.instance.runSeed} — 同じ潜行を再現するには ?seed=${state.instance.runSeed}`,
);

function onAction(a: Action): void {
  step(state, a);
  draw();
  if (state.phase === 'dead' || state.phase === 'escaped') {
    // 潜行終了: 計測ログをコンソールへ（§12）
    console.info('[unreliable-map] telemetry:', state.telemetry);
    console.table(hitRateByLabel([state.telemetry]));
  }
}

function draw(): void {
  screenEl.textContent = renderScreen(state);
  renderActions(actionsEl as HTMLElement, state, onAction);
  if (state.phase === 'dead' || state.phase === 'escaped') {
    const btn = document.createElement('button');
    btn.textContent = 'もう一度、同じ井戸に潜る（性格は同じ・迷宮は別）';
    btn.addEventListener('click', () => {
      state = newGame(SILENT_WELL, (Date.now() ^ 0x5eed) >>> 0);
      exposeTelemetry();
      console.info(`[unreliable-map] new runSeed=${state.instance.runSeed}`);
      draw();
    });
    actionsEl.appendChild(btn);
  }
}

exposeTelemetry();
bindKeyboard(() => state, onAction);
draw();
