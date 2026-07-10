// DungeonCharacter（迷宮の性格）§5
// 共有・記憶される単位は具体地図ではなくこの性格。具体地形は 性格＋runSeed で毎回生成される。
// v0.5: ギルドは土地ごとに支部を持ち、1支部につき9つの穴を台帳に載せる（浅い穴→深い穴の並び）。

import type { DungeonCharacter, GuildBranch, PotionKind } from './types';

// ================================================================
// 灰嶺（はいみね）支部 —— 山あいの鉱山町。乾いた穴と金物の音の領分
// ================================================================

/** 入門向け: 獣の群れ。数は多いが一体は弱い。仕掛けは少なく、浅い */
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
    metallicEnemyRate: 0.15,
    upperTrapRate: 0.25,
    lowerReturnDifficulty: 0.3,
    potionInstability: 0.2,
    rewardWeaponBias: 0.25,
    enemyDensity: 0.85,
    enemyLethality: 0.25,
  },
};

const DOG_HOWL_BURROW: DungeonCharacter = {
  id: 'dog-howl-burrow',
  name: '犬啼きの横穴',
  traitRumors: [
    'ここの獣は数で来る。一匹の弱さを、群れで埋めるのだと。',
    '仕掛けや毒の話はほとんど聞かない。',
    '浅い穴だ。日暮れ前に戻れた者が多いそうだ。',
  ],
  biases: {
    metallicEnemyRate: 0.1,
    upperTrapRate: 0.2,
    lowerReturnDifficulty: 0.25,
    potionInstability: 0.3,
    rewardWeaponBias: 0.3,
    enemyDensity: 0.9,
    enemyLethality: 0.2,
  },
};

const RUSTED_ADIT: DungeonCharacter = {
  id: 'rusted-adit',
  name: '錆押しの旧坑',
  traitRumors: [
    '古い坑道だ。錆びた金物が、まだいくつか歩いているらしい。',
    '得物のいい拾い物があったという話を、二度聞いた。',
    '仕掛けは古い。だが全部が朽ちているわけではないと。',
  ],
  biases: {
    metallicEnemyRate: 0.55,
    upperTrapRate: 0.4,
    lowerReturnDifficulty: 0.4,
    potionInstability: 0.4,
    rewardWeaponBias: 0.7,
    enemyDensity: 0.4,
    enemyLethality: 0.4,
  },
};

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

const NEEDLE_SEAM: DungeonCharacter = {
  id: 'needle-seam',
  name: '針含みの層',
  traitRumors: [
    '床を信じるな、と言われる。浅い階ほど針が多いそうだ。',
    '敵の影は薄い。死人の多くは、戦わずに死んでいる。',
    '箱には手を出すなという声と、箱でしか得られんという声がある。',
  ],
  biases: {
    metallicEnemyRate: 0.3,
    upperTrapRate: 0.9,
    lowerReturnDifficulty: 0.45,
    potionInstability: 0.5,
    rewardWeaponBias: 0.45,
    enemyDensity: 0.25,
    enemyLethality: 0.45,
  },
};

const WIND_HOLLOW: DungeonCharacter = {
  id: 'wind-hollow',
  name: '空唄の風穴',
  traitRumors: [
    '風の音に紛れて、音のない影が立つという。',
    'ここの薬は当てにするな。祝いにも呪いにもなる。',
    '深い階の風は、帰り道の砂を崩すらしい。',
  ],
  biases: {
    metallicEnemyRate: 0.05,
    upperTrapRate: 0.35,
    lowerReturnDifficulty: 0.55,
    potionInstability: 0.8,
    rewardWeaponBias: 0.35,
    enemyDensity: 0.5,
    enemyLethality: 0.5,
  },
};

const ARMOR_PIT: DungeonCharacter = {
  id: 'armor-pit',
  name: '鎧擦れの大坑',
  traitRumors: [
    '鎧の音が二重に聞こえたら、挟まれていると思え。',
    '一体一体が重い。だが足も重い——走った者は帰っている。',
    '奴らの得物は上物だ。剥ぎ取れれば、の話だが。',
  ],
  biases: {
    metallicEnemyRate: 0.85,
    upperTrapRate: 0.4,
    lowerReturnDifficulty: 0.5,
    potionInstability: 0.45,
    rewardWeaponBias: 0.85,
    enemyDensity: 0.35,
    enemyLethality: 0.65,
  },
};

