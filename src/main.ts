// エントリポイント: core と ui を結線する。
// 画面は二つ——台帳（穴を選ぶ）と潜行。生還すれば装備を持ち出せる、死ねば失う。
// runSeed は URL の ?seed=（＋?well=）で固定でき、固定すれば潜行は完全に再現可能（§4.2・受け入れ条件9）。

import { ATLAS, SILENT_WELL } from './core/character';
import { newGame, step, type Action, type GameState } from './core/state';
import { dangerRateByLabel, hitRateByLabel } from './core/telemetry';
import type { DungeonCharacter } from './core/types';
import { bindKeyboard, renderActions } from './ui/input';
import {
  describeKit,
  kitFromPlayer,
  loadProfile,
  saveProfile,
  wellRecord,
} from './ui/profile';
import { escapeHtml, renderView } from './ui/render';

// ---- DOM ----
const el = {
  atlas: document.getElementById('atlas')!,
  carryNote: document.getElementById('carry-note')!,
  wells: document.getElementById('wells')!,
  game: document.getElementById('game')!,
  runTitle: document.getElementById('run-title')!,
  endPanel: document.getElementById('end-panel')!,
  map: document.getElementById('map')!,
  events: document.getElementById('events')!,
  sensesPanel: document.getElementById('senses-panel')!,
  senses: document.getElementById('senses')!,
  claimsPanel: document.getElementById('claims-panel')!,
  claims: document.getElementById('claims')!,
  status: document.getElementById('status')!,
  actions: document.getElementById('actions')!,
  debug: document.getElementById('debug')!,
};

// ---- 状態 ----
const profile = loadProfile();
let state: GameState | null = null;
let currentCharacter: DungeonCharacter = SILENT_WELL;
/** 出来事の履歴（新しいものが末尾）。直近を明るく、過去を薄く見せるためUI層が持つ */
let eventHistory: string[][] = [];
let runRecorded = false;
/** ?seed= による再現潜行か（帳面に残さず、持ち越しも使わない） */
let isReplay = false;
// デバッグ表示（開発者用）: ?debug=1 で起動時ON、バッククォート（`）でトグル
let debugMode = new URLSearchParams(location.search).has('debug');

/** UI層のみ許される非決定性: 新しい潜行のシード起こし（core内では禁止 §4.2） */
function freshSeed(): number {
  return (Date.now() ^ (performance.now() * 1000)) >>> 0;
}

// ---- 計測フック（開発者向け・非表示 §12） ----
// UIには一切出さない。コンソールと window.__telemetry で数字を握る
declare global {
  interface Window {
    __telemetry: unknown;
    dumpTelemetry: () => void;
  }
}
function exposeTelemetry(): void {
  if (!state) return;
  window.__telemetry = state.telemetry;
  window.dumpTelemetry = () => {
    if (!state) return;
    console.log(JSON.stringify(state.telemetry, null, 2));
    console.table(hitRateByLabel([state.telemetry]));
    console.table(dangerRateByLabel([state.telemetry]));
  };
}

// ---- 台帳（タイトル画面） ----

function showAtlas(): void {
  state = null;
  el.game.hidden = true;
  el.atlas.hidden = false;

  el.carryNote.textContent = profile.carryover
    ? `前回の生還から持ち出した品：${describeKit(profile.carryover)}`
    : '支度は組合の標準のみ（傷んだ短剣・松明・糧食）。';

  el.wells.innerHTML = '';
  for (const character of ATLAS) {
    const card = document.createElement('section');
    card.className = 'panel well';

    const h3 = document.createElement('h3');
    h3.textContent = character.name;
    card.appendChild(h3);

    const rumors = document.createElement('ul');
    rumors.className = 'rumors';
    for (const r of character.traitRumors) {
      const li = document.createElement('li');
      li.textContent = r;
      rumors.appendChild(li);
    }
    card.appendChild(rumors);

    const stats = document.createElement('div');
    stats.className = 'stats';
    const rec = wellRecord(profile, character.id);
    stats.textContent =
      rec.dives > 0
        ? `潜行 ${rec.dives} ／ 生還 ${rec.escapes} ／ 宝 ${rec.treasures} ／ 報告された最深 ${rec.deepest > 0 ? `B${rec.deepest}F` : '——'}`
        : 'あなたの記録はまだない。';
    card.appendChild(stats);

    const btn = document.createElement('button');
    btn.textContent = 'この穴に潜る';
    btn.addEventListener('click', () => startRun(character));
    card.appendChild(btn);

    el.wells.appendChild(card);
  }
}

// ---- 潜行 ----

