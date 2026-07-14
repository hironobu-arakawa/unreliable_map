// 戦闘モデル v0.6（ターン制）§7
// 1ラウンド = こちらの打ち込み →（相手が生きていれば）反撃。
// 実際の戦闘とラベル算出が同じモデルを共有する:
// 危険度ラベルは「この相手と最後まで打ち合った場合の死亡・重傷率」を
// 同一モデルのモンテカルロ試行で推定した、正直な射影である（憲法6）。
// 数字はUIに出さない（憲法5）——出すのは言葉と、打ち合いの手応えだけ。

import { armorGuard, armorWord, weaponPower } from './gear';
import type { RNG } from './rng';
import { hashSeed, mulberry32 } from './rng';
import type { DungeonCharacter, Entity, PlayerState } from './types';

/** 敵の地力がこれを下回れば倒れる（石・札はここまでしか削れない＝刃が仕留める） */
export const ENEMY_DEAD_AT = 0.05;

/** 一戦でこれ以上体力を失えば「重傷」（§7の死亡・重傷率の重傷側） */
export const HEAVY_LOSS = 30;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 戦闘の状況パラメータ。打ち込みの威力と、反撃の通りやすさ・重さの補正。
 * 敵の現在の地力（strength）はラウンドごとに変わるため、ここには持たず
 * enemyHitChance / rollEnemyDamage が都度参照する。
 */
export type CombatProfile = {
  /** 一打で削る敵の地力の基準値（実際は0.75〜1.25倍に振れる） */
  playerPower: number;
  /** 反撃の命中率への状況補正（光・韋駄天・種族相性） */
  hitMod: number;
  /** 反撃ダメージの係数（鎧・性格） */
  dmgMod: number;
  /** 相手が眠っている（最初の一打が深く入り、そのラウンドの反撃はない） */
  sleeping: boolean;
  /** 危険度を動かしている要因（判断材料・死亡ログ用） */
  factors: string[];
};

export function combatProfile(
  player: PlayerState,
  enemy: Entity,
  character: DungeonCharacter,
): CombatProfile {
  const factors: string[] = [];
  const lit = player.torch > 60;
  const dark = player.torch <= 0 && player.spareTorches <= 0;

  // ---- 打ち込みの威力（得物・空腹・暗さ） ----
  let power = weaponPower(player.weapons[0]);
  if (!player.weapons[0]) factors.push('まともな得物がない');
  else if (player.weapons[0].wear >= 70) factors.push('刃はいまにも折れそうだ');
  if (player.hunger >= 80) {
    power *= 0.75;
    factors.push('飢えている');
  } else if (player.hunger >= 55) {
    power *= 0.9;
    factors.push('空腹ぎみだ');
  }
  if (dark) power *= 0.8; // 見えない相手に刃は浅くしか入らない

  // ---- 反撃の通りやすさ（光・韋駄天・種族） ----
  let hitMod = 0;
  if (dark) {
    hitMod += 0.22;
    factors.push('暗闇の中にいる');
  } else if (player.torch <= 20 && player.spareTorches <= 0) {
    hitMod += 0.06;
    factors.push('最後の松明が残り少ない');
  }
  if (player.hasteTurns > 0) {
    hitMod -= 0.25;
    factors.push('体が羽のように軽い');
  }
  // 痺れ: 刃は鈍り、かわす足も遅れる（罠・箱の霧の帰結。危険度ラベルにも正直に効く）
  if (player.numbTurns > 0) {
    power *= 0.85;
    hitMod += 0.15;
    factors.push('体が痺れている');
  }
  // 光と種族: 獣は火を恐れ、影は闇の中で濃くなる（金属は光に無頓着）
  if (enemy.kind === 'beast') {
    if (lit) {
      hitMod -= 0.08;
      factors.push('獣は松明の火を嫌がっている');
    } else if (dark) {
      hitMod += 0.05;
    }
  } else if (enemy.kind === 'shade') {
    if (dark) {
      hitMod += 0.08;
      factors.push('影は闇の中で濃くなっている');
    } else if (lit) {
      hitMod -= 0.04;
    }
  }

  // ---- 反撃の重さ（鎧・性格） ----
  const dmgMod = (0.85 + character.biases.enemyLethality * 0.3) * (1 - armorGuard(player.armor));
  if (!player.armor) factors.push('身を守るものがない');
  else if (player.armor.wear >= 40) factors.push(armorWord(player.armor));

  // ---- 表示用の要因（体調・毒はモンテカルロの初期値として効く） ----
  if (player.poisonTurns > 0) factors.push('毒が回っている');
  if (player.condition <= 30) factors.push('深手を負っている');
  else if (player.condition <= 60) factors.push('傷を負っている');

  const sleeping = (enemy.sleepTurns ?? 0) > 0;
  if (sleeping) factors.push('相手は深く眠っている');

  return { playerPower: power, hitMod, dmgMod, sleeping, factors };
}

