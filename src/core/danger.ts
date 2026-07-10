// 危険度システム §7
// プレイヤーの現在状態（装備・空腹・体調・光源）と敵の強さから死亡/重傷確率を求め、
// ラベルに射影する。数字はUIに出さない（憲法5）。
//
// v0.6（ターン制戦闘）以降、確率は係数の足し算ではなく、実際の戦闘と同じモデル
// （combat.ts の fightRound）を最後まで回した場合のモンテカルロ推定。
// ラベルは「戦い抜いたらどうなるか」の正直な射影であり続ける（憲法6）。

import { combatProfile, estimateFightRisk } from './combat';
import type { DungeonCharacter, Entity, PlayerState } from './types';

export type DangerLabel =
  | 'なんとかなりそう'
  | '油断はできない'
  | '危険'
  | 'かなり危険'
  | '死の気配';

export type DangerAssessment = {
  internalRisk: number; // 0..1 死亡/重傷確率（UIに出さない）
  label: DangerLabel;
  /** 危険度を押し上げている要因（死亡ログ・判断材料の表示用） */
  factors: string[];
};

/** 内部リスク → 表示ラベル（§7の帯） */
export function dangerLabel(risk: number): DangerLabel {
  if (risk < 0.1) return 'なんとかなりそう';
  if (risk < 0.25) return '油断はできない';
  if (risk < 0.45) return '危険';
  if (risk < 0.7) return 'かなり危険';
  return '死の気配';
}

/**
 * 状態依存の危険度算出。
 * 同じ敵でも「鎧が傷んでいる」「空腹」なら段が上がる（§7）。
 */
export function assessDanger(
  player: PlayerState,
  enemy: Entity,
  character: DungeonCharacter,
): DangerAssessment {
  const profile = combatProfile(player, enemy, character);
  const internalRisk = estimateFightRisk(player, enemy, character, profile);
  return { internalRisk, label: dangerLabel(internalRisk), factors: profile.factors };
}
