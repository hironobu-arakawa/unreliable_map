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

/** 敵の名前テンプレ（種別ごと） */
export const ENEMY_NAMES: Record<string, string[]> = {
  metallic: ['壊れた鎧を引きずるもの', '錆びた刃の徘徊者', '軋む甲冑'],
  beast: ['井戸の底の獣', '青白い目の犬', '這いずる何か'],
  shade: ['音のない影', '冷たい気配', 'ゆらめく人影'],
};
