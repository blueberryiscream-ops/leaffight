/*
 * ルールエンジンのカード記述言語（DSL）の型 — DESIGN.md §5.4 が正
 *
 * 出どころ: _local/実験2-DSL叩き台.ts の §0〜§9（2026-09-25 実験2）に、R0（統括10）の変更を当てたもの。
 * 実例（カードごとの記述）は非公開側 _local/rules/cards/ に置く（本文を公開リポジトリに入れないため）。
 *
 * 方針:
 *  - カードの効果は「データ」。エンジン（src/engine/）はこのデータを読み、core が出す原典の処理手順の
 *    どの段で何を起こすかを決める。カード個別のコードは書かない。
 *  - 用語は原典に合わせる（使用代償・能力値修正・攻防修正・対象・指名・正規タイミング）。
 *  - 書けないもの・自信のないものは `manual`（人が処理）に倒す。
 *  - ルールの穴（DESIGN §5.3）は src/engine/holes.ts の名前つきの切り替えで持つ。
 */

// ───────────────────────────────────────────────────────────────
// §0 基本語彙
// ───────────────────────────────────────────────────────────────

export type Attr = '力' | '早' | '賢' | '根' | '感'
export type CardKind = 'c' | 't' | 'b' | 'i' | 'e' | 'f'
export type CostIcon = 'W' | 'R' | 'G' | 'L' | 'T'
/** 原典15-1: 『キャラ』＝キャラクター＋タッグ／『キャラクター』＝キャラクターカードのみ（トークンは含まない FAQ oldfaq.txt:3302-3303） */
export type CharClass = 'キャラ' | 'キャラクター' | 'タッグキャラクター'

/** 正規タイミング（_local/interrupt-timings.md の60種。原典の語をそのまま使う。独自カテゴリを作らない） */
export type Timing =
  | 'ターン開始時' | 'エントリー開始時' | 'エントリー終了時' | 'メインフェイズ開始時' | 'メインフェイズ終了時'
  | '終了フェイズ開始時' | '終了フェイズ終了時' | '手札調整フェイズ開始時' | '手札調整時' | '手札調整フェイズ終了時' | 'ターン終了時'
  | 'コストを発生するとき' | 'コストが発生したとき'
  | '手札をゴミ箱送りにするとき' | '手札をゴミ箱送りにしたとき'
  | 'ダメージが発生するとき' | 'ダメージが発生したとき' | 'ダメージを与えるとき' | 'ダメージを受けるとき'
  | 'ダメージを与えたとき' | 'ダメージを受けたとき'
  | 'ダウンするとき' | 'ダウンしたとき'
  | 'キャラクターカードを使用するとき' | 'キャラクターカードが呼び出されるとき' | 'キャラクターカードが呼び出されたとき'
  | 'タッグキャラクターカードを使用するとき' | 'タッグ化するとき' | 'タッグ化したとき'
  | '特殊能力を使用するとき' | '特殊能力を使用したとき' | '効果が発生したとき'
  | 'イベントカードを使用するとき' | 'イベントカードを使用したとき'
  | 'アイテムカードを使用するとき' | 'アイテムカードを装備したとき'
  | 'フィールドカードを使用するとき' | 'フィールドカードを配置したとき'
  | 'バトルカードを使用するとき' | 'バトルカードを配置したとき' | 'バトルカードをゴミ箱送りにするとき' | 'バトルカードをゴミ箱送りにしたとき'
  | 'バトルを挑まれたとき' | 'バトルに参加するとき' | 'バトルを挑むとき' | 'バトルを挑むキャラを選ぶとき'
  | 'バトルに参加したとき' | 'バトルを挑んだとき' | 'バトルを挑むキャラを選んだとき'
  | 'バトルを受けるとき' | 'バトルを受けるキャラを選ぶとき' | 'バトルを受けたとき' | 'バトルを受けるキャラを選んだとき'
  | 'バトルカードを選択するとき' | 'バトルカードを選択したとき' | 'バトルを選択したとき'
  | 'バトルの結果の計算をしたとき' | 'バトルの結果を出したとき' | 'バトル終了時' | 'バトルが終了したとき'
  | 'バトル終了後'   // 20-4[29]（oldrule.txt:1126-1127。interrupt-timings.md の一覧に無いが原典にある。R2b で足した）

// ───────────────────────────────────────────────────────────────
// §1 参照（誰が／どのカードが）
//   ⚠ 参照は「評価した時点」で解決する。妖刀で使用権が変わると 'you' の指す席も変わる。
// ───────────────────────────────────────────────────────────────

export type PlayerRef =
  | 'you'               // この能力・カードの「使用権を持つ」プレイヤー（14-4）。持ち主ではない
  | 'opponent'          // その相手
  | 'active' | 'nonActive'
  | 'challenger' | 'challenged'   // 20-2
  | 'battleUser'                  // 「このバトルを使用したプレイヤー」。誰かは穴 H-9c の切り替え（既定＝挑んだ側）
  | 'equipper'                    // このアイテムを装備させたプレイヤー（性格反転キノコ）
  | { controllerOf: CardRef }
  | { ownerOf: CardRef }          // 3-3 持ち主（ゲーム中不変）
  | { slot: string }              // §3 の選択で選んだプレイヤー（Pick { player } の答え。D20・R4a-2）
  /** 既に決めた席（'A'|'B'）。battleUser 等バトルに依存する PlayerRef を層を作る時点で解決して固定するときに使う（R4b-1 続き・統括16） */
  | { seat: 'A' | 'B' }
  /** そのプレイヤーの相手（《計画的犯行》《借金取り》が自分を対象にしたとき、払う先は対象の相手。R4c G3d・NH-33④） */
  | { opponentOf: PlayerRef }

export type CardRef =
  | { ref: 'self' }               // この能力を「今持っている」カード。コピー（模写）されたらコピー先に再束縛される
  | { ref: 'grantor' }            // この能力を与えたカード（例: 能力を与えるアイテム）。コピーされた能力では「無し」
  | { ref: 'equipped' }           // このアイテムを装備しているキャラ／バトルカード
  | { ref: 'slot'; slot: string } // §3 の選択で埋まったもの
  | { ref: 'event'; role: EventRole } // 進行中の処理の当事者（ダメージの受け手など）
  | { ref: 'battle'; role: 'challengerParticipants' | 'challengedParticipants' | 'battleCard' }
  /** そのプレイヤーのデッキの一番上の1枚（無ければ空。《予知能力》R4c G5b。ドローではない＝デッキ0枚でも何も起きない oldrule.txt:552-555） */
  | { ref: 'deckTop'; side: PlayerRef }
  | { ref: 'it' }                   // Selector の where の中で「いま調べている1枚」
  | { ref: 'named'; name: string }    // 名前で指す（『HM-12』等）。コピーしても self にならない（FAQ oldfaq.txt:2172-2173）
  // ── R2b で足した（HANDOFF-R2b「決めたこと」）
  | { ref: 'participants'; side: PlayerRef }  // 進行中のバトルのそのプレイヤーのバトル参加キャラ
  /** そのプレイヤーのリーダー（評価した時点。「味方リーダーの気力－２」ジェラシー・死中に活。R4c G1a-2） */
  | { ref: 'leader'; side: PlayerRef }
  /** この使用代償を払うために 7-2 で消耗させたキャラ（宣言の costGens の発生源・処理時に場にいるものだけ。消耗させずに払った＝空。《手作り弁当》R4c G3d・NH-33①⑤） */
  | { ref: 'paidBy' }
  | { ref: 'opponentChar'; of: CardRef }      // 対戦キャラ（相手側のバトル参加キャラ）。参加していないキャラが身代わりで結果ダメージを受けたら元の受け手の対戦キャラ（H-13）

