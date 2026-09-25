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

export type CardRef =
  | { ref: 'self' }               // この能力を「今持っている」カード。コピー（模写）されたらコピー先に再束縛される
  | { ref: 'grantor' }            // この能力を与えたカード（例: 能力を与えるアイテム）。コピーされた能力では「無し」
  | { ref: 'equipped' }           // このアイテムを装備しているキャラ／バトルカード
  | { ref: 'slot'; slot: string } // §3 の選択で埋まったもの
  | { ref: 'event'; role: EventRole } // 進行中の処理の当事者（ダメージの受け手など）
  | { ref: 'battle'; role: 'challengerParticipants' | 'challengedParticipants' | 'battleCard' }
  | { ref: 'it' }                   // Selector の where の中で「いま調べている1枚」
  | { ref: 'named'; name: string }    // 名前で指す（『HM-12』等）。コピーしても self にならない（FAQ oldfaq.txt:2172-2173）
  // ── R2b で足した（HANDOFF-R2b「決めたこと」）
  | { ref: 'participants'; side: PlayerRef }  // 進行中のバトルのそのプレイヤーのバトル参加キャラ
  | { ref: 'opponentChar'; of: CardRef }      // 対戦キャラ（相手側のバトル参加キャラ）。参加していないキャラが身代わりで結果ダメージを受けたら元の受け手の対戦キャラ（H-13）

/** 進行中の処理オブジェクトの役。ダメージ・ダウン・宣言・バトル種目選択など */
export type EventRole = 'damageRecipient' | 'damageDealer' | 'downedChar' | 'declaredAction' | 'selectedBattleCard'

