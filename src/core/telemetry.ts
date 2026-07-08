// 計測フック §12（開発者向け・非表示）
// UIに数字を出さない代わり、開発者は数字で握る。
// - ラベルごとの実的中率が意図した帯（§6.2/§7）に入っているかを測る
// - プレイヤーが回を重ねて情報の扱いを変えているかを観察する

import type { InfoSource, MissPattern } from './types';

export type InfoEvent = {
  turn: number;
  source: InfoSource;
  label: string;
  internal_p: number;
  predicted: string; // 主張内容（内部文字列）
  actual: string; // 実際に何があったか
  held: boolean;
  miss_pattern?: MissPattern;
};

export type DangerEvent = {
  turn: number;
  danger_label: string;
  internal_risk: number;
  engaged: boolean;
  outcome: 'win' | 'wounded' | 'heavy' | 'death' | 'avoided' | 'retreatHit';
};

export type ChoiceEvent = {
  turn: number;
  action: string;
};

export type RunSummary = {
  runSeed: number;
  characterId: string;
  result: 'escape' | 'death' | 'ongoing';
  deepestFloor: number;
  turns: number;
  gotTreasure: boolean;
};

export type TelemetryLog = {
  runSeed: number;
  characterId: string;
  startedAt: string;
  infoEvents: InfoEvent[];
  dangerEvents: DangerEvent[];
  choices: ChoiceEvent[];
  summary: RunSummary | null;
};

export function createTelemetry(runSeed: number, characterId: string): TelemetryLog {
  return {
    runSeed,
    characterId,
    startedAt: new Date().toISOString(),
    infoEvents: [],
    dangerEvents: [],
    choices: [],
    summary: null,
  };
}

export function recordInfo(t: TelemetryLog, e: InfoEvent): void {
  t.infoEvents.push(e);
}

export function recordDanger(t: TelemetryLog, e: DangerEvent): void {
  t.dangerEvents.push(e);
}

export function recordChoice(t: TelemetryLog, e: ChoiceEvent): void {
  t.choices.push(e);
}

export function recordSummary(t: TelemetryLog, s: RunSummary): void {
  t.summary = s;
}

/** ラベルごとの実的中率（開発者向け集計） */
export function hitRateByLabel(logs: TelemetryLog[]): Record<string, { n: number; hit: number; rate: number }> {
  const acc: Record<string, { n: number; hit: number; rate: number }> = {};
  for (const log of logs) {
    for (const e of log.infoEvents) {
      const a = (acc[e.label] ??= { n: 0, hit: 0, rate: 0 });
      a.n++;
      if (e.held) a.hit++;
    }
  }
  for (const k of Object.keys(acc)) acc[k].rate = acc[k].hit / acc[k].n;
  return acc;
}

/** 危険ラベルごとの実際の死亡・重傷率（挑んだ場合のみ） */
export function dangerRateByLabel(
  logs: TelemetryLog[],
): Record<string, { engaged: number; badOutcome: number; rate: number }> {
  const acc: Record<string, { engaged: number; badOutcome: number; rate: number }> = {};
  for (const log of logs) {
    for (const e of log.dangerEvents) {
      if (!e.engaged) continue;
      const a = (acc[e.danger_label] ??= { engaged: 0, badOutcome: 0, rate: 0 });
      a.engaged++;
      if (e.outcome === 'death' || e.outcome === 'heavy') a.badOutcome++;
    }
  }
  for (const k of Object.keys(acc)) acc[k].rate = acc[k].badOutcome / acc[k].engaged;
  return acc;
}