/** 進行中の処理オブジェクトの役。ダメージ・ダウン・宣言・バトル種目選択など */
export type EventRole = 'damageRecipient' | 'damageDealer' | 'downedChar' | 'declaredAction' | 'selectedBattleCard' | 'summonedChar'

/** カードの集合を選ぶ条件 */
export interface Selector {
  zone: 'field' | 'hand' | 'trash' | 'deck' | 'battleCards' | 'fieldCard'
  /** もう1つの置き場も候補に入れる（《メーカー直販》「デッキあるいはゴミ箱から」。R4c G5a）。zone が deck／hand／trash のときだけ */
  orZone?: 'hand' | 'trash' | 'deck'
  side: PlayerRef | 'both'
  class?: CharClass
  kind?: CardKind[]
  where?: Cond
  excludeLeader?: boolean
  exclude?: CardRef[]
  /** 候補をその slot で選ばれた ids に絞る（forEach で「宣言時に選んだ複数のうち、いま zone にあるもの」を拾う。D22・R4a-2） */
  fromSlot?: string
}

// ───────────────────────────────────────────────────────────────
// §2 式と条件
// ───────────────────────────────────────────────────────────────

export type Expr =
  | number
  | { stat: Attr | { slot: string }; of: CardRef; basis: 'current' | 'base' } // base＝『元の能力値』（用語説明【元の○○】oldrule.txt:1162-1164）
  | { kiryoku: CardRef }
  | { count: Selector }
  | { eventAmount: 'damage' }    // 進行中のダメージの値
  | { callCost: CardRef }        // 呼び出しコスト（印刷されたコストアイコンの数。R2a で足した・《恐怖の抱擁》）
  | { battleDamage: CardRef }    // そのキャラが受けるバトルの結果ダメージ（20-4[24] の計算。無ければ 0。R2b）
  | { chosen: string }           // 宣言時に選んだ数（Pick { number } の答え・D16「回復数Xは宣言時に選ぶ」。R4a-2）
  | { add: Expr[] }
  | { sub: [Expr, Expr] }

export type Cond =
  | { all: Cond[] } | { any: Cond[] } | { not: Cond }
  | { inBattle: true }                         // 20-5「バトル中」＝手順[4]〜[28]
  | { battleAt: number[] }                     // 20-4 の手順番号で直接指す
  | { isParticipant: CardRef; side?: 'challenger' | 'challenged' }
  | { same: [CardRef, CardRef] }
  | { friendly: [CardRef, CardRef] }           // 2枚が同じ使用権者の味方か（『味方キャラ』）
  | { isLeader: CardRef }
  | { ready: CardRef }
  | { cmp: [Expr, '<' | '<=' | '==' | '>=' | '>', Expr] }
  | { pureAttrs: CardRef; side: 'atk' | 'def' | 'both' } // 用語【属性のみで構成された～】oldrule.txt:1250-1252
  | { exists: Selector }
  /** その枠に選んだ答えがある（効果の中の「〜することができる」の選択。R4c G5c） */
  | { picked: string }
  // ── R2a で足した（HANDOFF-R2a「決めたこと」）
  | { equipsNamed: [CardRef, string] }          // そのキャラが、名前が prefix で始まるアイテムを装備している（《ファッション》の「衣装」FAQ:3819・3822）
  | { nameIs: [CardRef, string] }             // カード名が一致する（『黒うさぎの絵皿』など）
  | { targets: CardRef }                       // 進行中の宣言（イベントの役 declaredAction）がこのカードを対象にしている（《すっとぼけ》）
  // ── R2b で足した
  | { joined: CardRef }                        // いまの段（20-4[8]・[13]）でバトルに参加したキャラ（「バトルに参加したとき」）
  | { battleResult: true }                     // 進行中のダメージ（・ダウン）がバトルの結果ダメージ（20-10。FAQ:3978「攻と防から計算されたもの」）
  | { activeIs: PlayerRef }                    // そのプレイヤーのターン（「自分のターンの終了時」）
  | { battlePlace: [CardRef, '屋内' | '屋外' | '水中' | '暗闇'] } // バトルカードの分類
  | { joinedReady: CardRef }                   // 待機状態でバトルに参加したキャラ（《エキサイト》）
  | { attachedTo: [CardRef, CardRef] }        // アイテムがそのキャラに装備されている（「このキャラが装備しているアイテム」）
  // ── R3 で足した
  | { hasAttr: [CardRef, Attr] }               // キャラの属性にその属性が含まれる（「[力]属性のキャラ」。複数の属性なら含めば当たる FAQ:1709）
  | { charType: [CardRef, string] }            // キャラタイプを持つか（「[ロボ]の」等。D24・R4a-2）
  | { hasAbility: [CardRef, string] }          // 印刷された特殊能力の見出しがちょうどその名前のものを持つか（「「アイドル」を持っているキャラ」。FAQ:3762 アイドル声優は該当しない。R4b-3b-1）
  | { isKind: [CardRef, CardKind] }            // カードの種別（c・t・b・i・e・f）が一致するか（《パーティ》の分岐・D19・R4a-2）
  | { downed: CardRef }                        // そのカードが今ゴミ箱にある＝ダウン処理が打ち消されずに終わった近似（D22・D16・R4a-2）
  // ── R4c G2a で足した（NH-23・NH-27）
  | { battleNamed: string }                    // 進行中のバトルの種目（バトルカード）のカード名が一致し、種目が決まっている（[18]〜[28]・oldrule 20-5。インファイトで攻防・テキストが変わっても名前のまま FAQ:4042）
  | { battleAtkHas: Attr }                     // 進行中のバトルのバトルカードの印刷された攻撃属性に属性が含まれる（種目が決まった [18]〜[28]。《チャンピオン》R4c G4d。《インファイト》の選んだ能力値は含まない FAQ:3136）
  | { sexIs: [CardRef, '男性' | '女性'] }      // その性別か「両方」なら真。性別無しはどちらにも偽（FAQ:2939）
  | { oppositeSex: [CardRef, CardRef] }       // 異性（NH-24）: 男性⇔女性。「両方」は男性・女性・両方の誰とでも異性。性別無しはどれとも異性でない（どちらが無しでも偽）。R4c G2b-2a《衣装・きわどい服》
  | { nameStarts: [CardRef, string] }          // カード名が prefix で始まる（「衣装」で始まるアイテム。R4c G2b-2a。equipsNamed と同じ prefix の考え方）
  | { some: CardRef; cond: Cond }              // 参照が指す複数のうち1つでも cond（it＝その1枚）を満たせば真。「対戦キャラが〜なら」の複数参加（NH-23）。既存の every の Cond は変えない
  | { sameName: [CardRef, CardRef] }           // 2枚の名前が一致する（動的な相手。D18「同名キャラがいる」・R4a-2）
  /** 今の窓を開いた宣言（env.trigger）の元の能力・イベントの効果が、その op を含むか（再帰。forEach・if・simul・offer の中も見る）。
   *  「ドローする効果をもつ」（D23・おあずけ）の宣言時の制限に使う。カード構造の検査なので board 状態ではない */
  | { declaredHasOp: string }
  /** 今の窓を開いた宣言の効果に、そのカードの気力を直接減らす op（op:kiryoku・recover でない・delta が負）があり、宣言の時点でそのカードに及ぶ（対象に選んだ・全体の効果に含まれる）。
   *  ダメージ・使用代償の気力－・回復数マイナスの回復（recover:true）は含まない（規 1195-1199・NH-31②④）。《命の香炉》R4c G11b-3 */
  | { declaredReducesKiryoku: CardRef }

