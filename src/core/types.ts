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

/**
 * ギルドの支部（地名がつく）。台帳は支部ごとに分かれ、1支部につき9つの穴を載せる。
 * 並びは浅い穴→深い穴。
 */
export type GuildBranch = {
  id: string;
  name: string; // 例: "灰嶺支部"
  /** 帳場が支部について添える一言 */
  tagline: string;
  wells: DungeonCharacter[];
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
export type ChestContent =
  | 'weapon'
  | 'armor' // 鎖帷子などの防具
  | 'potion'
  | 'food'
  | 'talisman' // 模様の札
  | 'gem' // 宝石（持ち帰れば換金できる）
  | 'treasure' // 持ち帰るべき宝（箱型のランでのみ）
  | 'needle'
  | 'mimic'
  | 'empty';

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
  carry: 'weapon' | 'potion' | 'food' | 'gem' | 'treasure' | 'none';
  /** 宝箱に潜んでいる（ミミック）。開けられるまで動かず、見えず、遭遇しない */
  dormant?: boolean;
  /** 最深部の主（宝を抱く守り手。ボス型のランでのみ） */
  boss?: boolean;
  /** 眠りの札で眠っている残りターン。眠っている間は知覚も移動もしない */
  sleepTurns?: number;
};

export type ItemKind = 'potion' | 'food' | 'weapon' | 'armor' | 'stone' | 'talisman' | 'gem';

/** 宝石の種類。持ち帰ればギルドの帳場が銀貨に換えてくれる（死ねば大地に還る） */
export type GemKind = 'garnet' | 'moonstone' | 'sapphire';

/** 薬の種類。瓶の銘は読める——効くかどうかは土地（potionInstability）と運が決める */
export type PotionKind = 'salve' | 'elixir' | 'antidote' | 'tonic' | 'murk';

export type Item = {
  id: string;
  kind: ItemKind;
  name: string;
  pos: Vec | null; // null = 所持中
  taken: boolean;
  /** 朽ちていて使い物にならない（外れ方「条件が違う」の受け皿） */
  broken?: boolean;
  /** 札の模様。模様から属性は察知できない（対応はランごとにシャッフル） */
  pattern?: string;
  /** 薬の種類（kind === 'potion' のとき） */
  potionKind?: PotionKind;
  /** 宝石の種類（kind === 'gem' のとき） */
  gemKind?: GemKind;
};

/** 札の効き方の系統。模様→系統の対応はランごとにシャッフルされる */
export type TalismanEffect = 'burn' | 'slow' | 'sleep' | 'haste';

/** 札の模様ごとの真実（ランごとに確定。見た目からは読めない） */
export type TalismanLore = Record<
  string,
  { effect: TalismanEffect; strongVs: EnemyKind; backfireVs: EnemyKind }
>;

/** 宝の出所（ランごとにシードで決まる） */
export type TreasureMode = 'chest' | 'boss';

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
  /** 宝の出所（箱の中か、主が抱いているか） */
  treasureMode: TreasureMode;
  /** 札の模様→効果の対応（ランごとにシャッフル。UIには出さない） */
  talismanLore: TalismanLore;
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
export type ClaimKind =
  | 'spring'
  | 'enemy'
  | 'trap'
  | 'treasure'
  | 'passage'
  | 'weapon'
  | 'chest'
  | 'lore'; // 札の相性など、場所に紐付かない知識（floorDepth=0で全域扱い）

/**
 * 記録の文書（メモ）。古地図・生還者のメモ等の「一枚の紙」。
 * 信頼度の手がかり（紙の状態・字の乱れ）と内部確率は文書に属し、
 * 中身の各行（Claim）は文書の p で個別に解決される（憲法6: 手がかりは文書の質を語る）。
 */
export type Memo = {
  id: string;
  source: InfoSource;
  internalP: number; // 文書としての信頼度 0..1（UIに出さない）
  cue: string; // 紙の状態・字の乱れなどの物理的手がかり
};

/**
 * 古地図・メモ・気配などの情報片。
 * internalP はUIに出さない（憲法5）。ラベルは confidence.ts の射影で得る。
 */
export type Claim = {
  id: string;
  source: InfoSource;
  /** 属する文書。気配・見立て（sense）は文書を持たない */
  memoId?: string;
  internalP: number; // 0..1（UIに出さない。文書に属する行は文書のpと同値）
  kind: ClaimKind;
  floorDepth: number; // どの階についての情報か
  /** 主張する位置（曖昧化して文章にする。nullなら「この階のどこか」） */
  claimedPos: Vec | null;
  /** プレイヤーに見せる文章（テンプレ文） */
  text: string;
  /**
   * 信頼度の物理的手がかり（憲法6の射影を「怪しい」等のラベルではなく
   * 字の乱れ・紙の状態などの固定語彙で見せる。同じ内部確率帯は常に同じ語彙群）
   */
  cue: string;
  /** 札の相性の噂が指す対象（lore専用） */
  lorePattern?: string;
  loreTargetKind?: EnemyKind;
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

// ---- 装備（アイテムとしての武器・防具） ----

export type WeaponKind = 'dagger' | 'sword' | 'fine';
export type ArmorKind = 'leather' | 'chain';

/**
 * 得物。傷み（wear）は打ち合いで進み、100で折れる。
 * bonus は拵えの出来（-2〜+3。マイナスはなまくら）。拵えは見れば分かる観測事実なので
 * 「剣+2」と数字で表示してよい（憲法5の対象は内部確率であって、観測できる事実ではない）。
 */
export type WeaponGear = { kind: WeaponKind; wear: number; bonus?: number };

/** 鎧。傷みは被弾で進み、100で体をなさなくなる。直す手立てはない——買い替えるか、拾い替える */
export type ArmorGear = { kind: ArmorKind; wear: number; bonus?: number };

// ---- プレイヤー状態 ----

export type PlayerState = {
  condition: number; // 体調（HP相当）0..100 内部値。UIは言葉のみ
  hunger: number; // 空腹 0..100（高いほど空腹）
  torch: number; // 燃えている松明の残り 0..100
  spareTorches: number; // 予備の松明（尽きてからが本当の暗闇）
  poisonTurns: number; // 毒の残りターン
  hasteTurns: number; // 韋駄天の札の残りターン（体が軽く、敵の足が半分に見える）
  /** 手持ちの得物。先頭が手にしているもの（最良が自動で先頭に来る）。空なら素手 */
  weapons: WeaponGear[];
  /** 着ている鎧。null なら身を守るものがない */
  armor: ArmorGear | null;
  hasTreasure: boolean; // 最深部の宝
  /** 火油の瓶。種族を問わず大きく削るが、逃げ場のない場所で使えば自分も焼く */
  fireOil: number;
  /** 拾った宝石（種類→個数）。生還すれば帳場で銀貨になる。死ねば失う */
  gems: Record<string, number>;
  potions: Record<string, number>; // 薬の種類→本数（キーは PotionKind）
  food: number;
  stones: number; // 投げる石（安全だが弱い）
  talismans: Record<string, number>; // 模様→枚数
  ownLog: Claim[]; // 自分の過去ログ（p=0.70..0.90 枠。v0.1では最小限）
};