function startRun(character: DungeonCharacter, replaySeed?: number): void {
  currentCharacter = character;
  // 再現潜行（?seed=）は標準支度・帳面に残さない——同じシードは常に同じ潜行（§4.2）
  isReplay = replaySeed !== undefined;
  state = newGame(
    character,
    replaySeed ?? freshSeed(),
    isReplay ? undefined : (profile.carryover ?? undefined),
  );
  eventHistory = [state.events];
  runRecorded = false;

  if (!isReplay) {
    const rec = wellRecord(profile, character.id);
    rec.dives++;
    saveProfile(profile);
  }

  el.atlas.hidden = true;
  el.game.hidden = false;
  console.info(
    `[unreliable-map] runSeed=${state.instance.runSeed} — 同じ潜行を再現するには ?seed=${state.instance.runSeed}&well=${character.id}`,
  );
  exposeTelemetry();
  draw();
}

/** 潜行の結末を帳面に記す（一度だけ）。生還＝装備の持ち出し、死＝全損 */
function finalizeRun(): void {
  if (!state || runRecorded) return;
  if (state.phase !== 'dead' && state.phase !== 'escaped') return;
  runRecorded = true;

  if (!isReplay) {
    const rec = wellRecord(profile, currentCharacter.id);
    if (state.phase === 'escaped') {
      rec.escapes++;
      rec.deepest = Math.max(rec.deepest, state.deepestVisited);
      if (state.player.hasTreasure) rec.treasures++;
      profile.carryover = kitFromPlayer(state.player);
    } else {
      rec.deaths++;
      profile.carryover = null;
    }
    saveProfile(profile);
  }

  // 潜行終了: 計測ログをコンソールへ（§12）
  console.info('[unreliable-map] telemetry:', state.telemetry);
  console.table(hitRateByLabel([state.telemetry]));
}

/** 結末パネルに添えるメタ行（持ち越しの帰結）。coreの記録の後に続ける */
function endMetaLines(s: GameState): string[] {
  if (isReplay) return ['（再現潜行——この結末は帳面に残らない。）'];
  if (s.phase === 'escaped') {
    const lines = ['持ち出した品は組合に預けた——次の潜行の支度になる。'];
    if (s.player.hasTreasure) lines.push('台帳のあなたの頁に、銘がひとつ刻まれた。');
    return lines;
  }
  return [
    '担いでいた品は、編み直される大地のどこかへ消えた。',
    '次の潜行は、組合の標準の支度から始まる。',
  ];
}

function onAction(a: Action): void {
  if (!state) return;
  step(state, a);
  // 何も起きなかったターンは履歴に積まない（直近の出来事が空白に押し流されないように）
  if (state.events.length > 0) eventHistory.push(state.events);
  if (eventHistory.length > 5) eventHistory = eventHistory.slice(-5);
  finalizeRun();
  draw();
}

function draw(): void {
  if (!state) return;
  const view = renderView(state, { debug: debugMode, eventHistory });

  el.runTitle.textContent = view.title;
  el.map.innerHTML = view.mapHtml;
  el.map.className = view.torchClass;
  el.events.innerHTML = view.eventsHtml;
  el.sensesPanel.hidden = view.sensesHtml === '';
  el.senses.innerHTML = view.sensesHtml;
  el.claimsPanel.hidden = view.claimsHtml === '';
  el.claims.innerHTML = view.claimsHtml;
  el.status.innerHTML = view.statusHtml;
  el.debug.hidden = view.debugText === null;
  el.debug.textContent = view.debugText ?? '';

  if (view.end) {
    el.endPanel.hidden = false;
    el.endPanel.className = `panel ${view.end.kind}`;
    el.endPanel.innerHTML =
      view.end.bodyHtml +
      endMetaLines(state)
        .map((l) => `<div class="meta-line">${escapeHtml(l)}</div>`)
        .join('');
  } else {
    el.endPanel.hidden = true;
  }

  renderActions(el.actions as HTMLElement, state, onAction);
  if (view.end) {
    const again = document.createElement('button');
    again.textContent = '同じ穴にもう一度潜る（性格は同じ・迷宮は別）';
    again.addEventListener('click', () => startRun(currentCharacter));
    el.actions.appendChild(again);

    const back = document.createElement('button');
    back.textContent = '台帳に戻る';
    back.addEventListener('click', showAtlas);
    el.actions.appendChild(back);
  }
}

// ---- 起動 ----

bindKeyboard(() => state, onAction);
window.addEventListener('keydown', (ev) => {
  if (ev.key === '`') {
    debugMode = !debugMode;
    draw();
  }
});

// ?seed=（＋?well=）があれば台帳を飛ばして直接再現潜行に入る
const params = new URLSearchParams(location.search);
const rawSeed = params.get('seed');
if (rawSeed !== null && /^\d+$/.test(rawSeed)) {
  const well = ATLAS.find((c) => c.id === params.get('well')) ?? SILENT_WELL;
  startRun(well, Number(rawSeed) >>> 0);
} else {
  showAtlas();
}