// ───────────────────────────────────────────────────────────────
// §3 選択 — 「対象にとる」と「とらない」を分ける
//   target : 宣言時（15-13-1[3]・16-1[3]・17-3[3]）に指定。立ち消え（11-4）の判定対象。
//            【～の対象にならない】（oldrule.txt:1178-1179）の影響を受ける。
//   select : 処理時に選ぶ（対象にとらない）。
//   「指名」（決闘 H-7a）と模写でコピーする能力（H-4）は target（利用者の決定 2026-09-25）
// ───────────────────────────────────────────────────────────────

export type Pick =
  | { cards: Selector }
  | { ability: Selector; excludeNames?: string[] }    // キャラの特殊能力を1つ選ぶ（模写）
  | { stat: CardRef; rule: 'any' | 'maxBase' | 'minBase'; excludeSlot?: string }  // excludeSlot＝その枠で選んだ能力値は選べない（《選り取りバトル》「[攻]／[防]は同じ能力値を使ってはならない」）
  /** 候補をあるキャラの属性に絞る（《アドバイス》「消耗させたキャラの属性と同じ能力値１つ」NH-27⑤。of＝そのキャラ・印刷の属性。R4c G2b-1b）。属性が1つなら選択を出さず、属性なしなら候補0＝選ばない */
  | { stat: CardRef; rule: 'attrOf'; of: CardRef }
  | { option: string[] }
  | { number: { min: number } }  // 数を選ぶ（可変の使用代償・D16「世話焼き」。答えは数の文字列。1以上・上限は無いが候補は実装で有限に区切る）
  | { player: true }             // プレイヤーを選ぶ（候補は両方＝自分も選べる。D20「借金取り」・NH-20 を改めた NH-33④。答えは席の文字）

export interface Choice {
  slot: string
  chooser: PlayerRef
  pick: Pick
  /** 選ぶ枚数の下限・上限。式も書ける（R4c G5b: 《徴収》「自分が捨てた枚数と同数」《緊急回避》「好きな枚数」＝[0, 手札の数]）。処理時に評価し、候補が下限に足りなければある分を選ぶ（画策 FAQ:1182）。上限が 0 なら何も選ばない */
  count: [number | Expr, number | Expr]
  mode: 'target' | 'select'
  when: 'declare' | 'resolve' | 'apply'  // apply＝継続効果が適用される瞬間（装備した時など）
  /** 選ぶときの優先（満たす候補があればその中から選ぶ）。対象の条件ではないので立ち消えの判定には使わない
   *  （《マジカルサンダー》「相手プレイヤーが待機状態のキャラを優先的に選ぶ」FAQ:1995・1998。R2a で足した） */
  prefer?: Cond
  /** 割り振り: 同じカードを何度も選べる。capBy kiryoku＝気力が0より小さくならない回数まで（《サバイバル》FAQ:4109。R2b で足した） */
  repeat?: { capBy: 'kiryoku' }
}

// ───────────────────────────────────────────────────────────────
// §4 使用代償（原典8: 使用代償＝コスト＋属性＋その他）
// ───────────────────────────────────────────────────────────────

export type OtherCost =
  | { kiryoku: number | Expr; of?: CardRef }   // 「気力－N」。既定は能力を持つキャラ自身（8-3）。Expr は可変の使用代償（D16。宣言時に選んだ数 { chosen }）
  | { kiryokuAny: true }                // 気力－任意
  | { trash: CardRef }                  // 「このキャラ／このアイテムをゴミ箱送りにする」
  | { down: CardRef }                   // 「このキャラをダウンさせる」（《マルチ》受け渡し）。取り消されたら支払っていない（FAQ:2040）。R2a で足した

export interface Cost {
  icons: CostIcon[]
  attrs: Attr[]            // 割り当ては 8-2-1 に従いエンジンが行う（修正後に割り当て直す）
  other?: OtherCost[]
  additional?: Cost        // 8-4 追加使用代償
}
export const NO_COST: Cost = { icons: [], attrs: [] }

// ───────────────────────────────────────────────────────────────
// §5 期間（12-1 / 12-2 と、カードに書かれた期間）
// ───────────────────────────────────────────────────────────────

export type Duration =
  | 'instant'                    // 一回きり（ダメージ・移動など）
  | 'endOfTurn'                  // ターン終了時まで（12-1 の能力値修正の既定）
  | 'endOfBattle'                // バトル終了時まで（20-4[28]）
  | 'whileSource'                // 発生元が場にある間（12-2 常時効果）
  | { replacedIn: string }       // 同じ group に新しい物が来たら失う（模写の「新たな能力をコピーした時は…」）

// ───────────────────────────────────────────────────────────────
// §6 操作（一回きりの効果）
// ───────────────────────────────────────────────────────────────