const CRUMBLE_DEEP: DungeonCharacter = {
  id: 'crumble-deep',
  name: '崩れ待ちの深層',
  traitRumors: [
    '降りるのは楽だ。帰りの階段が待ってくれないだけで。',
    '崩落の音を三度聞いたら引き返せ、と古株は言う。',
    '深くの獣は、傷を負ってなお追ってくるそうだ。',
  ],
  biases: {
    metallicEnemyRate: 0.4,
    upperTrapRate: 0.5,
    lowerReturnDifficulty: 0.9,
    potionInstability: 0.55,
    rewardWeaponBias: 0.5,
    enemyDensity: 0.45,
    enemyLethality: 0.6,
  },
};

const KINGS_FLUME: DungeonCharacter = {
  id: 'kings-flume',
  name: '王樋の底',
  traitRumors: [
    '灰嶺で一番深い。生きて底を見た者は、片手で数えられる。',
    '金物も獣も影も、みな強い。選べるのは順番だけだと。',
    '底の宝は本物だという。持ち帰った者の銘は、台帳に三つしかない。',
  ],
  biases: {
    metallicEnemyRate: 0.6,
    upperTrapRate: 0.6,
    lowerReturnDifficulty: 0.8,
    potionInstability: 0.7,
    rewardWeaponBias: 0.75,
    enemyDensity: 0.55,
    enemyLethality: 0.85,
  },
};

// ================================================================
// 汐間（しおま）支部 —— 海際の沈み地。水と霧と、濡れた帰り道の領分
// ================================================================

const TIDEPOOL_CAVE: DungeonCharacter = {
  id: 'tidepool-cave',
  name: '潮だまりの洞',
  traitRumors: [
    '獣は多いが、どれも腹を空かせた小物だと。',
    '水はだいたい飲める。だいたい、だが。',
    '浅く、明るい。初潜りはここからと帳場は言う。',
  ],
  biases: {
    metallicEnemyRate: 0.1,
    upperTrapRate: 0.2,
    lowerReturnDifficulty: 0.3,
    potionInstability: 0.25,
    rewardWeaponBias: 0.25,
    enemyDensity: 0.75,
    enemyLethality: 0.22,
  },
};

const CRAB_SHELF: DungeonCharacter = {
  id: 'crab-shelf',
  name: '蟹歩きの岩棚',
  traitRumors: [
    '横に歩く金物がいる。硬いが、鈍い。',
    '岩の隙間に、誰かの得物が挟まったままだという。',
    '帰り道はまっすぐだ。波の音を辿ればいい。',
  ],
  biases: {
    metallicEnemyRate: 0.6,
    upperTrapRate: 0.25,
    lowerReturnDifficulty: 0.3,
    potionInstability: 0.35,
    rewardWeaponBias: 0.55,
    enemyDensity: 0.7,
    enemyLethality: 0.3,
  },
};

const SALT_GALLERY: DungeonCharacter = {
  id: 'salt-gallery',
  name: '塩噛みの回廊',
  traitRumors: [
    '塩が仕掛けの糸を隠す。床の白いところは疑え。',
    'ここの水は舐めるな。塩か毒か、舌では分からん。',
    '敵の話より、床の話ばかり聞く穴だ。',
  ],
  biases: {
    metallicEnemyRate: 0.2,
    upperTrapRate: 0.65,
    lowerReturnDifficulty: 0.4,
    potionInstability: 0.5,
    rewardWeaponBias: 0.35,
    enemyDensity: 0.35,
    enemyLethality: 0.4,
  },
};

