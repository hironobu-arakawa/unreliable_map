// 危険度システム §7
// プレイヤーの現在状態（装備・空腹・体調・光源）と敵の強さから死亡/重傷確率を計算し、
// ラベルに射影する。数字はUIに出さない（憲法5）。

import { ARMOR_DATA, armorWord, weaponPower } from './gear';
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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
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
  const factors: string[] = [];

  // 敵の地力: strength(0..1) と性格の enemyLethality を合成
  let risk = 0.08 + enemy.strength * 0.45 + character.biases.enemyLethality * 0.12;

  // 得物: 短剣（威力0.16）を基準に、実効打撃力の差がそのまま危険度に効く
  // （剣なら下がり、折れて素手なら上がる。刃の傷みも連続的に効く）
  const power = weaponPower(player.weapons[0]);
  risk -= (power - 0.16) * 1.2;
  if (!player.weapons[0]) {
    factors.push('まともな得物がない');
  } else if (player.weapons[0].wear >= 70) {
    factors.push('刃はいまにも折れそうだ');
  }

  // 鎧: 革鎧を基準に、上等な鎧は下げ、傷み・喪失は上げる
  const armor = player.armor;
  if (!armor) {
    risk += 0.14;
    factors.push('身を守るものがない');
  } else {
    risk -= (ARMOR_DATA[armor.kind].guard - 0.15) * 0.6;
    if (armor.wear >= 70) {
      risk += 0.14;
      factors.push(armorWord(armor));
    } else if (armor.wear >= 40) {
      risk += 0.08;
      factors.push(armorWord(armor));
    }
  }

  if (player.hunger >= 80) {
    risk += 0.14;
    factors.push('飢えている');
  } else if (player.hunger >= 55) {
    risk += 0.08;
    factors.push('空腹ぎみだ');
  }

  if (player.condition <= 30) {
    risk += 0.16;
    factors.push('深手を負っている');
  } else if (player.condition <= 60) {
    risk += 0.08;
    factors.push('傷を負っている');
  }

  // 暗闇での戦闘は大きく不利（予備が尽きてからが本当の暗闇）
  if (player.torch <= 0 && player.spareTorches <= 0) {
    risk += 0.18;
    factors.push('暗闇の中にいる');
  } else if (player.torch <= 20 && player.spareTorches <= 0) {
    risk += 0.06;
    factors.push('最後の松明が残り少ない');
  }

  if (player.poisonTurns > 0) {
    risk += 0.08;
    factors.push('毒が回っている');
  }

  // 韋駄天の札: 体が軽いうちは立ち回りで受けを流せる
  if (player.hasteTurns > 0) {
    risk -= 0.05;
    factors.push('体が羽のように軽い');
  }

  // 光と種族: 獣は火を恐れ、影は闇の中で濃くなる（金属は光に無頓着）
  const lit = player.torch > 60;
  const dark = player.torch <= 0 && player.spareTorches <= 0;
  if (enemy.kind === 'beast') {
    if (lit) {
      risk -= 0.06;
      factors.push('獣は松明の火を嫌がっている');
    } else if (dark) {
      risk += 0.06;
    }
  } else if (enemy.kind === 'shade') {
    if (dark) {
      risk += 0.1;
      factors.push('影は闇の中で濃くなっている');
    } else if (lit) {
      risk -= 0.04;
    }
  }

  // 眠りの札: 眠りこけている相手への一撃は、ほとんど賭けにならない
  if ((enemy.sleepTurns ?? 0) > 0) {
    risk *= 0.3;
    factors.push('相手は深く眠っている');
  }

  const internalRisk = clamp01(risk);
  return { internalRisk, label: dangerLabel(internalRisk), factors };
}