export type Op =
  | { op: 'statMod'; who: CardRef; stat: Attr | 'atk' | 'def' | { slot: string }; delta: Expr; kind: '能力値修正' | '攻防修正'; duration: Duration; mode?: 'add' | 'set'; immune?: ('イベント' | '特殊能力')[] }  // mode 'set'＝能力値を delta（処理時に決まる値）に置き換える（《お手本》「元の能力値をコピー」FAQ:2601・2604。R4c G2b-1b。この層より前の修正は上書き・後の修正は足す）。既定 add＝加算。攻防修正は stat に 'atk'|'def'（層の mod.stat。layers.ts battleMod が引く。R4c G1b-1）
  | { op: 'damage'; to: CardRef; amount: Expr }                  // 15-4-2 ダメージ処理を起動する（気力を直接いじらない）
  | { op: 'kiryoku'; who: CardRef; delta: Expr; recover?: true; /** 実際に増えた点数（上限で切れた分・回復の影響を受けないキャラは数えない）をこの名前の枠に足す（《おもてなし》R4c G3b-1。{ chosen: 名前 } で読む） */ countTo?: string }  // 「気力－N」「気力をN点回復」＝ダメージではない（FAQ oldfaq.txt:908-909）
  | { op: 'orient'; who: CardRef; to: 'ready' | 'rested' }
  | { op: 'trash'; what: CardRef }
  | { op: 'setBattleUsed'; what: Selector; used: boolean }       // バトルカードを使用済み／未使用にする（19-3。《猫寄せドラ》R4c G11a-2。reusable でも使用済みにする）
  /** お互いが同時に n 枚ドローする。引けなかった側が負け・両方なら引き分け（《心機一転》oldrule.txt:325。R4c G5b）。1つの action で行い、先に引けなかった側だけ負けにしない */
  | { op: 'drawBoth'; n: number }
  | { op: 'draw'; player: PlayerRef; n: number | Expr }        // n は Expr（「同じ枚数」《記憶喪失》・D23・R4a-2）
  // ── 進行中の処理を書き換える（MTG の置換効果の代わり。原典には置換効果という概念が無い）
  | { op: 'redirectDamage'; to: CardRef }                         // 進行中のダメージ1件の受け手を差し替える
  | { op: 'adjustDamage'; delta: Expr; scope: 'this' | 'allSimultaneous'; halve?: true }  // halve＝今のダメージを半分・端数切り上げ（《衣装・純白のドレス》。1以上のときだけ。delta は 0 にする。R4c G2b-2a）
  /**
   * 打ち消し（原典に定義が無い ❓）。part が無ければ全体（H-8: 範囲は「その効果」だけ）。
   * part: 'draw'（D23・おあずけ・R4a-2）＝その効果のうち「ドロー」の操作（op:'draw'）だけを打ち消す（他は処理する）。
   * part: 'kiryokuDown'（R4c G11b-3・命の香炉 NH-31①）＝その効果のうち、only のカードへの気力を減らす操作（op:kiryoku・recover でない負の delta）だけを打ち消す（他のキャラへの気力減・他の op は処理する）。
   * 'thisEffect' はこの効果自身（env.declId のフレーム）を指す。残りの Op（rest）は実行しない
   */
  | { op: 'counter'; what: 'thisEffect' | { declared: CardRef }; part?: 'draw' | 'kiryokuDown'; only?: CardRef }
  /**
   * 効果の乗っ取り（D11〜D15・R4a-2）。what.declared が指す宣言（いただきます＝相手のイベント／幸せ泥棒＝
   * 処理条件がある常時効果の《効果が発生したとき》の機会 NH-17）の効果を、乗っ取った側（you）が使う。
   * 使用タイミング・使用条件は、乗っ取った側を you として、元の宣言が反応した窓の状況で確かめ直す（D11）。
   * 満たさない・適切な対象が無ければ効果は失われる（この効果自身の宣言も立ち消えにする）。
   * 元の宣言はこの Op が実行された時点で必ず打ち消し扱いになる（元の使用者は使えない。乗っ取りが失われても＝D11）。
   * part: 'recover'（D13・幸せ泥棒）＝元の効果のうち「気力を回復させる」操作（kiryoku recover:true）だけを乗っ取る。
   * 受け手は乗っ取った側がその場で選ぶ（元の受け手の条件を満たすものが候補・選ばないこともできる）
   */
  | { op: 'hijack'; what: { declared: CardRef }; part?: 'recover' }
  // 効果でコストを発生させる（D21・R4a-2）。得たコストは「その他の代償」（7-3）としてすぐ使える（frameId 無し）。
  // icons が配列＝固定の並び（臨時収入の[WWW]等）／{ callCostOf }＝そのカードの印刷された呼び出しコスト＋extra（サクリファイス）
  // useAs（D20・R4a-2）＝発生させたコストは who ではなく useAs の発生済みのコストになる（《借金取り》「支払ったコストは相手プレイヤーが使用する」）
  | { op: 'generateCost'; who?: PlayerRef; times?: Expr; icons: CostIcon[] | { callCostOf: CardRef; extra?: CostIcon[] }; useAs?: PlayerRef;
      /** 発生するコストの属性（R4c G3a・NH-33⑦）。Attr＝固定（お手伝い「[力]属性の[GG]」）／'choose'＝処理時に効果の使用者が5属性から1つ選ぶ（助太刀・お店番「好きな属性の」。属性無しは選べない FAQ:1392）／{ slot }＝選び終えた枠（'choose' が内部で展開した形）。省略＝属性なし */
      attr?: Attr | 'choose' | { slot: string } }
  /**
   * 宣言時に選んだ数など、処理の途中で計算した値を後で参照できるように控える（D23「記憶喪失」の『同じ枚数』・R4a-2）。
   * { chosen: slot } で読む（Pick { number } の答えと同じしくみを流用）
   */
  | { op: 'remember'; slot: string; value: Expr }
  /**
   * 効果で「呼び出す」（D17・R4a-2）。1枚ごとに ①《キャラクターカードが呼び出されるとき》の機会
   * （このときキャラはまだ場に出ていない）→ ②元の場所に残っていれば指定の向きで場に出す → ③《呼び出されたとき》の機会（NH-18）。
   * what が元の場所（宣言時のゾーン）から動いていなければ実行し、動いていれば（他の効果で失われた等）何もしない
   */
  | { op: 'callByEffect'; what: CardRef; orientation: 'ready' | 'rested' }
  // ── バトル
  | { op: 'setParticipants'; side: 'challenger' | 'challenged'; to: CardRef | Selector; exhaust: boolean; previous: 'keepState' | 'readyIfWasReady' }
  | { op: 'setBattleChoice'; side: 'challenger' | 'challenged'; key: string; value: CardRef | Attr | { slot: string } }
  // ── 相手（や他者）に選ばせる・払わせる
  | { op: 'offer'; to: PlayerRef; prompt: string; pay: Op[]; payableIf?: Cond; ifPaid: Op[]; ifDeclined: Op[] }
  /**
   * 効果の中で、指定したプレイヤー（who）がコストを発生させて払う（PHASE-R4b §2(D)・借金取り・NH-19 呼び出しコストの土台）。
   * who に「コストを発生させるアクション」を行うか問う（発生源＝自分の待機状態のキャラ→G/L/T と属性、
   * 手札のキャラ・タッグ→無属性の W。7-1-1・7-1-2）。発生が済んだら（またはしなくても）、who の発生済みの
   * コスト（board.costs[who]）から amount 分のトークンを選んで払う（どのアイコンも W として払える 7-1-1 の上位互換）。
   * giveTo があれば、そのプレイヤーの発生済みのコストへアイコン W・属性そのままで移す（FAQ:1341・1344）。
   * 無ければ消費（7-4）。recordAs は払った数を後で参照するための記録（交渉売買 R4b-3 続きで使う）。
   * amount が { chosen: true } なら払う数も who が選ぶ（0 可。R4b-3a では型のみ・実装は次の束）
   */
  // addToBattlePaid（R4b-3a-2・交渉売買）: amount { chosen:true } のとき、払った数を今のバトルの battle.paid[who] に積む（BattleExpr { paid:true } が読む）。
  // amount { chosen:true } では ifPaid/ifNot は「1枚以上払った／0枚だった（＝どちらかが支払わなくなった）」の分岐になる
  | { op: 'payByPlayer'; who: PlayerRef; amount: CostIcon[] | { chosen: true }; giveTo?: PlayerRef; recordAs?: string; addToBattlePaid?: boolean;
      /** 「払わなければならない」（R4c G4c・アンチ・イベント／スキル NH-34⑩）: 払えるなら払わない選択は無い。発生済みのコストが足りれば問わずに払い、足りなければ「コストを発生させる」を断れない（min 1）。発生源も手札の候補も無ければ問わずに ifNot へ */
      mandatory?: boolean; ifPaid: Op[]; ifNot: Op[] }
  // ── 能力と実体
  | { op: 'grantAbility'; to: CardRef; ability: Ability | { copyOf: { slot: string } }; duration: Duration; group?: string; onReplaced?: 'dropItsEffects' }
  | { op: 'createToken'; token: TokenSpec; side: PlayerRef; orientation: 'ready' | 'rested' }
  | { op: 'addContinuous'; effect: Continuous; duration: Duration }
  // ── 制御
  | { op: 'choose'; choice: Choice }
  | { op: 'if'; cond: Cond; then: Op[]; else?: Op[] }
  | { op: 'forEach'; in: Selector; as: string; do: Op[] }
  | { op: 'manual'; note: string }                                 // エンジンは扱わない。人が処理し、ログだけ残す
  | { op: 'trace'; text: string }                                  // 処理の記録に名前を残すだけ（盤面は変えない。順の確認用・R4a-2）
  /** ルールの穴の切り替え（holes.ts）で分岐する。未決で既定の無い穴なら manual に倒れる */
  | { op: 'hole'; id: HoleId; branches: Partial<Record<string, Op[]>> }
  // ── R2a で足した（HANDOFF-R2a「決めたこと」。どれも原典の用語の一回きりの操作）
  /** 同時処理（13-2）: 中の操作の順を AP が決める。中のダメージは同時に発生したダメージのまとまりになる（《不意打ち》FAQ:1600・《嫌がらせ》FAQ:1235） */
  | { op: 'simul'; do: Op[] }
  | { op: 'moveTo'; what: CardRef; to: 'hand' | 'deckTop' | 'deckBottom' }        // 手札に戻す・デッキの上／下に戻す（持ち主の）
  | { op: 'swapZones'; player: PlayerRef }                                          // ゴミ箱のカードを混ぜてデッキと入れ替える（《輪廻》FAQ:1716）
  | { op: 'shuffle'; player: PlayerRef }                                            // デッキをシャッフル（並びは呼び出し側が決める）
  /** 「相手に見せる」（NH-35③・R4c G5a）。見せたカードの名前を、見せた相手のログに残す（非公開のカード名の例外）。カードは動かさない。画面の表示は別の束 */
  | { op: 'reveal'; what: CardRef; to: PlayerRef }
  /** 「デッキの上を見る」（NH-35③・R4c G5c）。🚨 reveal と違い、見たカードの名前は共有のログに出さず、見た人（viewer）への選択の選択肢にだけ出す。
   *  choose＝見る枚数 0〜max を viewer が選ぶ（false なら min(max, 枚数) 枚）。デッキが少なければある分（NH-35⑪）・0枚なら何もしない。
   *  reorder＝見た人が好きな順に並びを答える→その順でデッキの一番上へ（false なら確認の選択だけ） */
  | { op: 'lookTop'; deckOf: PlayerRef; viewer: PlayerRef; max: number; choose: boolean; reorder: boolean }
  /** lookTop の内部の段（枚数が決まってから見せる・並びを答えさせる）。カードの記述には書かない */
  | { op: 'lookTop2'; deckOf: PlayerRef; viewer: PlayerRef; reorder: boolean; n?: number; countSlot?: string }
  | { op: 'lookTop3'; deckOf: PlayerRef; orderSlot: string; n: number; reorder: boolean }
  /** 「手札を見る」（取材 FAQ:2772）。処理の間だけ viewer にその手札の名前が出る（確認の選択を1回答えるまで）。手札0枚なら選択を出さない */
  | { op: 'lookHand'; of: PlayerRef; viewer: PlayerRef }
  /** 「フィールドに出す」（呼び出しではない FAQ:3106）。orientation.asDeclared＝宣言した時点のそのカードの状態（FAQ:2298・3097）。
   *  inheritFrom＝アイテムとダメージを引き継ぐ元 */
  | { op: 'putOntoField'; what: CardRef; orientation: 'ready' | 'rested' | { asDeclared: CardRef }; inheritFrom?: CardRef }
  | { op: 'cancelDown' }                                                            // 進行中のダウン（役 downedChar）を起こさない（「ダウンせずに」）
  | { op: 'addDowns'; player: PlayerRef; n: number }                                // そのプレイヤーのダウン数を増やす（「相手プレイヤーは勝利条件を＋１」9-2-1）
  | { op: 'setKiryoku'; who: CardRef; value: number }                               // 気力を N にする（ダメージでも気力の減少でもない FAQ:2516）
  // ── R2b で足した（HANDOFF-R2b「決めたこと」。バトルの手順の状態を変える・手順を起こす）
  /** バトルの結果ダメージ（to が受ける分）を増減・固定する。計算前なら計算の後に当てる。0以下は増減しない（20-10）。evenIfZero はカードの表記（21） */
  | { op: 'battleDamage'; to: CardRef | 'all'; delta?: Expr; set?: number; evenIfZero?: boolean }
  | { op: 'firstStrike' }                                                           // このバトルの結果で味方キャラが先にダメージを与える（《先手必勝》）
  | { op: 'skipBattleActions' }                                                     // [19]〜[22] を行わずに結果を出す（《出会い頭》FAQ:1375）
  | { op: 'abortBattle' }                                                           // そのバトルは中断する（「放棄」「遅刻」）
  | { op: 'startBattle' }                                                           // 相手にバトルを挑む（《抜き打ち》）。20-4[3] から
  | { op: 'setBattleCard'; card: CardRef }                                          // バトル種目をこのバトルカードにする（《虎の子バトル》）
  | { op: 'putBattleCard'; what: CardRef }                                          // 手札のバトルカードを自分のフィールドに出す（配置のアクション 19-2 ではない）
  | { op: 'atTurnEnd'; do: Op[] }                                                 // 《ターン終了時》(10-8) に処理する（処理した効果の続き。発生源が能力を失っていても処理。R4c G2b-2b スーパー御堂）
  | { op: 'atBattleEnd'; do: Op[] }                                                 // [28]《バトル終了時》に処理する
  | { op: 'moveItem'; item: CardRef; to: CardRef }                                  // アイテムを移し替える（装備と同じ扱い 17-3[11] から FAQ:804・2874）
  | { op: 'down'; who: CardRef }                                                    // キャラをダウンさせる（15-5 のダウン処理。《サクリファイス》）
  // ── R3 で足した（HANDOFF-R3「決めたこと」）
  /** 「適用されている能力値修正を０にする」（《桑嶋高子》看護）: 効果で足した能力値修正の層（12-1）を外す。常時効果の修正はすぐにまた適用される（FAQ:2433・2436）。
   *  「能力値修正を０にする」自身は能力値修正ではない（FAQ:2442） */
  | { op: 'clearMods'; who: CardRef; kind: '能力値修正' | '攻防修正' }
  /** 2枚のアイテムの装備先を入れ替える（《替え玉》）。装備の手順ではない。入れ替えたアイテムは装備の順の最後（FAQ:1484） */
  | { op: 'swapItems'; a: CardRef; b: CardRef }