/** カードの集合を選ぶ条件 */
export interface Selector {
  zone: 'field' | 'hand' | 'trash' | 'deck' | 'battleCards' | 'fieldCard'
  side: PlayerRef | 'both'
  class?: CharClass
  kind?: CardKind[]
  where?: Cond
  excludeLeader?: boolean
  exclude?: CardRef[]
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
  // ── R2a で足した（HANDOFF-R2a「決めたこと」）
  | { nameIs: [CardRef, string] }             // カード名が一致する（『黒うさぎの絵皿』など）
  | { targets: CardRef }                       // 進行中の宣言（イベントの役 declaredAction）がこのカードを対象にしている（《すっとぼけ》）
  // ── R2b で足した
  | { joined: CardRef }                        // いまの段（20-4[8]・[13]）でバトルに参加したキャラ（「バトルに参加したとき」）
  | { battleResult: true }                     // 進行中のダメージ（・ダウン）がバトルの結果ダメージ（20-10。FAQ:3978「攻と防から計算されたもの」）
  | { activeIs: PlayerRef }                    // そのプレイヤーのターン（「自分のターンの終了時」）
  | { battlePlace: [CardRef, '屋内' | '屋外'] } // バトルカードの分類
  | { joinedReady: CardRef }                   // 待機状態でバトルに参加したキャラ（《エキサイト》）
  | { attachedTo: [CardRef, CardRef] }        // アイテムがそのキャラに装備されている（「このキャラが装備しているアイテム」）

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
  | { stat: CardRef; rule: 'any' | 'maxBase' | 'minBase' }
  | { option: string[] }

export interface Choice {
  slot: string
  chooser: PlayerRef
  pick: Pick
  count: [number, number]
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
  | { kiryoku: number; of?: CardRef }   // 「気力－N」。既定は能力を持つキャラ自身（8-3）
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
  | { op: 'statMod'; who: CardRef; stat: Attr | { slot: string }; delta: Expr; kind: '能力値修正' | '攻防修正'; duration: Duration }
  | { op: 'damage'; to: CardRef; amount: Expr }                  // 15-4-2 ダメージ処理を起動する（気力を直接いじらない）
  | { op: 'kiryoku'; who: CardRef; delta: Expr; recover?: true }  // 「気力－N」「気力をN点回復」＝ダメージではない（FAQ oldfaq.txt:908-909）
  | { op: 'orient'; who: CardRef; to: 'ready' | 'rested' }
  | { op: 'trash'; what: CardRef }
  | { op: 'draw'; player: PlayerRef; n: number }
  // ── 進行中の処理を書き換える（MTG の置換効果の代わり。原典には置換効果という概念が無い）
  | { op: 'redirectDamage'; to: CardRef }                         // 進行中のダメージ1件の受け手を差し替える
  | { op: 'adjustDamage'; delta: number; scope: 'this' | 'allSimultaneous' }
  | { op: 'counter'; what: 'thisEffect' | { declared: CardRef } } // 打ち消し（原典に定義が無い ❓）
  // ── バトル
  | { op: 'setParticipants'; side: 'challenger' | 'challenged'; to: CardRef | Selector; exhaust: boolean; previous: 'keepState' | 'readyIfWasReady' }
  | { op: 'setBattleChoice'; side: 'challenger' | 'challenged'; key: string; value: CardRef | Attr | { slot: string } }
  // ── 相手（や他者）に選ばせる・払わせる
  | { op: 'offer'; to: PlayerRef; prompt: string; pay: Op[]; payableIf?: Cond; ifPaid: Op[]; ifDeclined: Op[] }
  // ── 能力と実体
  | { op: 'grantAbility'; to: CardRef; ability: Ability | { copyOf: { slot: string } }; duration: Duration; group?: string; onReplaced?: 'dropItsEffects' }
  | { op: 'createToken'; token: TokenSpec; side: PlayerRef; orientation: 'ready' | 'rested' }
  | { op: 'addContinuous'; effect: Continuous; duration: Duration }
  // ── 制御
  | { op: 'choose'; choice: Choice }
  | { op: 'if'; cond: Cond; then: Op[]; else?: Op[] }
  | { op: 'forEach'; in: Selector; as: string; do: Op[] }
  | { op: 'manual'; note: string }                                 // エンジンは扱わない。人が処理し、ログだけ残す
  /** ルールの穴の切り替え（holes.ts）で分岐する。未決で既定の無い穴なら manual に倒れる */
  | { op: 'hole'; id: HoleId; branches: Partial<Record<string, Op[]>> }
  // ── R2a で足した（HANDOFF-R2a「決めたこと」。どれも原典の用語の一回きりの操作）
  /** 同時処理（13-2）: 中の操作の順を AP が決める。中のダメージは同時に発生したダメージのまとまりになる（《不意打ち》FAQ:1600・《嫌がらせ》FAQ:1235） */
  | { op: 'simul'; do: Op[] }
  | { op: 'moveTo'; what: CardRef; to: 'hand' | 'deckTop' | 'deckBottom' }        // 手札に戻す・デッキの上／下に戻す（持ち主の）
  | { op: 'swapZones'; player: PlayerRef }                                          // ゴミ箱のカードを混ぜてデッキと入れ替える（《輪廻》FAQ:1716）
  | { op: 'shuffle'; player: PlayerRef }                                            // デッキをシャッフル（並びは呼び出し側が決める）
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
  | { op: 'atBattleEnd'; do: Op[] }                                                 // [28]《バトル終了時》に処理する
  | { op: 'moveItem'; item: CardRef; to: CardRef }                                  // アイテムを移し替える（装備と同じ扱い 17-3[11] から FAQ:804・2874）
  | { op: 'down'; who: CardRef }                                                    // キャラをダウンさせる（15-5 のダウン処理。《サクリファイス》）

// ───────────────────────────────────────────────────────────────
// §7 継続効果（常時効果 12-2。エンジンは毎回「盤面＋継続効果の一覧」から現在値を導出する）
//   適用順＝効果が発揮し始めた順（タイムスタンプ）。12-2「既に発揮した全ての効果の後に発揮したとみなされ」
//   oldrule.txt:505-506、13-2 oldrule.txt:533-535、FAQ oldfaq.txt:448-449
// ───────────────────────────────────────────────────────────────

export interface ActionPattern {
  kinds: ('特殊能力' | 'イベント' | 'アイテム装備' | 'キャラ呼び出し' | 'タッグ化' | 'バトル' | 'フィールド配置' | 'バトル配置' | 'コスト発生')[]
  by?: PlayerRef | 'any'
  sourceIs?: CardRef          // 「このアイテムを装備したキャラの特殊能力」等
}

export type Continuous =
  | { ce: 'statMod'; who: CardRef | Selector; stat: Attr; delta: Expr; kind: '能力値修正' | '攻防修正' }
  /** 最高値と最低値を入れ替える。入れ替えるのは**今の値**（H-6: 元 力5・感1＋力+2 → 力1・感7）。
   *  層の順で、これより前に掛かった修正ごと入れ替わり、後から来た修正は入れ替わらない */
  | { ce: 'statSwap'; who: CardRef; tieBreak: { chooser: PlayerRef; when: 'apply' } }
  | { ce: 'battleAttrSwap'; battleCard: CardRef; requires: 'pureAttrs' }                 // [攻]と[防]の入れ替え
  | { ce: 'battleAttrSet'; battleCard: CardRef; side: 'atk' | 'def'; to: Attr; requires: 'pureAttrs' }
  | { ce: 'controller'; who: CardRef; to: PlayerRef }                                     // 使用権の移動（14-4）
  | { ce: 'exemptLimit'; who: CardRef | Selector; limit: 'charCount' | 'sameName' | 'component' }
  | { ce: 'costMod'; applies: ActionPattern; removeIcons: CostIcon[]; floor: 'keepSomePayment' }
  | { ce: 'prohibit'; action: ActionPattern; when?: Cond }                                // 「～できない」
  /** 「～しなければならない」。overrides: 'prohibit' は「いかなる場合でも」＝「できない」より優先（決闘 H-7d） */
  | { ce: 'mandate'; what: 'mustReceiveBattle'; who: CardRef; overrides?: 'prohibit' }
  | { ce: 'cannotGenerateCost'; who: CardRef }
  | { ce: 'cannotEquip'; who: CardRef }
  | { ce: 'notCountedAsDown'; who: CardRef }                                              // 勝利条件に含まれない（9-2-1）
  | { ce: 'manual'; note: string }

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
      choices: Choice[]
      effect: Op[]
    }
  /** 常時効果（12-2・15-13-2・アイテム・フィールド・バトルカード） */
  | { kind: 'static'; name?: string; effects: Continuous[] }
  /** 処理条件がある常時効果（12-2-1）。宣言しない・割り込み型アクションでもない。該当タイミングで自動で処理される */
  | { kind: 'conditional'; name?: string; trigger: Trigger; optional: boolean; effect: Op[]
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

/** バトルカードの[攻][防]。値は手順[23]で評価する（FAQ oldfaq.txt:3857-3858） */
export type BattleExpr =
  | { attr: Attr }
  | { chosenStat: { chooser: 'eachSide'; order: 'battleCardChooserFirst'; when: 'onSelect' }; plus: number }
  | { sum: BattleExpr[] }
  | { const: number }
  | { manual: string }

/** 記述の段階（DESIGN §5.4「段階」）。tested＝関係する FAQ ケースが全部通った */
export type DefStatus = 'draft' | 'tested' | 'manual'

/** ルールの穴の ID（DESIGN §5.3）。値の型と既定は holes.ts */
export type HoleId = `H-${number}${'' | 'a' | 'b' | 'c' | 'd' | 'e'}`

/** カード1枚の記述。本文（text）は持たない（本文は pool.json・非公開） */
export interface CardDef {
  id: string
  name: string
  kind: CardKind
  status: DefStatus
  /** この記述が依存しているルールの穴 */
  holes?: HoleId[]
  cost?: Cost
  equip?: { targetKind: 'キャラ' | 'バトルカード' | 'フィールド'; notLeader?: boolean }
  battle?: {
    atk: BattleExpr
    def: BattleExpr
    /** 【○を含む～】の判定に使うアイコン（oldrule.txt:1256-1262。隠し芸は「？」なので空） */
    icons: { atk: Attr[]; def: Attr[] }
  }
  abilities: Ability[]
}
