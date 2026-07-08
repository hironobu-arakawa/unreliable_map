// 共有型定義（§15 のスケッチを実装用に具体化したもの）
// 注: 仕様のTileスケッチでは 'boundary' をタイル種別としていたが、
// 「?（境界）」はプレイヤーの知識に相対的な概念のため、地形は wall/floor の純粋な事実とし、
// 境界は renderer 側が知識レイヤから算出する（憲法2: 地形の事実は揺れない）。

export type Vec = { x: number; y: number };

export type Tile = { kind: 'wall' } | { kind: 'floor' };

// ---- 迷宮の性格（共有・記憶される単位）----
export type DungeonCharacter = {
  id: string;
  name: string; // 例: "沈黙の井戸"
  /** 導入で見せる性格の噂（テンプレ文。ラベル付きで表示） */
  traitRumors: string[];
  biases: {
    metallicEnemyRate: number; // 金属系の出やすさ 0..1
    upperTrapRate: number; // 上層の毒罠の出やすさ 0..1
    lowerReturnDifficulty: number; // 下層の帰還困難さ 0..1
    potionInstability: number; // 薬効の不安定さ 0..1
    rewardWeaponBias: number; // 報酬の武器寄り度 0..1
    enemyDensity: number; // 敵の多さ 0..1（低いほど少数精鋭）
    enemyLethality: number; // 一体あたりの危険度 0..1
  };
};

// ---- ダンジョン内の存在 ----
export type FeatureKind =
  | 'stairsUp' // 上り階段（B1では入口）
  | 'stairsDown' // 下り階段
  | 'spring' // 泉（見た目では飲めるかどうか分からない）
  | 'driedSpring' // 枯れた泉（外れ方「条件が違う」の受け皿）
  | 'trap' // 毒罠（踏むまで見えない）
  | 'collapse' // 崩落（元は通路だった痕跡）
  | 'chest' // 宝箱（開けるまで中身は分からない。検証行為そのものがリスク）
  | 'treasure'; // 最深部の宝

/** 宝箱の中身（生成時に確定。視界では絶対に判別できない） */
export type ChestContent = 'weapon' | 'potion' | 'food' | 'needle' | 'mimic' | 'empty';

export type Feature = {
  id: string;
  kind: FeatureKind;
  pos: Vec;
  /** 崩れかけの階段など、状態フラグ */
  crumbling?: boolean;
  /** 罠が発動済みか */
  triggered?: boolean;
  /** 宝が回収済みか */
  taken?: boolean;
  /** 泉を飲んだ回数（飲むほど細り、やがて涸れる） */
  uses?: number;
  /** 泉の水が悪い（毒。見た目では分からない——記録と嗅覚だけが頼り） */
  badWater?: boolean;
  /** 宝箱の中身 */
  chestContent?: ChestContent;
  /** 宝箱が開封済みか */
  opened?: boolean;
};

export type EnemyKind = 'metallic' | 'beast' | 'shade';

export type Entity = {
  id: string;
  kind: EnemyKind;
  name: string; // 例: "壊れた鎧を引きずるもの"
  pos: Vec;
  strength: number; // 0..1
  alive: boolean;
  /** 行動間隔。2なら1ターンおき（金属系は重く、遅い＝振り切れる） */
  moveEvery: number;
  /** 追跡中か。全知にはしない——「最後に見た位置」を追う */
  chasing: boolean;
  /** プレイヤーを最後に見た位置（視線が切れたらここへ向かい、見つからなければ諦める） */
  lastSeen: Vec | null;
  /** 視線を失ってからの経過ターン */
  lostTurns: number;
  /** 持ち物（必ず何か落とす。気配・記録のヒント対象＝挑む動機） */
  carry: 'weapon' | 'potion' | 'food' | 'none';
  /** 宝箱に潜んでいる（ミミック）。開けられるまで動かず、見えず、遭遇しない */
  dormant?: boolean;
};

export type ItemKind = 'potion' | 'food' | 'weapon';

export type Item = {
  id: string;
  kind: ItemKind;
  name: string;
  pos: Vec | null; // null = 所持中
  taken: boolean;
  /** 朽ちていて使い物にならない（外れ方「条件が違う」の受け皿） */
  broken?: boolean;
};

export type Floor = {
  depth: number; // 1 = B1
  width: number;
  height: number;
  grid: Tile[][]; // grid[y][x]
  entities: Entity[];
  items: Item[];
  features: Feature[];
};

// 具体インスタンス（runSeedで決まる。潜行中は不変）
export type DungeonInstance = {
  character: DungeonCharacter;
  runSeed: number;
  floors: Floor[];
};

// ---- 情報片 ----
export type InfoSource =
  | 'traversed'
  | 'sight'
  | 'sense'
  | 'oldMap'
  | 'survivorNote'
  | 'deathNote'
  | 'ownLog'
  | 'aiHint'; // v0.1未使用（枠のみ確保）

export type MissPattern =
  | 'drift' // 位置が少しズレる
  | 'condition' // 内容は合うが条件が違う
  | 'stale' // 古い情報だった
  | 'misread' // 主観の誤認
  | 'false'; // 完全な誤情報（稀）

/** 情報が主張する内容の種別 */
export type ClaimKind = 'spring' | 'enemy' | 'trap' | 'treasure' | 'passage' | 'weapon' | 'chest';

/**
 * 古地図・メモ・気配などの情報片。
 * internalP はUIに出さない（憲法5）。ラベルは confidence.ts の射影で得る。
 */
export type Claim = {
  id: string;
  source: InfoSource;
  internalP: number; // 0..1（UIに出さない）
  kind: ClaimKind;
  floorDepth: number; // どの階についての情報か
  /** 主張する位置（曖昧化して文章にする。nullなら「この階のどこか」） */
  claimedPos: Vec | null;
  /** プレイヤーに見せる文章（テンプレ文） */
  text: string;
  /** 解決結果（生成時に確定。地形はこの結果を織り込んで最終化される） */
  held: boolean;
  missPattern?: MissPattern;
  /** 実際の対象位置（検証用。missの場合claimedPosとズレる/存在しない） */
  actualPos: Vec | null;
  /** 実際に何があるか（検証・計測用の内部文字列） */
  actualKind: string;
  /**
   * 文面が主張する安全性（プレイヤーが文章から読み取れる情報の機械可読形）。
   * 'good'=当たり/安全と言っている 'bad'=触るな/危険と言っている
   */
  assertedSafety?: 'good' | 'bad';
  /** 動く敵についての情報は、位置ではなく敵本体の目視/撃破で検証する */
  aboutEnemyId?: string;
  /** 検証済みフラグ（行動後の対応表示・計測を一度だけ行う） */
  verified: boolean;
};

// ---- プレイヤー状態 ----

/** 武器の段階。0=素手（折れた） 1=傷んだ短剣（初期装備） 2=剣 */
export type WeaponTier = 0 | 1 | 2;

export type PlayerState = {
  condition: number; // 体調（HP相当）0..100 内部値。UIは言葉のみ
  hunger: number; // 空腹 0..100（高いほど空腹）
  armorWear: number; // 鎧の傷み 0..100
  torch: number; // 燃えている松明の残り 0..100
  spareTorches: number; // 予備の松明（尽きてからが本当の暗闇）
  poisonTurns: number; // 毒の残りターン
  weaponTier: WeaponTier;
  hasTreasure: boolean; // 最深部の宝
  potions: number;
  food: number;
  ownLog: Claim[]; // 自分の過去ログ（p=0.70..0.90 枠。v0.1では最小限）
};