// ───────────────────────────────────────────────────────────────
// §7 継続効果（常時効果 12-2。エンジンは毎回「盤面＋継続効果の一覧」から現在値を導出する）
//   適用順＝効果が発揮し始めた順（タイムスタンプ）。12-2「既に発揮した全ての効果の後に発揮したとみなされ」
//   oldrule.txt:505-506、13-2 oldrule.txt:533-535、FAQ oldfaq.txt:448-449
// ───────────────────────────────────────────────────────────────

export interface ActionPattern {
  kinds: ('特殊能力' | 'イベント' | 'アイテム装備' | 'キャラ呼び出し' | 'タッグ化' | 'バトル' | 'フィールド配置' | 'バトル配置' | 'コスト発生' | 'その他')[]  // 'その他'＝アクションアイテムの宣言（17-7。手順は 16-1 と同じだがイベントでも特殊能力でもない FAQ:1080・3428。統括24）
  by?: PlayerRef | 'any'
  sourceIs?: CardRef          // 「このアイテムを装備したキャラの特殊能力」等
  /** 発生源がこの条件を満たす（it＝発生源）。R3 */
  sourceWhere?: Cond
  /** 対象のどれかがこの条件を満たす（it＝対象。「参加キャラを対象にとる特殊能力」FAQ:600・603）。R3 */
  targetWhere?: Cond
  /** 印刷された使用代償にコストアイコンが無い（「０コストの～」《ライジング・コスト》FAQ:4225）。costMod（K6）専用。R4a で足した */
  costIsZero?: boolean
  /** 印刷された使用代償のコストアイコンが n 個以上（《あきんどのそろばん》「装備するアイテムのコストが[WW]以上」NH-34⑤。costIsZero と同じく印刷値を読む）。costMod 専用。R4c G4a */
  printedCostMin?: number
  /** 常に効果を発揮している特殊能力（Auto＝conditional）には掛からない（《ウェイスト》《浪費癖》「常に効果を発揮している特殊能力は対象にならない」。統括26・G4d の検証で見つけた）。costMod 専用 */
  notAuto?: boolean
}