/** 反撃の命中率（敵の現在の地力に応じる。弱った相手の反撃は当たらなくなる） */
export function enemyHitChance(strength: number, profile: CombatProfile): number {
  return clamp(0.45 + strength * 0.4 + profile.hitMod, 0.08, 0.95);
}

/** 反撃のダメージを1回ぶん振る */
export function rollEnemyDamage(strength: number, profile: CombatProfile, rng: RNG): number {
  return (9 + strength * 24) * profile.dmgMod * (0.55 + 0.9 * rng.next());
}

export type RoundResult = {
  /** この打ち込みで削った地力 */
  blowDamage: number;
  /** 相手は倒れたか */
  enemyDead: boolean;
  /** 反撃を食らったか */
  playerHit: boolean;
  /** 食らったダメージ */
  playerDamage: number;
};

/**
 * 1ラウンドを解決する（実戦とモンテカルロの両方がこれを使う）。
 * @param strength 敵の現在の地力
 * @param sleeping このラウンドの相手が眠っている（一打が深く入り、反撃はない）
 */
export function fightRound(
  profile: CombatProfile,
  strength: number,
  rng: RNG,
  sleeping: boolean,
): RoundResult {
  let blow = profile.playerPower * (0.75 + rng.next() * 0.5);
  if (sleeping) blow *= 2.5; // 寝込みへの一打は深い
  if (strength - blow < ENEMY_DEAD_AT) {
    return { blowDamage: blow, enemyDead: true, playerHit: false, playerDamage: 0 };
  }
  if (sleeping) {
    // 眠りから覚めたばかりの相手は、このラウンドは反撃できない
    return { blowDamage: blow, enemyDead: false, playerHit: false, playerDamage: 0 };
  }
  const after = strength - blow;
  if (rng.next() < enemyHitChance(after, profile)) {
    return {
      blowDamage: blow,
      enemyDead: false,
      playerHit: true,
      playerDamage: rollEnemyDamage(after, profile, rng),
    };
  }
  return { blowDamage: blow, enemyDead: false, playerHit: false, playerDamage: 0 };
}

/** 乱戦の横槍役: その敵と、プレイヤーまでの現在距離（マス数） */
export type Approacher = { entity: Entity; distance: number };

/**
 * 「最後まで打ち合った場合」の死亡・重傷率をモンテカルロで推定する。
 * 実戦と同じ fightRound を回すので、ラベルは機構の正直な射影になる（憲法6）。
 * 近くで動いている他の敵（others）は「横合いの一撃」として同じモデルで織り込む。
 * シードは敵と状態の要約から決定論的に導出——同じ状況なら同じラベル（§4.2）。
 */
export function estimateFightRisk(
  player: PlayerState,
  enemy: Entity,
  character: DungeonCharacter,
  profile?: CombatProfile,
  others: Approacher[] = [],
): number {
  const prof = profile ?? combatProfile(player, enemy, character);
  // 到着ラウンドの見積り: いまの距離ぶんだけ歩いてくる（重い敵は倍かかる）
  const bystanders = others.map((o) => ({
    arrival: Math.max(1, (o.distance - 1) * o.entity.moveEvery),
    moveEvery: o.entity.moveEvery,
    strength: o.entity.strength,
    profile: combatProfile(player, o.entity, character),
  }));
  const rng = mulberry32(
    hashSeed(
      'risk',
      enemy.id,
      Math.round(player.condition),
      Math.round(enemy.strength * 1000),
      Math.round(prof.playerPower * 1000),
      Math.round(prof.hitMod * 1000),
      Math.round(prof.dmgMod * 1000),
      others.length,
      ...others.map((o) => Math.round(o.entity.strength * 100) + o.distance),
    ),
  );
  const TRIALS = 120;
  let bad = 0;
  for (let i = 0; i < TRIALS; i++) {
    let strength = enemy.strength;
    let condition = player.condition;
    let poison = player.poisonTurns;
    let sleeping = prof.sleeping;
    let lost = 0;
    for (let round = 0; round < 40; round++) {
      const r = fightRound(prof, strength, rng, sleeping);
      sleeping = false;
      strength -= r.blowDamage;
      if (r.enemyDead) break;
      if (r.playerHit) {
        condition -= r.playerDamage;
        lost += r.playerDamage;
      }
      // 乱戦の横槍: 届いた敵は自分の足の速さで殴ってくる。
      // ただし実戦では的を絞って各個撃破できる余地があるので、横槍は控えめに見積もる（0.6係数）
      for (const b of bystanders) {
        if (round + 1 < b.arrival) continue;
        if ((round + 1 - b.arrival) % b.moveEvery !== 0) continue;
        if (rng.next() < enemyHitChance(b.strength, b.profile) * 0.6) {
          const dmg = rollEnemyDamage(b.strength, b.profile, rng);
          condition -= dmg;
          lost += dmg;
        }
      }
      if (poison > 0) {
        condition -= 3;
        lost += 3;
        poison--;
      }
      if (condition <= 0) break;
    }
    if (condition <= 0 || lost >= HEAVY_LOSS) bad++;
  }
  return bad / TRIALS;
}
