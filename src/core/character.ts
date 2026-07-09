// DungeonCharacter（迷宮の性格）§5
// 共有・記憶される単位は具体地図ではなくこの性格。具体地形は 性格＋runSeed で毎回生成される。

import type { DungeonCharacter } from './types';

/** v0.1 の検証用プリセット: 「沈黙の井戸」 */
export const SILENT_WELL: DungeonCharacter = {
  id: 'silent-well',
  name: '沈黙の井戸',
  traitRumors: [
    'ここでは金属の擦れる音を聞いた者が多いという。',
    '浅い階には毒の仕掛けが多いと言われる。',
    '深く潜った者ほど、帰り道の崩落に苦しんだらしい。',
    'ここで拾った薬は、効いたり効かなかったりするそうだ。',
  ],
  biases: {
    metallicEnemyRate: 0.7, // 金属系の敵が出やすい
    upperTrapRate: 0.7, // 上層に毒罠が出やすい
    lowerReturnDifficulty: 0.6, // 下層ほど帰還困難
    potionInstability: 0.6, // 薬の効果が不安定
    rewardWeaponBias: 0.7, // 報酬は武器寄り
    enemyDensity: 0.3, // 敵は少ない
    enemyLethality: 0.7, // 一体ごとの危険度は高い
  },
};

/** 「灰の坑道」: 獣の群れ。数は多いが一体は弱い。仕掛けは少なく、浅い。入門向けの穴 */
export const ASH_ADIT: DungeonCharacter = {
  id: 'ash-adit',
  name: '灰の坑道',
  traitRumors: [
    'ここの獣は群れる。一匹見たら、まだいると思えと言われる。',
    '仕掛けの類は少ない。それを当てにした者から死ぬそうだが。',
    '坑道は浅く、帰り道で迷った話はあまり聞かない。',
    'ここで拾う薬はよく効く。得物のいい話は聞かないが。',
  ],
  biases: {
    metallicEnemyRate: 0.15, // 金物はほとんど出ない
    upperTrapRate: 0.25, // 罠は少ない
    lowerReturnDifficulty: 0.3, // 帰還は比較的容易
    potionInstability: 0.2, // 薬は安定
    rewardWeaponBias: 0.25, // 報酬は糧食・薬寄り
    enemyDensity: 0.85, // 敵は多い
    enemyLethality: 0.25, // 一体ごとは弱い
  },
};

/** 「沈んだ聖堂」: 影が濃く、帰り道が崩れる。薬は祝福か呪いか。深潜り向けの穴 */
export const SUNKEN_CHAPEL: DungeonCharacter = {
  id: 'sunken-chapel',
  name: '沈んだ聖堂',
  traitRumors: [
    '金物の音はしないという。代わりに、闇のほうが濃いらしい。',
    '降りるのは容易いそうだ。戻れた者が少ないだけで。',
    '聖堂の薬は祝福か呪いか、飲むまで分からないと言われる。',
    '深くで人影を見たという話が、妙に多い。',
  ],
  biases: {
    metallicEnemyRate: 0.1, // 金属系はまず出ない（獣と影の領分）
    upperTrapRate: 0.45,
    lowerReturnDifficulty: 0.85, // 帰り道が崩れやすい
    potionInstability: 0.75, // 薬効が大きく揺れる
    rewardWeaponBias: 0.5,
    enemyDensity: 0.5,
    enemyLethality: 0.55,
  },
};

/**
 * 組合の台帳（§5: 共有・記憶される単位は性格）。
 * 並びは浅い穴→深い穴。将来は characterSeed からの手続き生成で「無数」にする
 */
export const ATLAS: DungeonCharacter[] = [ASH_ADIT, SILENT_WELL, SUNKEN_CHAPEL];

/** 敵の名前テンプレ（種別ごと） */
export const ENEMY_NAMES: Record<string, string[]> = {
  metallic: ['壊れた鎧を引きずるもの', '錆びた刃の徘徊者', '軋む甲冑'],
  beast: ['井戸の底の獣', '青白い目の犬', '這いずる何か'],
  shade: ['音のない影', '冷たい気配', 'ゆらめく人影'],
};

/** 種族の呼び名（噂・目撃知識の表示用） */
export const KIND_WORD: Record<string, string> = {
  metallic: '金属のもの',
  beast: '獣',
  shade: '影',
};