export type Continuous =
  /** when: この条件を満たしている間だけ（《柏木千鶴》恐怖「このキャラが挑んだバトルに参加している間」。R3） */
  | { ce: 'statMod'; who: CardRef | Selector; stat: Attr | 'atk' | 'def'; delta: Expr; kind: '能力値修正' | '攻防修正'; when?: Cond }
  /** 最高値と最低値を入れ替える。入れ替えるのは**印刷値（元の能力値）**で常に同じ（H-6・統括12 2026-09-26 D1: 元 力5・感1＋力+2 → 力1・感5）。
   *  その2つの能力値に先に掛かっていた修正は消え、後から来た修正は上に乗る（層の順）。最高・最低が並んだら装備させたプレイヤーが装備するたびに選ぶ（FAQ:443） */
  /** [水中バトルペナルティ] 等、名前（能力の name）で指したペナルティの効果が who に及ばない（強化兵のさらなる修正も同じ能力の中なので丸ごと。R4c G2b-2b 水着・岩切） */
  | { ce: 'ignorePenalty'; who: CardRef | Selector; name: string; when?: Cond }
  | { ce: 'statSwap'; who: CardRef; tieBreak: { chooser: PlayerRef; when: 'apply' } }
  | { ce: 'battleAttrSwap'; battleCard: CardRef; requires: 'pureAttrs' }                 // [攻]と[防]の入れ替え
  | { ce: 'battleAttrSet'; battleCard: CardRef; side: 'atk' | 'def'; to: Attr; requires: 'pureAttrs' }
  | { ce: 'controller'; who: CardRef; to: PlayerRef }                                     // 使用権の移動（14-4）
  | { ce: 'exemptLimit'; who: CardRef | Selector; limit: 'charCount' | 'sameName' | 'component' }
  /** 使用代償の増減（K6・D3・D4）。払うとき（15-13-1[9]・16-1[9]）の状態で評価する: 印刷値のコストアイコン枚数・気力コストへ、
   *  当てはまる costMod を全部（層の順で）まとめて加算してから下限をとる（アイコンは種類ごとに0未満にならない。気力コストは最終値が0未満にならない）。
   *  icons: アイコン種類ごとの増減（＋で増える・－で減る）。kiryoku: 気力コストの増減（気力－N型の N に足す）。R4a で足した */
  | { ce: 'costMod'; applies: ActionPattern; icons?: Partial<Record<CostIcon, number>>; kiryoku?: number }
  /** 使用代償の置き換え（R4c G4b・NH-34⑧ 《バーゲン・セール》）: 当てはまる宣言の使用代償の**基礎**のコストアイコンを icons にする（属性アイコン・気力コストなどはそのまま。印刷値は変えない）。
   *  effectiveCost が costMod より先に当てる（置き換えてから他の増減を足して下限） */
  | { ce: 'costSet'; applies: ActionPattern; icons: CostIcon[] }
  | { ce: 'prohibit'; action: ActionPattern; when?: Cond }                                // 「～できない」
  /** 「～しなければならない」。overrides: 'prohibit' は「いかなる場合でも」＝「できない」より優先（決闘 H-7d） */
  | { ce: 'mandate'; what: 'mustReceiveBattle'; who: CardRef; overrides?: 'prohibit' }
  | { ce: 'cannotGenerateCost'; who: CardRef }
  /** 《ブースト》（R4c G3b-1）: W（その他のコスト）が1つ発生するごとに、属性無しの W が1つ多く発生する（両方のプレイヤー・G/R/L/T は増えない FAQ:4186） */
  | { ce: 'extraW' }
  /** 《エンプティ》（R4c G3b-1）: W は発生しない（効果の W・手札のキャラを捨てた W。G/R/L/T は発生する FAQ:4073） */
  | { ce: 'noW' }
  /** 《分厚い財布》《衣装・メイド服》（R4c G3b-2）: who が消耗して 7-2 でコストを発生するとき、発生源1つにつき属性無しの W を1つ多く発生する（NH-15 で常に。ブースト・エンプティの対象） */
  | { ce: 'extraWOnGen'; who: CardRef }
  /** 《集魔の鏡》（R4c G3b-2）: who の 7-2 の発生源のコストを、選んだ1属性の G にできる（任意・7-2[7] で選ぶ。財布・メイド服の W も G になる） */
  | { ce: 'genAsG'; who: CardRef }
  /** 《背後霊》（R4c G3b-2）: who が 7-2 の発生源として消耗するたびに気力－1（recover でない負） */
  | { ce: 'restDrain'; who: CardRef }
  | { ce: 'ignoreRecover'; who: CardRef }                                                 // 気力を回復させる効果（kiryoku recover:true）の影響を受けない（《腹ぺこ》NH-31②。対象には選べる）
  /** 常時の「以下の特殊能力を得る」（《釘バット》NH-31⑤・R4c G11b-2）。who（装備先）が、この効果がある間だけその能力を持つ。能力の名前は能力の name（FAQ:3327）。使用代償・宣言はそのキャラの特殊能力と同じ（15-13-1） */
  | { ce: 'grantAbility'; who: CardRef; ability: Extract<Ability, { kind: 'activated' }> }
  | { ce: 'cannotEquip'; who: CardRef }
  | { ce: 'notCountedAsDown'; who: CardRef }                                              // 勝利条件に含まれない（9-2-1）
  | { ce: 'manual'; note: string }
  // ── R3 で足した（HANDOFF-R3「決めたこと」）
  /** 【～の対象にならない】（oldrule.txt:1178-1179）。by の種類の行動の対象に指定すると空打ち（11-3・FAQ:706）。
   *  その種類の常時効果の影響も受けない（《魔法のサークレット》FAQ:697・709） */
  | { ce: 'untargetable'; who: CardRef | Selector; by: ActionPattern }
  /** 「ダメージを受けない」「ダメージを与えない」。from＝ダメージの発生元の条件（it＝発生元）。battle: only＝バトルの結果ダメージだけ・except＝それ以外だけ。
   *  処理するのは 15-4-2[5] の前（身代わり [4] の後 FAQ:1706）。deal＝このキャラが与えるダメージも（《インスタントヴィジョン》） */
  | { ce: 'preventDamage'; who: CardRef | Selector; from?: Cond; battle?: 'only' | 'except'; deal?: boolean }
  /** 「常に消耗状態になる」。always＝待機状態でも即座に消耗させる（《立川郁美》病弱 FAQ:3184・4229）。
   *  無ければ「消耗状態になったら待機状態に戻らない」（《御影すばる》地竜走破 FAQ:2476・2482） */
  | { ce: 'stayRested'; who: CardRef | Selector; always?: boolean }
  /** 【特殊能力を失う】（oldrule.txt:1176-1177）。そのキャラの特殊能力が存在しないものとして扱う（《能力禁止》FAQ:593・597） */
  | { ce: 'loseAbilities'; who: CardRef | Selector }
  /** 「バトルに参加しているキャラに対して効果を発揮している、特殊能力、イベントカードは効果を失う。また使用することもできない」
   *  （R4b-3b-2・統括18。《エクストリーム》《ファッション》《能力禁止》FAQ:593・597・600・603・606・1013・1556・3070・3224・3732・3735・3738・3826）。
   *  who＝参加キャラ（when が真のあいだ）。from＝失わせる側。効き方は layers.ts:
   *  (1) who 自身の常時・誘発の特殊能力は働かない (2) 参加していないキャラの常時の特殊能力が who に及ぼす効果も働かない（FAQ:597後半）
   *  (3) 宣言して使うものは、効果が who に及ぶなら宣言できない（及ばなければ使える FAQ:3735・3070・1013）
   *  (4) 効果で足した層（特殊能力・イベント）は who から外れ、バトル後も戻らない（FAQ:606・3732） */
  | { ce: 'shieldParticipants'; who: Selector; from: ('特殊能力' | 'イベント')[]; when?: Cond
      /** true＝who の能力値修正・攻防修正を発生源を問わず（特殊能力・イベント・アイテム・フィールド）失わせる（《鶴来屋温泉三本勝負》）。
       *  一度きりの効果の層は外して戻さない／常時のものはその間だけ止める（バトル後に導き直す）／足された修正も失われる */
      mods?: boolean }
  /** 気力の上限を変える（15-4）。set＝その値にする・delta＝増減。層の順で重ねる（《ベース・ライフ》FAQ:4206・4209）。残り気力は変えない（FAQ:240・4212） */
  | { ce: 'maxKiryoku'; who: CardRef | Selector; set?: number; delta?: number }
  /** この効果が失われたとき（発生源がフィールドを離れた・装備先が変わった）に処理する。装備対象を満たせずに失ったときは処理しない（《電波での復活》FAQ:550・559） */
  | { ce: 'whenLost'; do: Op[] }
  /** 使用できないバトルカード（「使用できなくなる」《大雨》ではなく《大嵐》。使用済みにはしない FAQ:1499） */
  | { ce: 'battleCardUnusable'; who: CardRef | Selector }
  /** バトルを挑めない・参加できないキャラ（R4c G1a-2）。
   *  role 'challenge'＝「バトルを挑むことができない」（傍観者・詩集・小説・参加停止・VIP）: 20-4[7] の挑むキャラの候補から外す（挑める候補が0なら宣言できない）。
   *  role 'any'＝「バトルに参加することができない」（穏形法）: [7] の挑むキャラ・[11] の受けるキャラの両方の候補から外す。
   *  受ける側の候補が0なら[12]で自動的にリーダーが参加する（FAQ:1165。oldrule 20-4[11][12]）。
   *  core はカードを知らない: エンジンが layers で外すキャラの iid を導き出して core の LayerState に置く（oncePerChar と同じ流れ） */
  | { ce: 'barFromBattle'; who: CardRef | Selector; role: 'challenge' | 'any' }
  /** 「消耗状態でもこのバトルを受けることができる」（《坂神蝉丸》守る者 R4c G2b-1a）: 20-4[11] の受けるキャラの候補に、消耗状態のこのキャラを足す（待機状態の他のキャラ・リーダーも今どおり選べる）。
   *  core はカードを知らない: barFromBattle と同じ流れでエンジンが layers で iid を導き出して core の LayerState.receiveRested に置く。addContinuous・duration endOfBattle で使う */
  /** 「バトルを挑むときは[W]を支払わなければならない」（マネージャー・やる気ナシ・ロゥ R4c G4d・NH-34①④）: そのキャラが20-4[7] の挑むキャラに選ばれる時に、挑んだプレイヤーが**発生済みのコストだけ**で icons ぶん払う（FAQ:3133）。
   *  払えないキャラは挑むキャラの候補から外す。使用代償ではない（costMod は掛からない）。選んだ後に条件が変わっても払い直さない（FAQ:399）。
   *  core はカードを知らない: エンジンが layers で iid ごとの額（効果ごとの icons の数の合計）を導き出して core の LayerState.challengeCost に置く。候補の絞りと支払い（トークンを消す）は core が額だけを見て行う */
  | { ce: 'challengeCost'; who: CardRef | Selector; icons: CostIcon[] }
  | { ce: 'receiveWhenRested'; who: CardRef | Selector }
  /** 「エントリー時に待機状態に戻すことができなくなる」（《病気》R4c G11a-2・FAQ:631）: 10-4[2] の規定の待機戻しの候補から外す（効果で待機にするのは可 FAQ:628）。
   *  core はカードを知らない: エンジンが layers で iid を導き出して core の LayerState.noEntryReady に置く（reusable と同じ流れ） */
  | { ce: 'noEntryReady'; who: CardRef | Selector }