const FOG_SHIPGRAVE: DungeonCharacter = {
  id: 'fog-shipgrave',
  name: '霧の船墓',
  traitRumors: [
    '沈んだ船の墓場だ。霧の中で人影を見ても、呼ぶな。',
    '船の積み荷がまだ残っているという。得物も、薬も。',
    '霧が濃い日は、帰った者がいない。',
  ],
  biases: {
    metallicEnemyRate: 0.15,
    upperTrapRate: 0.35,
    lowerReturnDifficulty: 0.55,
    potionInstability: 0.6,
    rewardWeaponBias: 0.6,
    enemyDensity: 0.45,
    enemyLethality: 0.5,
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

const DROWN_VALE: DungeonCharacter = {
  id: 'drown-vale',
  name: '溺れ谷',
  traitRumors: [
    '谷の底は水びたしで、道が日ごとに沈むという。',
    '降りた数だけ、上がれなかった話がある。',
    '水音のするほうへ行くな、と生き残りは口を揃える。',
  ],
  biases: {
    metallicEnemyRate: 0.2,
    upperTrapRate: 0.5,
    lowerReturnDifficulty: 0.85,
    potionInstability: 0.6,
    rewardWeaponBias: 0.45,
    enemyDensity: 0.5,
    enemyLethality: 0.55,
  },
};

const SHADE_CANAL: DungeonCharacter = {
  id: 'shade-canal',
  name: '影渡りの水路',
  traitRumors: [
    '水面を影が渡る。松明を落としたら、それまでだと。',
    '影は数が多い。火のあるうちに数を減らせ。',
    'ここで拾う薬は強い。効く方にも、悪い方にも。',
  ],
  biases: {
    metallicEnemyRate: 0.05,
    upperTrapRate: 0.4,
    lowerReturnDifficulty: 0.6,
    potionInstability: 0.75,
    rewardWeaponBias: 0.4,
    enemyDensity: 0.65,
    enemyLethality: 0.6,
  },
};

const GLEAM_GROTTO: DungeonCharacter = {
  id: 'gleam-grotto',
  name: '底光りの海窟',
  traitRumors: [
    '底が光る。宝の噂の絶えない穴だ。',
    '光に寄るものは、みな牙を持っているとも言う。',
    '得物の当たりが多い。生きて振るえれば、だが。',
  ],
  biases: {
    metallicEnemyRate: 0.5,
    upperTrapRate: 0.55,
    lowerReturnDifficulty: 0.65,
    potionInstability: 0.6,
    rewardWeaponBias: 0.85,
    enemyDensity: 0.4,
    enemyLethality: 0.7,
  },
};

const TIDE_GRAVE: DungeonCharacter = {
  id: 'tide-grave',
  name: '汐の墓標',
  traitRumors: [
    '汐間で一番深い。名前の由来は聞くな。',
    '帰りの階段は、あって三つ。崩れて二つ、だそうだ。',
    '底の宝を持ち帰った者は、まだいない。',
  ],
  biases: {
    metallicEnemyRate: 0.45,
    upperTrapRate: 0.65,
    lowerReturnDifficulty: 0.9,
    potionInstability: 0.8,
    rewardWeaponBias: 0.7,
    enemyDensity: 0.5,
    enemyLethality: 0.85,
  },
};

// ================================================================
// ギルドの支部台帳
// ================================================================

/** ギルドの支部（地名つき）。台帳は支部ごと・1支部9地図。まずは2支部から */
export const BRANCHES: GuildBranch[] = [
  {
    id: 'haimine',
    name: '灰嶺支部',
    tagline: '山あいの鉱山町。乾いた穴と、金物の音の領分だ。',
    wells: [
      ASH_ADIT,
      DOG_HOWL_BURROW,
      RUSTED_ADIT,
      SILENT_WELL,
      NEEDLE_SEAM,
      WIND_HOLLOW,
      ARMOR_PIT,
      CRUMBLE_DEEP,
      KINGS_FLUME,
    ],
  },
  {
    id: 'shioma',
    name: '汐間支部',
    tagline: '海際の沈み地。水と霧と、濡れた帰り道の領分だ。',
    wells: [
      TIDEPOOL_CAVE,
      CRAB_SHELF,
      SALT_GALLERY,
      FOG_SHIPGRAVE,
      SUNKEN_CHAPEL,
      DROWN_VALE,
      SHADE_CANAL,
      GLEAM_GROTTO,
      TIDE_GRAVE,
    ],
  },
];

/** 全支部の穴を平らに並べた一覧（?well= の解決などに使う） */
export const ATLAS: DungeonCharacter[] = BRANCHES.flatMap((b) => b.wells);

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

// ---- 薬（5種）。瓶の銘は読めるが、効くかどうかは土地と運が決める ----

/** 薬の名前（瓶の銘）。UIと出来事の文で共通に使う */
export const POTION_NAMES: Record<string, string> = {
  salve: '傷薬',
  elixir: '霊薬',
  antidote: '解毒薬',
  tonic: '滋養薬',
  murk: '濁り薬',
};

/** 薬の出現重み（拾い物・箱・骸の懐で共通） */
export const POTION_DROP: readonly (readonly [PotionKind, number])[] = [
  ['salve', 0.32],
  ['tonic', 0.2],
  ['antidote', 0.16],
  ['murk', 0.22],
  ['elixir', 0.1],
];