// ───────────────────────────────────────────────────────────────
// §8 誘発（正規タイミング）
// ───────────────────────────────────────────────────────────────

export interface Trigger {
  timing: Timing
  /** 進行中の処理の当事者に対する条件（例: 受け手が味方キャラ） */
  subject?: { role: EventRole; where: Cond }
  /** その処理を行ったのが誰か（DESIGN §5.1 アクター条件） */
  actor?: 'you' | 'opponent' | 'any'
  when?: Cond
}

// ───────────────────────────────────────────────────────────────
// §9 能力とカード
// ───────────────────────────────────────────────────────────────

export type Ability =
  /** 使用代償のある特殊能力・「アクションとして使用する」もの（12-1・15-13-1）。宣言→処理の14段を通る */
  | {
      kind: 'activated'
      name: string
      cost: Cost
      speed: '通常型' | '割込型'
      trigger?: Trigger              // 割込型の「〜とき」
      usableIf?: Cond                // 宣言時の制限（満たさないと宣言できない＝空打ち 11-3）
      perTurn?: number               // 【１ターンにｎ回まで】oldrule.txt:1173-1175。能力インスタンスごとに数える
      /** 通常型に**加えて**割込型でも使える（「コストを発生するときに使うこともできる」＝お手伝い・お店番。R4c G3a）。speed は '通常型' のまま、ここに書いた窓でも宣言できる */
      alsoInterrupt?: Trigger
      choices: Choice[]
      effect: Op[]
    }
  /** 常時効果（12-2・15-13-2・アイテム・フィールド・バトルカード） */
  | { kind: 'static'; name?: string; effects: Continuous[] }
  /** 処理条件がある常時効果（12-2-1）。宣言しない・割り込み型アクションでもない。該当タイミングで自動で処理される */
  | { kind: 'conditional'; name?: string; trigger: Trigger; optional: boolean; effect: Op[]
      /** 同じタイミングの他の処理（軽減など）が済んだ後で処理する（《ダメージ保険》NH-31③。同時処理の順の最後に回す） */
      late?: true
      /** フィールドカードの効果を両プレイヤーそれぞれのものとして処理する（18-1「お互いのプレイヤーや場に及ぼします」・FAQ:4105。R2b で足した）。AP→NAP */
      eachPlayer?: boolean }
  /** カード本体のプレイ（イベントの効果など）。16-1 の14段を通る。name は「次のうち１つ」の選択肢の名前（declare.option で選ぶ・R2a で足した） */
  | { kind: 'play'; name?: string; cost?: Cost; speed: '通常型' | '割込型'; trigger?: Trigger; usableIf?: Cond; choices: Choice[]; effect: Op[] }
  /** DSL で書けない／書かない。エンジンは本文を出すだけ */
  | { kind: 'manual'; name?: string; reason: string }

export interface TokenSpec {
  name: string
  stats: Record<Attr, number>
  kiryoku: number
  attrs: Attr[]
  sex: '男性' | '女性' | '両方' | null
  types: string[]
  /** トークンに常に掛かっている性質（ゴーストの「コストを発生できず」等） */
  traits: Continuous[]
}

/**
 * バトルカードの[攻][防]。値は手順[23]で評価する（FAQ oldfaq.txt:3857-3858）。
 * R4b（統括16・PHASE-R4b §2(B)）で足した: sub（減算・野球拳「5－賢」）／statPick（最も高い／最も低い能力値。ライバル対決。
 * 同値のときは使用者が決める FAQ:3840-3841＝タイブレークは manual に倒す）／kiryoku（残り気力。くすぐりマシーン・潜水にらめっこ）／
 * count（数。応援合戦「待機状態の味方キャラ数」FAQ:3861-3868）／itemCost（参加キャラの装備アイテムのコスト総数。持ち物自慢 FAQ:3935-3942）／
 * none（攻防が無い「-/-」。リラクゼーション。ダメージ計算に関与しない FAQ:1446-1447）。
 * R4b-1 では型と評価だけを足す（使うカードは R4b-2・R4b-3）
 */
export type BattleExpr =
  | { attr: Attr }
  | { chosenStat: { chooser: 'eachSide'; order: 'battleCardChooserFirst'; when: 'onSelect' }; plus: number }
  | { sum: BattleExpr[] }
  | { sub: [BattleExpr, BattleExpr] }
  | { statPick: 'max' | 'min' }
  /** 《選り取りバトル》（FAQ:3956）: 種目を選んだ時点でアクティブプレイヤーが決めた能力値（setBattleChoice の key 'atk'／'def'）。両陣営とも同じ能力値を使う。未選択なら null（人が入れる） */
  | { pickedStat: 'atk' | 'def' }
  | { kiryoku: true }
  | { count: Selector }
  | { itemCost: true }
  | { none: true }
  | { const: number }
  /** 支払ったコストの合計（その陣営。交渉売買 R4b-3a-2）。payByPlayer の addToBattlePaid が積む battle.paid[seat] を読む */
  | { paid: true }
  | { manual: string }

/** 記述の段階（DESIGN §5.4「段階」）。tested＝関係する FAQ ケースが全部通った */
export type DefStatus = 'draft' | 'tested' | 'manual'

/** ルールの穴の ID（DESIGN §5.3）。値の型と既定は holes.ts。NH-* は「仮の既定」のうち holes.ts に登録したもの（R4b で NH-8 を足した） */
export type HoleId = `H-${number}${'' | 'a' | 'b' | 'c' | 'd' | 'e'}` | `NH-${number}`

/** カード1枚の記述。本文（text）は持たない（本文は pool.json・非公開） */
export interface CardDef {
  id: string
  name: string
  kind: CardKind
  status: DefStatus
  /** この記述が依存しているルールの穴 */
  holes?: HoleId[]
  cost?: Cost
  /**
   * 装備対象（17-1）。notLeader＝リーダーには装備できない／leaderOnly＝リーダーのみ／friendlyOnly＝味方キャラのみ（持ち主の味方。使用権の移動 K8 は後）／
   * bound＝装備対象がそのアイテムを使って選んだ1枚に決まる（《電波での復活》「ゴミ箱のキャラクター」。付け替え・タッグの引き継ぎで満たさなくなる FAQ:550・559）。R3 で足した
   */
  equip?: { targetKind: 'キャラ' | 'バトルカード' | 'フィールド'; notLeader?: boolean; leaderOnly?: boolean; friendlyOnly?: boolean; bound?: boolean; sex?: '男性' | '女性' }
  battle?: {
    atk: BattleExpr
    def: BattleExpr
    /** 【○を含む～】の判定に使うアイコン（oldrule.txt:1256-1262。隠し芸は「？」なので空） */
    icons: { atk: Attr[]; def: Attr[] }
    /** 結果ダメージの上限（NH-21・交渉売買「５点以上にはならない」＝4）。pendingEdits（ダメージ返し等）の後にも当てる FAQ:3921 */
    dmgCap?: number
    /** 結果ダメージを半分にする（《漫画》FAQ:3985）。'ceil'＝端数切り上げ。[24] で攻防を比べた直後・pendingEdits より前（0以下はそのまま） */
    dmgHalf?: 'ceil'
    /** 使用されても使用済み状態にならない（《百物語》）。core の [18] が used にしない（エンジンが layers.reusable で渡す） */
    reusable?: true
    /** 一度このバトルを挑んだキャラは、このターン中このバトルを挑めない（《百物語》）。core が挑んだキャラを印として控え、[16] の候補から外す。ターン終了で消える */
    oncePerCharPerTurn?: true
    /** 上から順に複数回計算し、その合計を結果とする（《鶴来屋温泉三本勝負》）。各回は 20-10 の結果ダメージ（0以下は0）を出して合計する。atk/def は表示用。FAQ:3967・3970 */
    rounds?: { atk: BattleExpr; def: BattleExpr }[]
  }
  abilities: Ability[]
  /**
   * このカードが登場する FAQ（`_local/rules/faq/_index.json` の cards にこのカードの id があるもの）の読み合わせ結果。
   * キーは `_index.json` の id（'faq-995' の形）。D25(b)・R4a-2。
   * 'case'＝T ケースがある／'ok'＝記述どおりになることを読み合わせで確かめた（why に1行の理由）／
   * 'manual'＝記述で扱っていない（記述に manual がある）／'na'＝そのカードの効果に関係しない・プール外の版の話
   */
  faqReview?: Record<string, { v: 'case' | 'ok' | 'manual' | 'na'; why?: string }>
}
