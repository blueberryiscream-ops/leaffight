// 原典の処理手順を「段ごとに止まる状態機械」として持つ（core専用・カード知識ゼロ）。
// DESIGN.md §5.4 K1・K2・K10／PHASE-R2a §2。
//
// 手順（原典 _local/oldrule.txt）:
//   7-2 コスト発生 [3]〜[9]（234-264）／15-13-1 特殊能力の使用 [6]〜[14]（766-793）／16-1 イベントの使用 [6]〜[14]（816-844）
//   15-4-2 ダメージ [1]〜[6]（612-632）／15-5-1 ダウン [1]〜[7]（633-649）／15-5-2 同時処理内のダウン（650-655）
//   11-2 アクションの処理 [1]AP→[2]NAP→[3]同時→[4]AP の処理→[5]NAP の処理（468-476）
//   12-2-1・13-2 同時処理（AP が順を決める。517-519・529-532）／9 ゲーム終了条件（320-341）
//
// 形（PHASE-R2a §2-1）:
//   BoardState.proc = 手順のスタック（末尾＝今の手順）。割り込んだ手順（ダメージ・ダウン・宣言された割込型アクション・
//   同時処理）は上に積む。各フレームは段を1つずつ進め、次のどれかで止まる:
//     1. タイミングの段: その段の「アクション宣言の機会」＝窓を開く（status 'window'）。窓が閉じたら、エンジンに
//        《〜とき》の処理（処理条件がある常時効果）を聞き（status 'engine' what 'timing'）、宣言された行動と
//        まとめて同時処理（kind 'simul'）として積む（FAQ:2422「Ｍｙ同志と働き者は同じタイミング…AP が決定」）
//     2. エンジンの段: 支払い[9]・構成要素の確かめ[10][12]・効果の処理[14]・同時処理の各項目（status 'engine'）
//     3. 選択: meta.choice（誰が・何を・選択肢）。同時処理の順（K10）は core が出す。対象などはエンジンが出す
// 乱数・時刻は持たない（連番は meta.seq）。カードの種別・能力の中身は知らない（エンジンが決めて渡す）。
//
// R2b（PHASE-R2b §2）で足した手順:
//   15-10-1 キャラクターの呼び出し [6]〜[14]（680-706）／15-10-2 タッグ化 [6]〜[14]（707-741）
//   17-3 アイテムカードの装備 [6]〜[13]（864-889）／18-2 フィールドカードの配置 [6]〜[13]（935-958）
//   19-2 バトルカードの配置 [6]〜[12]（987-1011）／20-4 バトル [1]〜[29]（1062-1127）・20-6 中断（1133-1139）
//   10-4 エントリーフェイズ [1]〜[5]（384-389）／10-7 手札調整フェイズ [1]〜[4]（430-435）／10-8 ターン終了（436-441）
//   7-2[3]《コストを発生するとき》の窓は宣言の段で開く（244-250・統括11 の検証 C19）

import { cardsInZone, moveCard, type BoardState, type CardInstance, type Layer, type Seat, type ZoneId } from './board'
import type { CostKind } from './types'

// ───────────────────────────────────────────────────────────────
// 型
// ───────────────────────────────────────────────────────────────

/** カードを使う手順（宣言は ability・event と同じ [1]〜[5]、処理は [6] から） */
export type CardUseKind = 'call' | 'tag' | 'equip' | 'field' | 'battleCard'
/** ターンの進行の段（10-4・10-6・10-7・10-8） */
export type PhaseKind = 'entry' | 'mainPhase' | 'endPhase' | 'handAdjust' | 'turnEnd'

/** 効果で「呼び出す」（D17・R4a-2）。宣言[1]〜[5]を経ない軽い手順（down と同じ形）: [1]窓→[2]場に出す→[3]窓 */
export type SummonKind = 'summon'

export type ProcKind = 'costGen' | 'ability' | 'event' | 'damage' | 'down' | 'simul' | CardUseKind | 'battle' | PhaseKind | SummonKind

/**
 * 窓（11-2 の2枠: AP・NAP）。[3] 同時アクションの AP の機会
 * （NAP が [2] で宣言し AP が [1] で宣言していなかったとき）を 'awaitActiveSimul' として持つ
 * （旧 priority.ts にはこの段が無かった。R2u-2 で旧 priority.ts を消した）。
 */
export type WindowState = 'awaitActive' | 'awaitNonActive' | 'awaitActiveSimul' | 'closed'

export interface ProcWindow {
  state: WindowState
  active: ProcDecl | null
  nonActive: ProcDecl | null
  /** 7-2[3]《コストを発生するとき》はそのプレイヤーだけ */
  only: Seat | null
  /** 10-2-2: フェイズの窓（base）で AP がフェイズ終了を宣言した。NAP が見送る（認める）とフェイズが終わる（R2u） */
  phaseEnd?: boolean
}

/** コストの発生源（7-2[2]）。icon・attrs はエンジンが決めて渡す（core は色・属性の意味を知らない） */
export interface CostSource {
  iid: string
  from: 'field' | 'hand'
  icon: CostKind
  attrs: string[]
}

/** 発生済みのコスト（7-3）。frameId＝種類が有効なアクション（そのフレームが終わると W＝その他のコストになる） */
export interface CostToken {
  id: string
  icon: CostKind
  attrs: string[]
  frameId: string | null
}

/** 宣言された行動（宣言[1]〜[5]はエンジンが済ませて渡す） */
export interface ProcDecl {
  id: string
  by: Seat
  kind: 'ability' | 'event' | 'costGen' | CardUseKind | 'battle'
  actionType: '通常型' | '割込型'
  label: string
  sourceIid: string | null
  targets: string[]
  /** 15-13-1[4]・16-1[4] で宣言したコストを発生させるアクション（[7] で処理する） */
  costGens: CostSource[][]
  /** 7-2[3]（宣言の段）で宣言した行動。[5] で処理する（kind costGen） */
  subDecls?: ProcDecl[]
  /** costGens[i] の 7-2[3] で宣言した行動（[7] で costGen の手順に渡す） */
  cgSubs?: ProcDecl[][]
  /** 17-3[3] 装備対象（kind equip） */
  equipTo?: string | null
  /** 15-10-2[4] 構成要素の2枚（kind tag） */
  components?: string[]
  /** kind costGen のときの発生源 */
  sources: CostSource[]
  /** 割込型: 宣言した窓のフレーム（エンジンが「その特殊能力」「そのダメージ」を指すのに使う） */
  trigger: string | null
  /** 【１ターンにｎ回まで】を数えるキー（`${iid}:${能力名}`）。無ければ数えない */
  usageKey: string | null
  /** エンジンの持ち物（能力の参照・選択の結果・支払いの計画など）。core は読まない */
  eng: Record<string, unknown>
  /** 処理の前に効果が打ち消された（キャンセルマジックが先に処理された等） */
  countered?: boolean
}

export interface DamageSeed {
  value: number
  recipient: string
  dealerIid: string | null
  dealerSeat: Seat | null
  /** バトルの結果ダメージ（20-4[26]）のとき、そのバトルのフレーム */
  battle?: string | null
}

/** バトルの結果ダメージの増減（20-10: 0以下は増減の効果を受けない。evenIfZero はカードの表記が優先 21）。
 *  複数参加（K9）では、同じ席に複数の結果ダメージ（BattleDamageEntry）がありうる。増減はその席の全件に当てる
 *  （PHASE-R4b §2(A)「複数参加で意味が割れる増減は manual」に該当するカードがプールに無いので、まず広報で決めた既定） */
export interface BattleEdit {
  /** ダメージを受ける側の席 */
  seat: Seat
  delta?: number
  set?: number
  evenIfZero?: boolean
}

/** [24] バトルの結果ダメージ1件（組ごと。複数参加 K9 では同じ席に複数件になりうる。FAQ oldfaq.txt:3878-3879） */
export interface BattleDamageEntry {
  /** ダメージを受ける側の席 */
  seat: Seat
  /** 受け手（参加キャラ） */
  recipient: string
  /** 与えた相手（対戦キャラ）。組が無ければ null */
  dealer: string | null
  value: number
}

/** バトル 20-4 の状態（参加キャラは陣営ごとの配列＝複数参加 K9） */
export interface BattleState {
  challenger: Seat
  participants: Record<Seat, string[]>
  /** [7][11]「この時点でバトル参加キャラが決定されていなければ」 */
  decided: Record<Seat, boolean>
  /** [12] 自動でリーダーが参加した（指定ではない 20-8） */
  autoLeader: boolean
  /** 待機状態で参加したキャラ（《エキサイト》など） */
  joinedReady: string[]
  battleCard: string | null
  cardDecided: boolean
  /**
   * [23] 攻撃能力値・防御能力値（参加キャラ・iid ごと。K9・統括16で複数参加に広げた。その席の値が丸ごと null＝人が入れる。
   * 単数参加なら参加キャラ1体ぶんの1エントリ）
   */
  values: Record<Seat, Record<string, { atk: number; def: number; rounds?: { atk: number; def: number }[] }> | null> | null
  /** [24] バトルの結果ダメージ（組ごと。null＝計算していない。K9: 挑んだ側1体×挑まれた側N体なら挑んだ側はN件受ける FAQ:3878-3879） */
  damage: BattleDamageEntry[] | null
  /** [24] より前に使われた結果ダメージの増減（計算の後に当てる。同じ席の全件に当てる＝K9 の広報） */
  pendingEdits: BattleEdit[]
  /** [17]〜 隠し芸などの「各陣営が能力値を1つ選ぶ」の答え（K13・BattleExpr の chosenStat）。席ごとに選んだ能力値の名前（力/早/賢/根/感）。
   *  core はカードの知識を持たないので、値の意味（能力値の名前）は文字列のまま持つ（engine が dsl.ts の Attr として解釈する） */
  battleChoices: Record<Seat, string | null>
  /** 《選り取りバトル》: [攻]／[防]に使う能力値（AP が決める。key 'atk'／'def' の setBattleChoice）。両陣営共通 */
  statPick: { atk: string | null; def: string | null }
  /** 《先手必勝》など: 先にダメージを与える側（key＝効果の宣言） */
  firstStrike: { seat: Seat; key: string }[]
  firstChosen: Seat | null
  /** [26] の進み（0＝前・1＝先に与えた側が済んだ・2＝済んだ） */
  dmgPhase: number
  /** 《出会い頭》: [19]〜[22] を行わない */
  skipActions: boolean
  /** [19][20][22]: この機会に特殊能力を使ったか（1回） */
  abilityUsed: boolean
  /** [19][20][22]: 窓で宣言があった＝同じ段の機会をもう一度開く */
  reopen: boolean
  /** この段より前の窓は開かない（FAQ テストの「バトル中から始める」） */
  startAt: number
  /** バトルの結果でダウンした参加キャラ（20-6 の中断に数えない） */
  resultDowned: string[]
  aborted: string | null
  /** [28] でゴミ箱送りにするバトルカード（《虎の子バトル》） */
  endTrash: string[]
  /** 払ったコストの合計（席ごと。交渉売買 R4b-3a-2。payByPlayer の addToBattlePaid が積む。BattleExpr { paid: true } が読む） */
  paid: Record<Seat, number>
  /** [23] の交渉（交渉売買）を1回済ませたか（二重に積まないため） */
  negotiated: boolean
  /** 結果ダメージの上限（NH-21・交渉売買）。null＝上限なし。pendingEdits・[24]以降の増減にも当てる（FAQ:3921） */
  dmgCap: number | null
  /** 結果ダメージを半分にする（《漫画》FAQ:3985）。null＝しない */
  dmgHalf: 'ceil' | null
}

/** 層を足すときの形（id・seq・battleId は core が決める。battleId は until battle か攻防修正のとき最も近いバトル）。R3 で R2b の ProcMod を置き換えた */
export type LayerSeed = Omit<Layer, 'id' | 'seq' | 'battleId'>

/** 終わったバトルの記録（FAQ テストの battleCard・battleAborted と画面のログ用） */
export interface BattleLog {
  id: string
  challenger: Seat
  battleCard: string | null
  aborted: string | null
  participants: Record<Seat, string[]>
}

/** 同時処理の1項目 */
export interface SimulItem {
  key: string
  label: string
  by: Seat
  sourceIid: string | null
  type: 'effect' | 'action' | 'damage'
  decl?: ProcDecl
  damage?: DamageSeed
  /** effect のときエンジンの持ち物（処理の残り・選択など） */
  eng: Record<string, unknown>
  status: 'pending' | 'running' | 'done' | 'skipped'
}

export interface ProcFrame {
  id: string
  kind: ProcKind
  /** 原典の段番号（simul は 0） */
  step: number
  /**
   * enter＝この段に入る／window＝窓を開いて待つ／engine＝エンジンを待つ／items＝同時処理の次の項目へ／
   * resume＝上に積んだ手順が終わったら再開する／done＝終わった
   */
  status: 'enter' | 'window' | 'engine' | 'items' | 'resume' | 'done'
  /** battleValues＝[23] 攻防の値／place＝呼び出し・タッグ化でフィールドに出すときの気力／choice＝core の選択を待つ */
  engineWhat?: 'timing' | 'pay' | 'check' | 'effect' | 'item' | 'battleValues' | 'place' | 'choice'
  resume?: 'advance' | 'reenter' | 'afterTiming' | 'item'
  /** 7-2[3]: 宣言の段の《コストを発生するとき》（forDecl の宣言の中。cg＝その宣言の costGens の番号、null＝単独のコスト発生） */
  declPhase?: { forDecl: string; cg: number | null }
  /** 17-3: 移し替え（「アイテムの装備と同じ扱い」FAQ:804・2874）＝[11] から */
  transfer?: boolean
  battle?: BattleState
  window: ProcWindow | null
  /** 行動したプレイヤー（damage/down/simul は当事者の使用者か AP） */
  by: Seat
  label: string
  decl?: ProcDecl
  /** ability/event: [6] で再提示できたか */
  represented?: boolean
  /** ability/event: [9] で使用代償を支払えたか */
  paid?: boolean
  /** ability/event: 効果が打ち消された（H-8: 範囲は「その効果」だけ） */
  countered?: boolean
  /** ability/event: 部分的な打ち消し（D23・おあずけ）。'draw'＝ドローの操作（op:'draw'）だけ実行しない。他は今までどおり処理する */
  counterPart?: 'draw'
  cgIndex?: number
  /** costGen: 種類が有効なアクションのフレーム（7-3） */
  bindTo?: string | null
  damage?: {
    value: number
    recipient: string
    dealerIid: string | null
    dealerSeat: Seat | null
    /** 同時に発生したダメージのまとまり（simul フレームの id） */
    group: string | null
    occurred: boolean
    /** 段の途中で受け手が差し替わった＝同じ段をやり直す（FAQ:505-506） */
    rerun: boolean
    /** バトルの結果ダメージ（20-4[26]）ならそのバトル */
    battle?: string | null
    /** 受け手が差し替わる前の受け手（H-13: 対戦キャラ） */
    origRecipient?: string | null
  }
  down?: {
    iid: string
    seat: Seat
    added: boolean
    canceled: boolean
    wasLeader: boolean
    /** 使用代償としてのダウン（受け渡し）。取り消されたら支払っていない（FAQ:2040） */
    costOf: string | null
    /** バトルの結果ダメージでのダウン（《どろぼう》FAQ:129） */
    byBattle?: string | null
    /**
     * 気力が1以上から0以下になった（15-5）のを起こしにしたダウンか（既定 true）。使用代償としてのダウン
     * （costOf）や効果で明示的にダウンさせる（《サクリファイス》）は false。D14（R4a-2）: byLowKiryoku の
     * ダウンだけ、[2] の窓が閉じた後に気力が回復していれば起きない（K10 と同じ考え方。原典に書いていない細部）
     */
    byLowKiryoku?: boolean
  }
  simul?: {
    items: SimulItem[]
    order: number[] | null
    /** 15-5-2: この同時処理の中のダウンの終了判定をまとめて行う */
    collect: boolean
    endCheck: boolean
    /** タイミングの処理として積んだとき、そのフレーム */
    forFrame: string | null
  }
  /** 効果で「呼び出す」（D17・R4a-2。kind summon）。fromZone＝宣言時点（Op 実行時点）でカードがあった場所。
   *  [2] にそこにまだあれば場に出す。動いていれば（他の効果で失われた等）canceled のまま何もしない */
  summon?: { iid: string; seat: Seat; orientation: 'ready' | 'rested'; fromZone: ZoneId; canceled?: boolean }
  aborted?: string
  /** ダメージ[6] で起きたダウン（ダメージの手順が終わってから積む） */
  pendingDowns?: string[]
  /** エンジンの持ち物 */
  eng: Record<string, unknown>
}

export interface ProcChoice {
  id: string
  by: Seat
  kind: 'order' | 'select' | 'use'
  prompt: string
  /** sourceIid・qty は同時処理の順（damage 項目）を画面が区別して出すため（R4b-2c 🔸2: 同じカード名の受け手が2件あると選択肢が同じ文字になる） */
  options: { key: string; label: string; sourceIid?: string | null; qty?: number }[]
  min: number
  max: number
  /** 同じ選択肢を何度も選べる（割り振り） */
  repeat?: boolean
  /** 割り振りの上限（選択肢ごとに選べる回数。《サバイバル》FAQ:4109「気力が０より小さくならないように」） */
  caps?: Record<string, number>
  /** core/engine が出した選択の種類（答えを core が当てる／画面の出し分けにも使う）: battleParticipant・battleCard・battleLoop・firstStrike・entryReady・handDiscard・offer（K5・D8。R2u⑦） */
  purpose?: string
  frameId: string | null
}

export interface GameResult {
  /** null＝引き分け */
  winner: Seat | null
  reason: string
}

export type Phase = 'エントリー' | 'メイン' | '終了' | '手札調整'

export interface ProcMeta {
  seq: number
  /** メインフェイズの窓（手順の外）。null＝開いていない */
  base: ProcWindow | null
  /** メインフェイズの窓で両者が何も宣言しなかった（13-3-1。次のフェイズへ＝R2u） */
  mainClosed: boolean
  choice: ProcChoice | null
  answers: Record<string, string[]>
  /** 【１ターンにｎ回まで】の使用回数 */
  used: Record<string, number>
  /** バトルカード iid → このターンにそのバトルカードで挑んだキャラ（oncePerChar。ターン終了で消える） */
  marks: Record<string, string[]>
  /** ダウン[6] でフィールドから失われたリーダー（[7] で判定する） */
  leaderLost: Seat[]
  /** 立ち消え・中断した宣言の id と理由 */
  aborted: { declId: string; reason: string }[]
  /** 終わったバトル */
  battles: BattleLog[]
  /** このフェイズの段（エントリー・手札調整・ターン終了）を始めたか。null＝まだ */
  phaseRun: string | null
}

/** 処理の記録（FAQ テストの order・fizzled と画面のログ用） */
export interface ProcTrace {
  kind: 'name' | 'abort' | 'manual' | 'warn'
  text: string
  id?: string
}

export interface ProcResult {
  state: BoardState
  log: string
  trace: ProcTrace[]
}

/** 原典のタイミング名（段ごと）。window=false はアクション宣言の機会が無い段（7-2[7]） */
export const STEP_TIMINGS: Record<ProcKind, Record<number, { names: string[]; window: boolean }>> = {
  ability: {
    8: { names: ['特殊能力を使用するとき'], window: true },
    11: { names: ['特殊能力を使用したとき'], window: true },
    13: { names: ['効果が発生したとき'], window: true },
  },
  event: {
    8: { names: ['イベントカードを使用するとき'], window: true },
    11: { names: ['イベントカードを使用したとき'], window: true },
    13: { names: ['効果が発生したとき'], window: true },
  },
  costGen: {
    3: { names: ['コストを発生するとき'], window: true },
    7: { names: ['コストを発生する場合'], window: false },
    8: { names: ['コストが発生したとき'], window: true },
  },
  damage: {
    1: { names: ['ダメージが発生するとき'], window: true },
    3: { names: ['ダメージが発生したとき'], window: true },
    4: { names: ['ダメージを与えるとき', 'ダメージを受けるとき'], window: true },
    5: { names: ['ダメージを与えたとき', 'ダメージを受けたとき'], window: true },
  },
  down: {
    2: { names: ['ダウンするとき'], window: true },
    4: { names: ['ダウンしたとき'], window: true },
  },
  simul: {},
  // 15-10-1（oldrule.txt:698-706）
  call: {
    8: { names: ['キャラクターカードを使用するとき'], window: true },
    11: { names: ['キャラクターカードが呼び出されるとき'], window: true },
    14: { names: ['キャラクターカードが呼び出されたとき'], window: true },
  },
  // 15-10-2（oldrule.txt:731-741）
  tag: {
    8: { names: ['タッグキャラクターカードを使用するとき'], window: true },
    10: { names: ['タッグ化するとき'], window: true },
    14: { names: ['タッグ化したとき'], window: true },
  },
  // 17-3（oldrule.txt:879-889）
  equip: {
    8: { names: ['アイテムカードを使用するとき'], window: true },
    13: { names: ['アイテムカードを装備したとき'], window: true },
  },
  // 18-2（oldrule.txt:948-958）
  field: {
    8: { names: ['フィールドカードを使用するとき'], window: true },
    13: { names: ['フィールドカードを配置したとき'], window: true },
  },
  // 19-2（oldrule.txt:1002-1011）
  battleCard: {
    8: { names: ['バトルカードを使用するとき'], window: true },
    12: { names: ['バトルカードを配置したとき'], window: true },
  },
  // 20-4（oldrule.txt:1062-1127）。[19][20][22] は名前の無い機会（特殊能力1回・イベント複数回）。[28] は処理だけ（窓は無い）
  battle: {
    4: { names: ['バトルを挑まれたとき'], window: true },
    6: { names: ['バトルに参加するとき', 'バトルを挑むとき', 'バトルを挑むキャラを選ぶとき'], window: true },
    8: { names: ['バトルに参加したとき', 'バトルを挑んだとき', 'バトルを挑むキャラを選んだとき'], window: true },
    10: { names: ['バトルに参加するとき', 'バトルを受けるとき', 'バトルを受けるキャラを選ぶとき'], window: true },
    13: { names: ['バトルに参加したとき', 'バトルを受けたとき', 'バトルを受けるキャラを選んだとき'], window: true },
    15: { names: ['バトルカードを選択するとき'], window: true },
    17: { names: ['バトルカードを選択したとき', 'バトルを選択したとき'], window: true },
    19: { names: [], window: true },
    20: { names: [], window: true },
    22: { names: [], window: true },
    25: { names: ['バトルの結果の計算をしたとき'], window: true },
    27: { names: ['バトルの結果を出したとき'], window: true },
    28: { names: ['バトル終了時'], window: false },
    29: { names: ['バトル終了後', 'バトルが終了したとき'], window: true },
  },
  // 10-4（oldrule.txt:384-389）
  entry: {
    1: { names: ['エントリー開始時'], window: true },
    5: { names: ['エントリー終了時'], window: true },
  },
  // 10-5（oldrule.txt:391-394）。[2] はフレームを降ろしてフェイズの窓（procMeta.base・10-5-1）を開く（10-6 と同じ形。R2u-2）
  mainPhase: {
    1: { names: ['メインフェイズ開始時'], window: true },
    3: { names: ['メインフェイズ終了時'], window: true },
  },
  // 10-6（oldrule.txt:417-421）。[2] はフレームを降ろしてフェイズの窓（procMeta.base・メインと同じ手順の外の窓 10-6-1）を開く
  endPhase: {
    1: { names: ['終了フェイズ開始時'], window: true },
    3: { names: ['終了フェイズ終了時'], window: true },
  },
  // 10-7（oldrule.txt:430-435）
  handAdjust: {
    1: { names: ['手札調整フェイズ開始時'], window: true },
    2: { names: ['手札調整時'], window: true },
    4: { names: ['手札調整フェイズ終了時'], window: true },
  },
  // 10-8（oldrule.txt:436-441）: 処理だけ（アクション宣言の機会は書かれていない）
  turnEnd: {
    1: { names: ['ターン終了時'], window: false },
  },
  // 効果で「呼び出す」（D17・R4a-2）。宣言を経ない軽い手順（15-10-1[11]・[14] に揃える）
  summon: {
    1: { names: ['キャラクターカードが呼び出されるとき'], window: true },
    3: { names: ['キャラクターカードが呼び出されたとき'], window: true }, // NH-18
  },
}

const LAST_STEP: Record<ProcKind, number> = {
  ability: 14,
  event: 14,
  costGen: 9,
  damage: 6,
  down: 7,
  simul: 0,
  call: 14,
  tag: 14,
  equip: 13,
  field: 13,
  battleCard: 12,
  battle: 29,
  entry: 5,
  mainPhase: 3,
  endPhase: 3,
  handAdjust: 4,
  turnEnd: 2,
  summon: 3,
}

/** 手札の上限枚数（4-2-1 oldrule.txt:169-170） */
const HAND_LIMIT = 7

/** procMeta.phaseRun: 終了フェイズの [2]（アクションを行う段・10-6-1）に入った。drive がフェイズの窓を開く */
export const PHASE_ACTIONS = '終了[2]'
/**
 * procMeta.phaseRun: メインフェイズの [2]（アクションを行う段・10-5-1）に入った。drive がフェイズの窓を開く（R2u-2）。
 * ターンの番号（turn.n）が無い盤面（FAQ テスト・R2a/R2b の盤面）は [1][3] を行わず、今までどおりメインの窓から
 */
export const MAIN_ACTIONS = 'メイン[2]'

const CARD_USE: ProcKind[] = ['call', 'tag', 'equip', 'field', 'battleCard']
export function isCardUse(kind: ProcKind): kind is CardUseKind {
  return CARD_USE.includes(kind)
}
/** 宣言して行う行動の手順（提示・支払い・[13] で名前を記録するもの） */
function isActionKind(kind: ProcKind): boolean {
  return kind === 'ability' || kind === 'event' || isCardUse(kind)
}

// ───────────────────────────────────────────────────────────────
// 小道具
// ───────────────────────────────────────────────────────────────

export function otherSeat(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

export function activeSeat(state: BoardState): Seat {
  return state.turn?.active ?? 'A'
}

export function topFrame(state: BoardState): ProcFrame | undefined {
  return state.proc[state.proc.length - 1]
}

export function findFrame(state: BoardState, id: string): ProcFrame | undefined {
  return state.proc.find((f) => f.id === id)
}

function nextId(state: BoardState, prefix: string): [BoardState, string] {
  const seq = state.procMeta.seq + 1
  return [{ ...state, procMeta: { ...state.procMeta, seq } }, `${prefix}${seq}`]
}

function setFrame(state: BoardState, frame: ProcFrame): BoardState {
  return { ...state, proc: state.proc.map((f) => (f.id === frame.id ? frame : f)) }
}

function setMeta(state: BoardState, patch: Partial<ProcMeta>): BoardState {
  return { ...state, procMeta: { ...state.procMeta, ...patch } }
}

function onField(c: CardInstance | undefined): c is CardInstance {
  return !!c && (c.zone === 'char' || c.zone === 'leader') && c.attachedTo === null
}

/** 今どの窓が開いているか（上のフレームの窓か、メインフェイズの窓） */
export function currentWindow(state: BoardState): { frame: ProcFrame | null; window: ProcWindow } | null {
  const top = topFrame(state)
  if (top) return top.status === 'window' && top.window ? { frame: top, window: top.window } : null
  return state.procMeta.base && state.procMeta.base.state !== 'closed' ? { frame: null, window: state.procMeta.base } : null
}

/** 窓で今「宣言かパス」を返す番の席 */
export function awaitingSeat(state: BoardState): Seat | null {
  const w = currentWindow(state)
  if (!w) return null
  const ap = activeSeat(state)
  switch (w.window.state) {
    case 'awaitActive':
    case 'awaitActiveSimul':
      return ap
    case 'awaitNonActive':
      return otherSeat(ap)
    default:
      return null
  }
}

// ───────────────────────────────────────────────────────────────
// 盤面の操作（手順の中から使う）
// ───────────────────────────────────────────────────────────────

/** カードを動かす。場を離れるキャラ・ゴミ箱送りになったバトルカードに付いていたアイテムはゴミ箱へ（FAQ:3992・野球拳）。
 *  リーダーが場を離れたら即座に負け（9-1）。
 *  🚨 ダウン[6]のゴミ箱送りだけは [7] で判定する（15-5-2 の同時ダウン＝引き分けの判定をまとめるため）ので leaderNow=false で呼ぶ */
function moveTo(
  state: BoardState,
  iid: string,
  to: ZoneId,
  opts: { index?: 'top' | 'bottom'; orientation?: 'ready' | 'rested'; leaderNow?: boolean } = {},
): BoardState {
  const card = state.cards[iid]
  if (!card) return state
  const wasLeader = card.zone === 'leader'
  const leavingField = (card.zone === 'char' || card.zone === 'leader') && to !== 'char' && to !== 'leader'
  const leavingBattleZone = card.zone === 'battle' && to !== 'battle'
  let next = state
  if (leavingField || leavingBattleZone) {
    for (const item of Object.values(next.cards)) {
      if (item.attachedTo === iid) {
        next = moveCard(next, { iid: item.iid, toZone: 'trash', cardName: item.cardId }).state
        next = { ...next, cards: { ...next.cards, [item.iid]: { ...next.cards[item.iid], attachedTo: null } } }
      }
    }
  }
  // デッキの一番上＝index 0（-1 にしてから詰め直すと必ず先頭になる）
  next = moveCard(next, { iid, toOwner: card.owner, toZone: to, toIndex: to === 'deck' && opts.index === 'top' ? -1 : undefined, cardName: card.cardId }).state
  const moved = next.cards[iid]
  if (moved) {
    const orientation = opts.orientation ?? (to === 'char' || to === 'leader' ? moved.orientation : 'ready')
    next = { ...next, cards: { ...next.cards, [iid]: { ...moved, orientation, attachedTo: null } } }
  }
  if (wasLeader && leavingField && (opts.leaderNow ?? true)) {
    next = endGame(next, [card.owner], 'リーダーがフィールドから失われた（9-1）')
  }
  return next
}

function drawCard(state: BoardState, seat: Seat): BoardState {
  const top = cardsInZone(state, seat, 'deck')[0]
  if (!top) return endGame(state, [seat], 'デッキからドローできない（9-3）')
  return moveTo(state, top.iid, 'hand')
}

function endGame(state: BoardState, losers: Seat[], reason: string): BoardState {
  if (state.result) return state
  const uniq = [...new Set(losers)]
  if (uniq.length === 0) return state
  const winner = uniq.length === 2 ? null : otherSeat(uniq[0])
  return { ...state, result: { winner, reason: uniq.length === 2 ? `${reason}（同時に両者＝引き分け）` : reason } }
}

/** 9: 終了条件の判定（ダウン数は確定済みの分だけ＝H-12） */
function checkEnd(state: BoardState, reason: string): BoardState {
  const losers: Seat[] = []
  for (const seat of ['A', 'B'] as Seat[]) {
    if (state.downs[seat] >= 5 || state.procMeta.leaderLost.includes(seat)) losers.push(seat)
  }
  return endGame(state, losers, reason)
}

/** 気力を変える（ダメージの[6]・気力－N・回復）。1以上から0以下になったらダウンを積む（15-5） */
function changeKiryoku(state: BoardState, iid: string, next: number, costOf: string | null = null): BoardState {
  const card = state.cards[iid]
  if (!card || card.kiryoku === null) return state
  const before = card.kiryoku
  let s: BoardState = { ...state, cards: { ...state.cards, [iid]: { ...card, kiryoku: next } } }
  if (before >= 1 && next <= 0 && onField(card)) s = pushDown(s, iid, costOf)
  return s
}

function pushDown(state: BoardState, iid: string, costOf: string | null, byBattle: string | null = null, byLowKiryoku = true): BoardState {
  const card = state.cards[iid]
  if (!card) return state
  const [s, id] = nextId(state, 'down')
  const frame: ProcFrame = {
    id,
    kind: 'down',
    step: 1,
    status: 'enter',
    window: null,
    by: card.owner,
    label: `ダウン:${card.cardId}`,
    down: { iid, seat: card.owner, added: false, canceled: false, wasLeader: card.zone === 'leader', costOf, byBattle, byLowKiryoku },
    eng: {},
  }
  return { ...s, proc: [...s.proc, frame] }
}

function newBattle(challenger: Seat, extra: Partial<BattleState> = {}): BattleState {
  return {
    challenger,
    participants: { A: [], B: [] },
    decided: { A: false, B: false },
    autoLeader: false,
    joinedReady: [],
    battleCard: null,
    cardDecided: false,
    values: null,
    damage: null,
    pendingEdits: [],
    battleChoices: { A: null, B: null },
    statPick: { atk: null, def: null },
    firstStrike: [],
    firstChosen: null,
    dmgPhase: 0,
    skipActions: false,
    abilityUsed: false,
    reopen: false,
    startAt: 0,
    resultDowned: [],
    aborted: null,
    endTrash: [],
    paid: { A: 0, B: 0 },
    negotiated: false,
    dmgCap: null,
    dmgHalf: null,
    ...extra,
  }
}

/** バトルの宣言（20-4[1]）の形。宣言でなく効果で始まるバトル（《抜き打ち》）もこの形で持つ */
/** 20-4[7] バトルを挑むキャラの候補（待機状態。効果で「バトルを挑むことができない／参加することができない」キャラを除く）。drive.ts の宣言の判定も同じ一か所を通す */
export function challengeCandidates(state: BoardState, seat: Seat): CardInstance[] {
  return fieldChars(state, seat).filter((x) => x.orientation === 'ready' && !state.layers.barChallenge.includes(x.iid) && !state.layers.barAny.includes(x.iid))
}

export function battleDecl(id: string, challenger: Seat): ProcDecl {
  return {
    id,
    by: challenger,
    kind: 'battle',
    actionType: '通常型',
    label: `バトル（${challenger} が挑んだ）`,
    sourceIid: null,
    targets: [],
    costGens: [],
    sources: [],
    trigger: null,
    usageKey: null,
    eng: {},
  }
}

/**
 * バトル中から始める（FAQ テストの setup.battle・画面の手動）。参加キャラ・バトルカードは決まっているものとして、
 * [at] より前の段は窓を開かずに通る（[18] の使用済み・[23][24] の値の計算は行う）。
 */
export function startBattleAt(
  state: BoardState,
  opts: { challenger: Seat; at: number; participants?: Partial<Record<Seat, string[]>>; battleCard?: string | null },
): BoardState {
  const [s, id] = nextId(state, 'battle')
  const participants: Record<Seat, string[]> = { A: opts.participants?.A ?? [], B: opts.participants?.B ?? [] }
  const battle = newBattle(opts.challenger, {
    participants,
    decided: { A: participants.A.length > 0, B: participants.B.length > 0 },
    battleCard: opts.battleCard ?? null,
    cardDecided: !!opts.battleCard,
    startAt: opts.at,
  })
  const step = Math.min(opts.at, 15)
  const frame: ProcFrame = { id, kind: 'battle', step, status: 'enter', window: null, by: opts.challenger, label: `バトル（${opts.challenger} が挑んだ）`, decl: battleDecl(id, opts.challenger), battle, eng: {} }
  return { ...s, proc: [...s.proc, frame] }
}

function pushFrame(state: BoardState, frame: Omit<ProcFrame, 'id'>, prefix: string): [BoardState, string] {
  const [s, id] = nextId(state, prefix)
  return [{ ...s, proc: [...s.proc, { ...frame, id }] }, id]
}

/** 宣言された行動の手順は、宣言の id をそのままフレームの id にする（打ち消し・立ち消えの記録が宣言を指せるように） */
function pushDeclFrame(state: BoardState, decl: ProcDecl, patch: Partial<ProcFrame> = {}): BoardState {
  return { ...state, proc: [...state.proc, { ...declFrame(decl), ...patch, id: decl.id }] }
}

function declFrame(decl: ProcDecl): Omit<ProcFrame, 'id'> {
  if (decl.kind === 'costGen') {
    // 7-2: 宣言[1]〜[3] は宣言の段で済んでいる（[3] の窓も宣言の段 C19 の直し）。処理は [4] から
    return { kind: 'costGen', step: 4, status: 'enter', window: null, by: decl.by, label: decl.label, decl, bindTo: null, eng: {} }
  }
  if (decl.kind === 'battle') {
    // 20-4: [1][2] は宣言の窓。[3]「手順[2]で宣言した同時アクションの処理」は同じ同時処理の中でバトルより先に行う（rankAction）
    return { kind: 'battle', step: 3, status: 'enter', window: null, by: decl.by, label: decl.label, decl, battle: newBattle(decl.by), eng: {} }
  }
  return { kind: decl.kind, step: 6, status: 'enter', window: null, by: decl.by, label: decl.label, decl, cgIndex: 0, countered: decl.countered, eng: {} }
}

/** 最も近い「アクション」のフレーム（コストの種類を結びつける 7-3） */
function nearestActionFrame(state: BoardState): string | null {
  for (let i = state.proc.length - 1; i >= 0; i--) {
    const f = state.proc[i]
    if (isActionKind(f.kind)) return f.id
  }
  return null
}

/** 最も近いバトルのフレーム（下から数えて上にあるもの） */
export function nearestBattle(state: BoardState): ProcFrame | undefined {
  for (let i = state.proc.length - 1; i >= 0; i--) if (state.proc[i].kind === 'battle' && state.proc[i].status !== 'done') return state.proc[i]
  return undefined
}

/** 20-5「バトル中」＝手順[4]〜[28] */
export function inBattle(state: BoardState): boolean {
  const b = nearestBattle(state)
  return !!b && b.step >= 4 && b.step <= 28
}

/** 15-5-2: このダウンの[7]をまとめて行う同時処理（最も近い同時処理が複数項目なら、そこでまとめる） */
function collectingSimul(state: BoardState, below: number): ProcFrame | undefined {
  for (let i = below - 1; i >= 0; i--) {
    const f = state.proc[i]
    if (f.kind === 'simul') return f.simul?.collect ? f : undefined
  }
  return undefined
}

function openWindow(only: Seat | null, ap: Seat): ProcWindow {
  return { state: only && only !== ap ? 'awaitNonActive' : 'awaitActive', active: null, nonActive: null, only }
}

// ───────────────────────────────────────────────────────────────
// 段を進める
// ───────────────────────────────────────────────────────────────

/** 止まる点まで手順を進める */
export function run(state: BoardState, trace: ProcTrace[]): BoardState {
  let s = state
  for (let guard = 0; guard < 2000; guard++) {
    if (s.result || s.procMeta.choice) return s
    const top = topFrame(s)
    if (!top) return s
    switch (top.status) {
      case 'window':
      case 'engine':
        return s
      case 'enter':
        s = enterStep(s, top, trace)
        break
      case 'items':
        s = nextItem(s, top, trace)
        if (topFrame(s) === top && s.procMeta.choice === null && top.status === 'items') return s
        break
      case 'resume':
        s = resumeFrame(s, top)
        break
      case 'done':
        s = popFrame(s, top, trace)
        break
    }
  }
  trace.push({ kind: 'warn', text: '手順が2000段を超えた（無限ループの疑い・13-3-2）' })
  return s
}

function advance(frame: ProcFrame): ProcFrame {
  // 7-2[3] 宣言の段の窓だけのフレーム
  if (frame.declPhase) return { ...frame, status: 'done' }
  // 20-6-1: 中断したら [28] は行うが [29] は行わない
  if (frame.kind === 'battle' && frame.step >= 28 && frame.battle?.aborted) return { ...frame, status: 'done' }
  if (frame.step >= LAST_STEP[frame.kind]) return { ...frame, status: 'done' }
  const step = frame.step + 1
  // 20-4[19][20][22]: 新しい機会では特殊能力の1回を数え直す
  const battle = frame.battle && [19, 20, 22].includes(step) ? { ...frame.battle, abilityUsed: false, reopen: false } : frame.battle
  return { ...frame, step, status: 'enter', battle }
}

/**
 * 20-6: [19]〜[28] の間に参加キャラが失われたら中断（バトルの結果でダウンした場合を除く）。
 * NH-8（決定 2026-09-27・holes.ts・既定 continue）: 複数参加（K9）で参加キャラが1体だけ失われても中断しない。
 * 残りの参加キャラで続け、失われたキャラとの組は計算しない（[23]〜[26] は onField なものだけで組む）。
 * その陣営の参加キャラが（resultDowned を除いて）1体も残っていなければ中断する
 */
function battleLost(state: BoardState, b: BattleState): string | null {
  for (const seat of ['A', 'B'] as Seat[]) {
    const remaining = b.participants[seat].filter((iid) => !b.resultDowned.includes(iid))
    if (remaining.length > 0 && remaining.every((iid) => !onField(state.cards[iid]))) {
      return 'バトル参加キャラが失われた（20-6・NH-8: その陣営の参加キャラが全員失われた）'
    }
  }
  return null
}

function abortBattle(state: BoardState, frame: ProcFrame, reason: string, trace: ProcTrace[]): BoardState {
  trace.push({ kind: 'abort', text: `バトル中断: ${reason}`, id: frame.decl?.id })
  return setFrame(state, { ...frame, step: 28, status: 'enter', window: null, battle: { ...frame.battle!, aborted: reason } })
}

function enterStep(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const ap = activeSeat(state)
  if (frame.aborted) return setFrame(state, { ...frame, status: 'done' })
  // D14（R4a-2）: 明示の cancelDown だけでなく、《ダウンするとき》[2] の窓が閉じた後に気力が回復していれば
  // （関西魂・幸せ泥棒 FAQ:2836 のように、ダウンではなく「気力を回復させる効果」を乗っ取って回復させた場合）
  // ダウンは起きない（K10 と同じ考え方：条件を保っているかを処理の入り口で確かめ直す）
  if (frame.kind === 'down' && (frame.down?.canceled || (frame.down?.byLowKiryoku && frame.step > 2 && (state.cards[frame.down!.iid]?.kiryoku ?? 0) > 0))) {
    return setFrame(state, { ...frame, status: 'done' })
  }
  if (frame.kind === 'battle') {
    const b = frame.battle!
    if (b.aborted && frame.step < 28) return setFrame(state, { ...frame, step: 28 })
    // 20-6（[19]〜[28]。[26] の中はバトルの結果のダウン）
    if (!b.aborted && frame.step >= 19 && frame.step <= 28 && !(frame.step === 26 && b.dmgPhase > 0)) {
      const lost = battleLost(state, b)
      if (lost) return abortBattle(state, frame, lost, trace)
    }
    // 《出会い頭》: バトルカードを選択した後、[19]〜[22] の機会を得ずに結果を出す（FAQ:1375）
    if (b.skipActions && frame.step >= 19 && frame.step <= 22) return setFrame(state, advance(frame))
    if (frame.step === 28) state = battleEndCleanup(state, frame, trace)
    // バトル中から始めたとき: [startAt] より前の窓は開かない（段の処理は行う）
    if (frame.step < b.startAt && STEP_TIMINGS.battle[frame.step]?.window) return setFrame(state, advance(frame))
  }
  const timing = STEP_TIMINGS[frame.kind][frame.step]
  if (timing) {
    if (frame.kind === 'ability' || frame.kind === 'event') {
      if (frame.step === 13) {
        if (frame.countered) {
          trace.push({ kind: 'name', text: `打ち消し:${frame.label}` })
          return setFrame(state, { ...frame, status: 'done' })
        }
        trace.push({ kind: 'name', text: frame.label, id: frame.decl?.id })
      }
    }
    if (frame.kind === 'damage' && (frame.damage!.value <= 0 || !onField(state.cards[frame.damage!.recipient]))) {
      // 15-4-2: 0以下のダメージは発生したとは見なされない（段の途中で0以下になったら以後の段は無い）
      return setFrame(state, { ...frame, step: 6, status: 'enter' })
    }
    if (!timing.window) return setFrame(state, { ...frame, status: 'engine', engineWhat: 'timing', window: null })
    const only = frame.kind === 'costGen' ? frame.by : null
    return setFrame(state, { ...frame, status: 'window', window: openWindow(only, ap) })
  }

  switch (frame.kind) {
    case 'ability':
    case 'event':
      return enterAction(state, frame, trace)
    case 'costGen':
      return enterCostGen(state, frame, trace)
    case 'damage':
      return enterDamage(state, frame, trace)
    case 'down':
      return enterDown(state, frame, trace)
    case 'summon':
      return enterSummon(state, frame, trace)
    case 'simul':
      return setFrame(state, { ...frame, status: 'items' })
    case 'call':
    case 'tag':
    case 'equip':
    case 'field':
    case 'battleCard':
      return enterCardUse(state, frame, trace)
    case 'battle':
      return enterBattle(state, frame, trace)
    case 'entry':
    case 'mainPhase':
    case 'endPhase':
    case 'handAdjust':
    case 'turnEnd':
      return enterPhase(state, frame, trace)
  }
}

/** core の選択を出して待つ（答えは applyCoreChoice が当てる） */
function coreChoice(state: BoardState, frame: ProcFrame, choice: Omit<ProcChoice, 'id' | 'frameId'>): BoardState {
  const [s, id] = nextId(state, 'ch')
  return setMeta(setFrame(s, { ...frame, status: 'engine', engineWhat: 'choice' }), { choice: { ...choice, id, frameId: frame.id } })
}

function fieldChars(state: BoardState, seat: Seat): CardInstance[] {
  return Object.values(state.cards)
    .filter((c) => onField(c) && c.owner === seat)
    .sort((a, b) => (a.zone === b.zone ? a.index - b.index : a.zone === 'leader' ? -1 : 1))
}

// ── カードを使う手順（15-10-1・15-10-2・17-3・18-2・19-2）の処理 [6]〜
function enterCardUse(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const decl = frame.decl!
  const iid = decl.sourceIid!
  const k = frame.kind
  const trashCard = (s: BoardState, reason: string) => {
    // 「処理が中断する場合、手順[3]で提示した…カードをゴミ箱送りにする」
    const c = s.cards[iid]
    if (c && c.zone === 'pending') s = moveTo(s, iid, 'trash')
    return abortFrame(s, findFrame(s, frame.id)!, reason, trace)
  }
  const tagComponentsOk = (s: BoardState) =>
    (decl.components ?? []).length === 2 &&
    (decl.components ?? []).every((x) => {
      const c = s.cards[x]
      return !!c && c.owner === decl.by && ((c.zone === 'hand' && c.attachedTo === null) || onField(c))
    })
  switch (frame.step) {
    case 6: {
      // [6] 再提示（提示したカードが提示エリアにある）
      const represented = state.cards[iid]?.zone === 'pending'
      return setFrame(state, { ...advance(frame), represented })
    }
    case 7: {
      if (k === 'tag') {
        // 15-10-2[7] 構成要素の2枚を再提示する
        return setFrame(state, { ...advance(frame), represented: !!frame.represented && tagComponentsOk(state) })
      }
      // [7] [4]で宣言したコストを発生させるアクションの処理
      const i = frame.cgIndex ?? 0
      if (i < decl.costGens.length) {
        const cg: ProcDecl = { ...decl, id: `${decl.id}.cg${i}`, kind: 'costGen', label: 'コスト発生', sources: decl.costGens[i], subDecls: decl.cgSubs?.[i] ?? [], costGens: [], eng: {} }
        const s1 = setFrame(state, { ...frame, cgIndex: i + 1, status: 'resume', resume: 'reenter' })
        return pushDeclFrame(s1, cg, { step: 4, bindTo: frame.id })
      }
      return setFrame(state, advance(frame))
    }
    case 9:
      if (k === 'tag') return frame.represented && tagComponentsOk(state) ? setFrame(state, advance(frame)) : trashCard(state, '構成要素が満たされていない')
      return setFrame(state, { ...frame, status: 'engine', engineWhat: 'pay' })
    case 10:
      if (k === 'tag') return setFrame(state, advance(frame)) // 窓（STEP_TIMINGS）
      if (!frame.represented) return trashCard(state, '再提示できない')
      if (frame.paid === false) return trashCard(state, '使用代償を支払えない')
      if (k === 'equip' && !onField(state.cards[decl.equipTo ?? ''])) return trashCard(state, '装備対象が失われている')
      return setFrame(state, advance(frame))
    case 11:
      if (k === 'tag') return tagComponentsOk(state) && state.cards[iid]?.zone === 'pending' ? setFrame(state, advance(frame)) : trashCard(state, '構成要素が満たされていない')
      if (k === 'equip') {
        // [11] 装備対象に装備される
        const target = decl.equipTo!
        if (!onField(state.cards[target])) return frame.transfer ? abortFrame(state, frame, '移し替え先が失われている', trace) : trashCard(state, '装備対象が失われている')
        const c = state.cards[iid]
        let s = moveCard(state, { iid, toOwner: c.owner, toZone: 'char', toIndex: 100, cardName: c.cardId }).state
        s = { ...s, cards: { ...s.cards, [iid]: { ...s.cards[iid], attachedTo: target, kiryoku: null } } }
        trace.push({ kind: 'name', text: `装備:${c.cardId}→${target}`, id: decl.id })
        return setFrame(s, advance(frame))
      }
      if (k === 'field') {
        // [11] フィールド上にフィールドカードがある場合はそれをゴミ箱送りにする
        let s = state
        for (const c of Object.values(s.cards)) if (c.zone === 'field') s = moveTo(s, c.iid, 'trash')
        return setFrame(s, advance(frame))
      }
      if (k === 'battleCard') {
        // [11] バトルカードがフィールドに配置される（未使用状態）
        const c = state.cards[iid]
        let s = moveCard(state, { iid, toOwner: decl.by, toZone: 'battle', cardName: c.cardId }).state
        s = { ...s, cards: { ...s.cards, [iid]: { ...s.cards[iid], used: false, orientation: 'ready' } } }
        trace.push({ kind: 'name', text: `配置:${c.cardId}`, id: decl.id })
        return setFrame(s, advance(frame))
      }
      return setFrame(state, advance(frame)) // call: 窓
    case 12: {
      if (k === 'call') return state.cards[iid]?.zone === 'pending' ? setFrame(state, advance(frame)) : trashCard(state, '再提示できない')
      if (k === 'tag') {
        // [12] 構成要素の2枚をゴミ箱へ。フィールドの構成要素が装備していたアイテムはタッグが引き継ぐ（15-10-2 oldrule.txt:715）
        let s = state
        const componentKiryoku: Record<string, number | null> = {}
        for (const x of decl.components ?? []) {
          if (onField(s.cards[x])) componentKiryoku[x] = s.cards[x].kiryoku
          for (const item of Object.values(s.cards)) if (item.attachedTo === x) s = { ...s, cards: { ...s.cards, [item.iid]: { ...item, attachedTo: iid } } }
          s = moveTo(s, x, 'trash')
        }
        return setFrame(s, { ...advance(frame), eng: { ...frame.eng, componentKiryoku } })
      }
      if (k === 'equip') {
        // [12] 装備制限（17-2 同名制限）を満たせなければゴミ箱送り。装備対象制限は K4（R3）
        const c = state.cards[iid]
        const same = Object.values(state.cards).some((x) => x.iid !== iid && x.attachedTo === c.attachedTo && x.cardId === c.cardId)
        if (same) {
          trace.push({ kind: 'name', text: `装備制限:${c.cardId}` })
          const s = { ...state, cards: { ...state.cards, [iid]: { ...c, attachedTo: null } } }
          return setFrame(moveTo(s, iid, 'trash'), { ...frame, status: 'done' })
        }
        return setFrame(state, advance(frame))
      }
      if (k === 'field') {
        // [12] フィールドカードが配置される
        const c = state.cards[iid]
        const s = moveCard(state, { iid, toOwner: decl.by, toZone: 'field', cardName: c.cardId }).state
        trace.push({ kind: 'name', text: `配置:${c.cardId}`, id: decl.id })
        return setFrame(s, advance(frame))
      }
      return setFrame(state, advance(frame))
    }
    case 13:
      if (k === 'call' || k === 'tag') return setFrame(state, { ...frame, status: 'engine', engineWhat: 'place' })
      return setFrame(state, advance(frame))
    default:
      return setFrame(state, advance(frame))
  }
}

/** 15-10-1[13]・15-10-2[13] フィールドに出す（気力はエンジンが決める: 呼び出しは印刷値、タッグはダメージを引き継ぐ）。
 *  kind summon（D17・効果で呼び出す）も同じ手順を流用する: fromZone に残っているかを確かめ、frame.summon の向きで出す */
function placeChar(state: BoardState, frame: ProcFrame, kiryoku: number | null, trace: ProcTrace[]): BoardState {
  const isSummon = frame.kind === 'summon'
  const iid = isSummon ? frame.summon!.iid : frame.decl!.sourceIid!
  const by = isSummon ? frame.summon!.seat : frame.decl!.by
  const fromZone = isSummon ? frame.summon!.fromZone : 'pending'
  const c = state.cards[iid]
  if (!c || c.zone !== fromZone) {
    if (isSummon) return setFrame(state, { ...frame, summon: { ...frame.summon!, canceled: true }, status: 'done' })
    return abortFrame(state, frame, '再提示できない', trace)
  }
  let s = moveCard(state, { iid, toOwner: by, toZone: 'char', cardName: c.cardId }).state
  // 呼び出しは消耗状態で、タッグ化は待機状態で出す。summon は frame.summon.orientation の指定どおり（D18「待機状態で」等）
  const orientation = isSummon ? frame.summon!.orientation : frame.kind === 'call' ? 'rested' : 'ready'
  s = { ...s, cards: { ...s.cards, [iid]: { ...s.cards[iid], orientation, kiryoku: kiryoku ?? s.cards[iid].kiryoku, attachedTo: null } } }
  trace.push({ kind: 'name', text: frame.label, id: frame.decl?.id })
  // 【決めたこと】気力0以下で出たキャラはその瞬間にダウンする（FAQ:3266「タッグ化した瞬間に、ダウンした」）
  if ((s.cards[iid].kiryoku ?? 1) <= 0) s = pushDown(setFrame(s, advance(frame)), iid, null)
  else s = setFrame(s, advance(frame))
  return s
}

// ── バトル（20-4）
function enterBattle(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const b = frame.battle!
  const c = b.challenger
  const d = otherSeat(c)
  switch (frame.step) {
    case 3:
      trace.push({ kind: 'name', text: frame.label, id: frame.decl?.id })
      return setFrame(state, advance(frame))
    case 5: {
      // [5] バトルを行うための条件（20-3）: 選択可能なバトルカードが1枚以上・自分のフィールドに待機状態のキャラが1体以上
      // 使用できないバトルカード（効果による・R3）は「選択可能な」に入れない
      const card = Object.values(state.cards).some((x) => x.zone === 'battle' && !x.used && !state.layers.unusable.includes(x.iid))
      const ready = challengeCandidates(state, c).length > 0
      if (!card) return abortBattle(state, frame, '選択可能なバトルカードが無い（20-3・20-4[5]）', trace)
      if (!ready) return abortBattle(state, frame, '待機状態のキャラがいない（20-3・20-4[5]）', trace)
      return setFrame(state, advance(frame))
    }
    case 7: {
      if (b.decided[c]) return setFrame(state, advance(frame))
      // 20-7: 待機状態のキャラから1体
      const opts = challengeCandidates(state, c)
      if (opts.length === 0) return abortBattle(state, frame, 'バトル参加キャラを指定できない（20-4[7]）', trace)
      return coreChoice(state, frame, { by: c, kind: 'select', purpose: 'battleParticipant', prompt: 'バトルを挑むキャラ（20-4[7]）', options: opts.map((x) => ({ key: x.iid, label: x.cardId })), min: 1, max: 1 })
    }
    case 9:
      if (!b.participants[c].some((x) => onField(state.cards[x]))) return abortBattle(state, frame, 'バトル参加キャラがいない（20-4[9]）', trace)
      return setFrame(state, advance(frame))
    case 11: {
      if (b.decided[d]) return setFrame(state, advance(frame))
      // 20-8: 待機状態のキャラか、リーダー（消耗状態でもよい）
      const chars = fieldChars(state, d)
      // 効果で「バトルに参加することができない」キャラは候補から外す。候補が0なら[12]で自動的にリーダーが参加する（FAQ:1165）
      // 効果で「消耗状態でもバトルを受けることができる」キャラ（《坂神蝉丸》守る者）は消耗状態でも候補に足す（待機状態の他のキャラ・リーダーは今どおり選べる）。
      // 選ばれたら[11]の「その後、そのキャラを消耗させる」は消耗済みなので変化なし
      const opts = [...chars.filter((x) => x.zone !== 'leader' && (x.orientation === 'ready' || state.layers.receiveRested.includes(x.iid))), ...chars.filter((x) => x.zone === 'leader')].filter((x) => !state.layers.barAny.includes(x.iid))
      if (opts.length === 0) return setFrame(state, advance(frame))
      return coreChoice(state, frame, { by: d, kind: 'select', purpose: 'battleParticipant', prompt: 'バトルを受けるキャラ（20-4[11]）', options: opts.map((x) => ({ key: x.iid, label: x.cardId })), min: 1, max: 1 })
    }
    case 12: {
      if (b.participants[d].length > 0) return setFrame(state, advance(frame))
      // [12] 自動的にリーダーが参加（指定ではない 20-8）。待機状態なら消耗させる
      const leader = fieldChars(state, d).find((x) => x.zone === 'leader')
      if (!leader) return setFrame(state, advance(frame))
      trace.push({ kind: 'name', text: `自動でリーダーが参加:${leader.iid}` })
      const s = { ...state, cards: { ...state.cards, [leader.iid]: { ...leader, orientation: 'rested' as const } } }
      return setFrame(s, { ...advance(frame), battle: { ...b, participants: { ...b.participants, [d]: [leader.iid] }, decided: { ...b.decided, [d]: true }, autoLeader: true } })
    }
    case 14:
      if (!b.participants[d].some((x) => onField(state.cards[x]))) return abortBattle(state, frame, 'バトル参加キャラがいない（20-4[14]）', trace)
      return setFrame(state, advance(frame))
    case 16: {
      // 【利用者の決定】バトル種目は挑んだ側が選ぶ（DESIGN §4.10）。カードの効果で先に決まっていたら選ばない（21）
      if (b.cardDecided) return setFrame(state, advance(frame))
      // 《百物語》: 一度このバトルを挑んだキャラ（このターン）は、このバトルカードを選べない
      const challenging = b.participants[c]
      const opts = Object.values(state.cards).filter((x) => x.zone === 'battle' && !x.used && !state.layers.unusable.includes(x.iid) && !(state.layers.oncePerChar.includes(x.iid) && (state.procMeta.marks[x.iid] ?? []).some((m) => challenging.includes(m))))
      if (opts.length === 0) return abortBattle(state, frame, 'バトルカードが選択できない（20-4[16]）', trace)
      return coreChoice(state, frame, { by: c, kind: 'select', purpose: 'battleCard', prompt: 'バトル種目（20-4[16]）', options: opts.map((x) => ({ key: x.iid, label: x.cardId })), min: 1, max: 1 })
    }
    case 18: {
      // [18] 1. バトル種目のバトルカードを使用済み状態にする（2.3. はエンジンの [23]）
      const bc = b.battleCard ? state.cards[b.battleCard] : undefined
      // 使用されても使用済みにならないバトルカード（reusable）は used にしない。oncePerChar は挑んだキャラを印にする
      let s = bc && bc.zone === 'battle' && !state.layers.reusable.includes(bc.iid) ? { ...state, cards: { ...state.cards, [bc.iid]: { ...bc, used: true } } } : state
      if (bc && state.layers.oncePerChar.includes(bc.iid)) s = setMeta(s, { marks: { ...s.procMeta.marks, [bc.iid]: [...(s.procMeta.marks[bc.iid] ?? []), ...b.participants[c]] } })
      if (b.battleCard) trace.push({ kind: 'name', text: `バトル種目:${b.battleCard}` })
      return setFrame(s, advance(frame))
    }
    case 21:
      // [21] 挑んだプレイヤーは [19] に戻るか次の手順に進むかを選ぶ
      if (frame.step < b.startAt) return setFrame(state, advance(frame))
      return coreChoice(state, frame, { by: c, kind: 'select', purpose: 'battleLoop', prompt: '手順[19]に戻るか（20-4[21]）', options: [{ key: 'next', label: '次の手順に進む' }, { key: 'back', label: '手順[19]に戻る' }], min: 1, max: 1 })
    case 23:
      return setFrame(state, { ...frame, status: 'engine', engineWhat: 'battleValues' })
    case 24: {
      // [24] バトルの結果ダメージ＝対戦キャラの攻撃能力値－自分キャラの防御能力値（20-10）。
      // K9（統括16）: 組ごとに計算（挑んだ側1体×挑まれた側N体のNペア。両方>1はプールに無い＝一般化した全組合せで対応）。
      // FAQ:3878-3879: 全組を計算したのち、ダメージの適用は [26] で同時に行う
      if (!b.values || !b.values.A || !b.values.B) {
        trace.push({ kind: 'manual', text: '人が処理: バトルの結果の計算（攻防の値が決まっていない）' })
        return setFrame(state, advance(frame))
      }
      const aliveA = b.participants.A.filter((x) => onField(state.cards[x]))
      const aliveB = b.participants.B.filter((x) => onField(state.cards[x]))
      const entries: BattleDamageEntry[] = []
      for (const a of aliveA) {
        const va = b.values.A[a]
        if (!va) continue
        for (const bb of aliveB) {
          const vb = b.values.B[bb]
          if (!vb) continue
          // 鶴来屋温泉三本勝負（FAQ:3967）: 上から順の各回で結果ダメージ（0以下は0）を出して合計する。ダメージの処理は1件
          const pairValue = (atk: { atk: number; rounds?: { atk: number; def: number }[] }, def: { def: number; rounds?: { atk: number; def: number }[] }) =>
            atk.rounds && def.rounds ? atk.rounds.reduce((sum, r, i) => sum + Math.max(0, r.atk - def.rounds![i].def), 0) : atk.atk - def.def
          entries.push({ seat: 'A', recipient: a, dealer: bb, value: pairValue(vb, va) })
          entries.push({ seat: 'B', recipient: bb, dealer: a, value: pairValue(va, vb) })
        }
      }
      // 漫画（FAQ:3985）: 攻・防を比較して出した結果を半分に（端数切り上げ）。増減（pendingEdits）より前。0以下はそのまま
      let damage = b.dmgHalf === 'ceil' ? entries.map((e) => (e.value > 0 ? { ...e, value: Math.ceil(e.value / 2) } : e)) : entries
      for (const e of b.pendingEdits) damage = applyBattleEdit(damage, e)
      // NH-21（交渉売買）: 結果ダメージの上限。0以下（ダメージ不発生）はそのまま・上限を超える分だけ切り下げる
      if (b.dmgCap !== null) damage = damage.map((e) => (e.value > b.dmgCap! ? { ...e, value: b.dmgCap! } : e))
      // 段ごとに1件（複数参加 K9 で組が複数あっても iid が1段1個になるように。理由は procSetParticipants と同じ）
      if (damage.length === 0) trace.push({ kind: 'name', text: 'バトルの結果:無し' })
      else for (const d of damage) trace.push({ kind: 'name', text: `バトルの結果:${d.seat}:${d.recipient}:${d.value}` })
      return setFrame(state, { ...advance(frame), battle: { ...b, damage, pendingEdits: [] } })
    }
    case 26:
      return battleDamageStep(state, frame, trace)
    default:
      return setFrame(state, advance(frame))
  }
}

/** [24] より前に使われた結果ダメージの増減。K9: 同じ席の全件に当てる（複数参加で意味が割れる増減はプールに無い＝統括16の広報） */
export function applyBattleEdit(damage: BattleDamageEntry[], e: BattleEdit): BattleDamageEntry[] {
  return damage.map((entry) => {
    if (entry.seat !== e.seat) return entry
    if (e.set !== undefined) return { ...entry, value: e.set }
    if (e.delta === undefined) return entry
    // 20-10: 0以下はダメージが発生しなかったと見なされ、増減の効果を受けない（カードに「０でも」とあれば別 21）
    if (entry.value <= 0 && !e.evenIfZero) return entry
    return { ...entry, value: Math.max(entry.value, 0) + e.delta }
  })
}

/** [26] ダメージ処理・ダウン処理。両者の結果ダメージは同時に発生・発生元は別（FAQ:3461）。《先手必勝》は先に与えた側から（FAQ:1450）。
 *  K9: 複数参加で《先手必勝》が絡む（席ごとに複数件のダメージがあり「先に与えた側の参加キャラが受ける」対戦キャラが一意でない）場合は
 *  manual に倒す（PHASE-R4b §2(A)「先手必勝と複数参加が重なったら manual」） */
function battleDamageStep(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const b = frame.battle!
  const done = (s: BoardState) => {
    const f = findFrame(s, frame.id)!
    const lostNow = [...f.battle!.participants.A, ...f.battle!.participants.B].filter((x) => !onField(s.cards[x]))
    return setFrame(s, { ...advance(f), battle: { ...f.battle!, dmgPhase: 2, resultDowned: [...f.battle!.resultDowned, ...lostNow] } })
  }
  if (!b.damage || b.dmgPhase >= 2) return done(state)
  const multi = b.participants.A.length > 1 || b.participants.B.length > 1
  if (multi && b.firstStrike.length > 0) {
    trace.push({ kind: 'manual', text: '人が処理: 複数参加と先手必勝が重なったバトルの結果ダメージ' })
    return done(state)
  }
  const seed = (recv: Seat): DamageSeed | null => {
    const entry = b.damage!.find((e) => e.seat === recv)
    if (!entry || entry.value <= 0 || !onField(state.cards[entry.recipient])) return null
    return { value: entry.value, recipient: entry.recipient, dealerIid: entry.dealer, dealerSeat: otherSeat(recv), battle: frame.id }
  }
  const claims = [...new Set(b.firstStrike.map((x) => x.seat))]
  if (b.dmgPhase === 0 && claims.length === 2 && b.firstChosen === null) {
    // 両者の《先手必勝》: AP がどちらの効果を優先するか選ぶ（FAQ:1450）
    return coreChoice(state, frame, { by: activeSeat(state), kind: 'order', purpose: 'firstStrike', prompt: 'どちらの「先にダメージを与える」効果を優先するか（FAQ:1450）', options: b.firstStrike.map((x) => ({ key: x.key, label: `${x.seat} の「先にダメージを与える」効果` })), min: 0, max: b.firstStrike.length })
  }
  const first = b.firstChosen ?? (claims.length === 1 ? claims[0] : null)
  const resume = (s: BoardState, phase: number) => setFrame(s, { ...findFrame(s, frame.id)!, status: 'resume', resume: 'reenter', battle: { ...findFrame(s, frame.id)!.battle!, dmgPhase: phase } })
  if (b.dmgPhase === 0) {
    if (first) {
      // 先に与える側のダメージ（対戦キャラが受ける）だけ（multi はここに来ない＝先手必勝と複数参加は上で manual）
      const sd = seed(otherSeat(first))
      if (!sd) return resume(state, 1)
      return pushDamages(resume(state, 1), [sd])
    }
    // K9: 全件を同時に発生させる（単数参加なら旧来どおり両陣営2件・複数参加ならN件。FAQ:3878-3879「計算を全てしたのちに同時に適用」）
    const seeds = b.damage!
      .filter((e) => e.value > 0 && onField(state.cards[e.recipient]))
      .map((e): DamageSeed => ({ value: e.value, recipient: e.recipient, dealerIid: e.dealer, dealerSeat: otherSeat(e.seat), battle: frame.id }))
    if (seeds.length === 0) return done(state)
    return pushDamages(resume(state, 2), seeds)
  }
  // dmgPhase 1: 先に与えた側の参加キャラが受ける。対戦キャラがダウンしていれば受けない（《先手必勝》。multi はここに来ない）
  const opp = b.participants[otherSeat(first!)][0]
  if (!onField(state.cards[opp])) return done(state)
  const sd = seed(first!)
  if (!sd) return done(state)
  return pushDamages(resume(state, 2), [sd])
}

/**
 * [28] バトル中断・終了時の処理: 攻防修正を失わせる・「バトル終了時まで」の効果を失わせる（《バトル終了時》の効果はエンジンのタイミングの処理）。
 * 継続効果の層（R3）: 常時効果（whileSource）の攻防修正は発生源がある限り続く（12-2）ので、ここでは外さない（エンジンが発生源を見て外す）
 */
function battleEndCleanup(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const b = frame.battle!
  const list = state.layers.list
  const keep = list.filter((m) => !((m.kind === '攻防修正' && m.until !== 'whileSource') || (m.until === 'battle' && (m.battleId === frame.id || m.battleId === null))))
  let s: BoardState = keep.length === list.length ? state : { ...state, layers: { ...state.layers, list: keep } }
  if (keep.length !== list.length) trace.push({ kind: 'name', text: `攻防修正・バトル終了時までの効果を失わせた:${list.length - keep.length}` })
  for (const iid of b.endTrash) if (s.cards[iid]?.zone === 'battle') s = moveTo(s, iid, 'trash')
  return s
}

// ── ターンの進行（10-4 エントリー・10-6 終了フェイズ・10-7 手札調整・10-8 ターン終了）
function enterPhase(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const ap = activeSeat(state)
  // 10-5[2]・10-6[2]: お互いのプレイヤーはそのフェイズで可能なアクションを行う（10-5-1・10-6-1）＝フレームを降ろし、popFrame がフェイズの窓を開く用意をする
  if (frame.kind === 'endPhase' || frame.kind === 'mainPhase') return setFrame(state, { ...frame, status: 'done' })
  if (frame.kind === 'entry') {
    switch (frame.step) {
      case 2: {
        // [2] AP は任意に消耗状態の自分のキャラを待機状態にする
        const opts = fieldChars(state, ap).filter((x) => x.orientation === 'rested')
        if (opts.length === 0) return setFrame(state, advance(frame))
        return coreChoice(state, frame, { by: ap, kind: 'select', purpose: 'entryReady', prompt: '待機状態に戻すキャラ（10-4[2]・任意）', options: opts.map((x) => ({ key: x.iid, label: x.cardId })), min: 0, max: opts.length })
      }
      case 3: {
        // [3] AP は必ずフィールド上のすべてのバトルカードを未使用状態にする（両者のもの FAQ:3452）
        const cards = { ...state.cards }
        for (const x of Object.values(cards)) if (x.zone === 'battle' && x.used) cards[x.iid] = { ...x, used: false }
        return setFrame({ ...state, cards }, advance(frame))
      }
      case 4:
        // [4] AP は必ず自分のデッキからカードを1枚ドローする。先攻の1ターン目はドローできない（10-2-4 oldrule.txt:376-378）
        if (state.turn?.n === 1) return setFrame(state, advance(frame))
        trace.push({ kind: 'name', text: `ドロー:${ap}:1` })
        return setFrame(drawCard(state, ap), advance(frame))
      default:
        return setFrame(state, advance(frame))
    }
  }
  if (frame.kind === 'handAdjust') {
    if (frame.step === 3) {
      // [3] 手札の上限枚数（7）を超えていれば、上限になるように選んでゴミ箱送り
      const hand = cardsInZone(state, ap, 'hand')
      const n = hand.length - HAND_LIMIT
      if (n <= 0) return setFrame(state, advance(frame))
      return coreChoice(state, frame, { by: ap, kind: 'select', purpose: 'handDiscard', prompt: `手札を${n}枚ゴミ箱送り（10-7[3]）`, options: hand.map((x) => ({ key: x.iid, label: x.cardId })), min: n, max: n })
    }
    return setFrame(state, advance(frame))
  }
  // turnEnd [2]: コストの破棄・能力値修正を失わせる処理・《ターン終了時》に失われる効果の処理（10-8）。【１ターンにｎ回まで】の数え直し
  // 継続効果の層（R3）: 常時効果（whileSource）の能力値修正は発生源がある限り続く（12-2）ので外さない
  if (frame.step === 2) {
    const list = state.layers.list.filter((m) => m.until !== 'turn' && !(m.kind === '能力値修正' && m.until !== 'whileSource'))
    trace.push({ kind: 'name', text: 'ターン終了の処理（10-8）' })
    return setFrame(setMeta({ ...state, costs: { A: [], B: [] }, layers: { ...state.layers, list } }, { used: {}, marks: {} }), advance(frame))
  }
  return setFrame(state, advance(frame))
}

/** core の選択の答えを当てる */
function applyCoreChoice(state: BoardState, ch: ProcChoice, pick: string[], trace: ProcTrace[]): BoardState {
  // 場の制限の是正（15-2・17-1・17-2・19-1。K12・R3）: 選んだカードをゴミ箱送り（手順のフレームに属さない）
  if (ch.purpose === 'limitTrash') return limitTrash(state, pick, trace)
  const frame = ch.frameId ? findFrame(state, ch.frameId) : undefined
  if (!frame) return state
  const b = frame.battle
  switch (ch.purpose) {
    case 'battleParticipant': {
      // 指定したら、そのキャラを消耗させる（20-4[7][11]・FAQ:3465 指定した瞬間）
      const seat = ch.by
      let s = state
      const joinedReady = [...b!.joinedReady]
      for (const iid of pick) {
        const x = s.cards[iid]
        if (!x) continue
        if (x.orientation === 'ready') joinedReady.push(iid)
        s = { ...s, cards: { ...s.cards, [iid]: { ...x, orientation: 'rested' } } }
        trace.push({ kind: 'name', text: `バトル参加:${iid}`, id: `${frame.id}:${iid}` })
      }
      return setFrame(s, { ...advance(frame), battle: { ...b!, participants: { ...b!.participants, [seat]: pick }, decided: { ...b!.decided, [seat]: pick.length > 0 }, joinedReady } })
    }
    case 'battleCard':
      return setFrame(state, { ...advance(frame), battle: { ...b!, battleCard: pick[0] ?? null, cardDecided: pick.length > 0 } })
    case 'battleLoop':
      if (pick[0] === 'back') return setFrame(state, { ...frame, step: 19, status: 'enter', battle: { ...b!, abilityUsed: false, reopen: false } })
      return setFrame(state, advance(frame))
    case 'firstStrike': {
      const order = pick.length ? pick : ch.options.map((o) => o.key)
      const firstSeat = b!.firstStrike.find((x) => x.key === order[0])?.seat ?? null
      return setFrame(state, { ...frame, status: 'enter', battle: { ...b!, firstChosen: firstSeat } })
    }
    case 'entryReady': {
      let s = state
      for (const iid of pick) if (s.cards[iid]) s = { ...s, cards: { ...s.cards, [iid]: { ...s.cards[iid], orientation: 'ready' } } }
      return setFrame(s, advance(frame))
    }
    case 'handDiscard': {
      let s = state
      for (const iid of pick) s = moveTo(s, iid, 'trash')
      return setFrame(s, advance(frame))
    }
    default:
      return state
  }
}

/** 場の制限を満たすためのゴミ箱送り（ダウンではない）。リーダーはゴミ箱送りにしない */
function limitTrash(state: BoardState, iids: string[], trace: ProcTrace[]): BoardState {
  let s = state
  for (const iid of iids) {
    const c = s.cards[iid]
    if (!c || c.zone === 'leader' || (c.zone !== 'char' && c.zone !== 'battle')) continue
    trace.push({ kind: 'name', text: `場の制限:${iid}`, id: `limit:${iid}` })
    s = moveTo(s, iid, 'trash')
  }
  return s
}

function enterAction(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const decl = frame.decl!
  switch (frame.step) {
    case 6: {
      // [6] 再提示（イベントはその後ゴミ箱送り 16-1[6]）
      const src = decl.sourceIid ? state.cards[decl.sourceIid] : undefined
      let s = state
      let represented = false
      if (frame.kind === 'event') {
        if (src && src.zone === 'pending') {
          s = moveTo(s, src.iid, 'trash')
          represented = true
        }
      } else if (decl.eng.synthetic) {
        // NH-17（D15・R4a-2）: 処理条件がある常時効果を decl 化した合成の宣言（宣言[1]〜[5]を経ていない）は
        // 「再提示」の対象ではない（15-13-1[6] はカードを宣言のために提示エリアへ出す手順の続き）。発生源は
        // フィールドのキャラとは限らない（アイテム等）ので、engine が eng.synthetic で「確かめない」と伝える
        represented = true
      } else represented = onField(src)
      return setFrame(s, { ...advance(frame), represented })
    }
    case 7: {
      // [7] [4]で宣言したコストを発生させるアクションの処理
      const i = frame.cgIndex ?? 0
      if (i < decl.costGens.length) {
        // D21（R4a-2 続き）: cgSubs（7-2[3] の窓で宣言したイベント等）を costGen の処理に渡す（enterCardUse と同じ。
        // ここが抜けていたため、payWith にイベントの iid を指定しても [3] の窓で宣言したイベントが処理されなかった）
        const cg: ProcDecl = { ...decl, id: `${decl.id}.cg${i}`, kind: 'costGen', label: 'コスト発生', sources: decl.costGens[i], subDecls: decl.cgSubs?.[i] ?? [], costGens: [], eng: {} }
        const s1 = setFrame(state, { ...frame, cgIndex: i + 1, status: 'resume', resume: 'reenter' })
        return pushDeclFrame(s1, cg, { step: 4, bindTo: frame.id })
      }
      return setFrame(state, advance(frame))
    }
    case 9:
      return setFrame(state, { ...frame, status: 'engine', engineWhat: 'pay' })
    case 10:
    case 12:
      if (!frame.represented) return abortFrame(state, frame, '再提示できない', trace)
      if (frame.paid === false) return abortFrame(state, frame, '使用代償を支払えない', trace)
      return setFrame(state, { ...frame, status: 'engine', engineWhat: 'check' })
    case 14:
      return setFrame(state, { ...frame, status: 'engine', engineWhat: 'effect' })
    default:
      return setFrame(state, advance(frame))
  }
}

function abortFrame(state: BoardState, frame: ProcFrame, reason: string, trace: ProcTrace[]): BoardState {
  trace.push({ kind: 'abort', text: `${frame.label}: ${reason}`, id: frame.decl?.id })
  const aborted = frame.decl ? [...state.procMeta.aborted, { declId: frame.decl.id, reason }] : state.procMeta.aborted
  return setMeta(setFrame(state, { ...frame, aborted: reason, status: 'done' }), { aborted })
}

function enterCostGen(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const decl = frame.decl!
  switch (frame.step) {
    case 4: {
      // [4] 再提示できた発生源を消耗・ゴミ箱送り（[6] 再提示できなければ中断）
      let s = state
      for (const src of decl.sources) {
        const c = s.cards[src.iid]
        if (src.from === 'field') {
          if (!onField(c) || c.orientation !== 'ready') return abortFrame(s, frame, '発生源を再提示できない', trace)
          s = { ...s, cards: { ...s.cards, [c.iid]: { ...c, orientation: 'rested' } } }
        } else {
          if (!c || c.zone !== 'hand' || c.owner !== decl.by) return abortFrame(s, frame, '発生源を再提示できない', trace)
          s = moveTo(s, c.iid, 'trash')
        }
      }
      return setFrame(s, { ...advance(frame) })
    }
    case 5: {
      // [5] 手順[3]（宣言の段）で宣言したコストを発生させるアクションの処理を行う
      const subs = decl.subDecls ?? []
      if (subs.length === 0) return setFrame(state, advance(frame))
      const s1 = setFrame(state, { ...frame, status: 'resume', resume: 'advance' })
      return pushSimul(s1, subs.map(declItem), '《コストを発生するとき》に宣言した行動の処理（7-2[5]）', null, false)[0]
    }
    case 9: {
      // [9] 発生したコストを得る
      const tokens = [...state.costs[decl.by]]
      let s = state
      for (const src of decl.sources) {
        const [s2, id] = nextId(s, 'cost')
        s = s2
        tokens.push({ id, icon: src.icon, attrs: src.attrs, frameId: frame.bindTo ?? nearestActionFrame(s) })
      }
      s = { ...s, costs: { ...s.costs, [decl.by]: tokens } }
      trace.push({ kind: 'name', text: `コスト発生:${decl.sources.map((x) => x.icon + x.attrs.join('')).join('')}` })
      return setFrame(s, { ...frame, status: 'done' })
    }
    default:
      return setFrame(state, advance(frame))
  }
}

function enterDamage(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const d = frame.damage!
  switch (frame.step) {
    case 2:
      if (d.value <= 0) return setFrame(state, { ...frame, status: 'done' })
      return setFrame(state, { ...advance(frame), damage: { ...d, occurred: true } })
    case 6: {
      const card = state.cards[d.recipient]
      if (!d.occurred || d.value <= 0 || !onField(card) || card.kiryoku === null) return setFrame(state, { ...frame, status: 'done' })
      trace.push({ kind: 'name', text: `ダメージ:${d.recipient}:${d.value}` })
      const before = card.kiryoku
      const after = before - d.value
      const s: BoardState = { ...state, cards: { ...state.cards, [card.iid]: { ...card, kiryoku: after } } }
      const pendingDowns = before >= 1 && after <= 0 ? [card.iid] : []
      return setFrame(s, { ...frame, status: 'done', pendingDowns })
    }
    default:
      return setFrame(state, advance(frame))
  }
}

/** 効果で「呼び出す」（D17・R4a-2）。[2] 場に出す（気力はエンジンが決める＝ engineWhat 'place'・placeChar を流用） */
function enterSummon(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const d = frame.summon!
  switch (frame.step) {
    case 2: {
      // カードが宣言時点の場所からまだ動いていなければ場に出す。動いていれば（他の効果で失われた等）何もしない
      if (state.cards[d.iid]?.zone !== d.fromZone) {
        trace.push({ kind: 'name', text: `呼び出せない（場所を失った）:${d.iid}` })
        return setFrame(state, { ...frame, summon: { ...d, canceled: true }, status: 'done' })
      }
      return setFrame(state, { ...frame, status: 'engine', engineWhat: 'place' })
    }
    default:
      return setFrame(state, advance(frame))
  }
}

function enterDown(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const d = frame.down!
  switch (frame.step) {
    case 1:
      trace.push({ kind: 'name', text: `ダウン:${d.iid}`, id: `${frame.id}:${d.iid}` })
      return setFrame(state, advance(frame))
    case 3:
      trace.push({ kind: 'name', text: 'ダウン数+1' })
      return setFrame(state, { ...advance(frame), down: { ...d, added: true } })
    case 5: {
      if (!d.added) return setFrame(state, advance(frame))
      trace.push({ kind: 'name', text: 'ボーナスドロー' })
      const s = drawCard(state, otherSeat(d.seat))
      return setFrame(s, advance(frame))
    }
    case 6: {
      // [6] ダウンしたキャラと装備していたアイテムをゴミ箱送り。[3] で加えたダウン数をここで確定する（H-12）
      let s = state
      const card = s.cards[d.iid]
      if (card && (card.zone === 'char' || card.zone === 'leader')) s = moveTo(s, d.iid, 'trash', { leaderNow: false })
      if (d.added) s = { ...s, downs: { ...s.downs, [d.seat]: s.downs[d.seat] + 1 } }
      if (d.wasLeader && card && card.zone === 'leader') s = setMeta(s, { leaderLost: [...s.procMeta.leaderLost, d.seat] })
      return setFrame(s, advance(frame))
    }
    case 7: {
      const idx = state.proc.findIndex((f) => f.id === frame.id)
      const coll = collectingSimul(state, idx)
      if (coll) return setFrame(setFrame(state, { ...coll, simul: { ...coll.simul!, endCheck: true } }), { ...frame, status: 'done' })
      const s = checkEnd(state, 'ダウン処理[7] の終了判定')
      return setFrame(s, { ...frame, status: 'done' })
    }
    default:
      return setFrame(state, advance(frame))
  }
}

function resumeFrame(state: BoardState, frame: ProcFrame): BoardState {
  switch (frame.resume) {
    case 'reenter':
      return setFrame(state, { ...frame, status: 'enter', resume: undefined })
    case 'advance':
      return setFrame(state, { ...advance(frame), resume: undefined })
    case 'afterTiming':
      if (frame.kind === 'damage' && frame.damage!.rerun) {
        return setFrame(state, { ...frame, status: 'enter', resume: undefined, window: null, damage: { ...frame.damage!, rerun: false } })
      }
      // 20-4[19][20][22]「イベントカードを複数回使用できる機会」: 宣言があったら同じ段の機会をもう一度開く（両者が続けて見送るまで）
      if (frame.kind === 'battle' && frame.battle?.reopen && !frame.battle.aborted) {
        return setFrame(state, { ...frame, status: 'enter', resume: undefined, window: null, battle: { ...frame.battle, reopen: false } })
      }
      return setFrame(state, { ...advance(frame), resume: undefined, window: null })
    case 'item': {
      const items = frame.simul!.items.map((it) => (it.status === 'running' ? { ...it, status: 'done' as const } : it))
      return setFrame(state, { ...frame, status: 'items', resume: undefined, simul: { ...frame.simul!, items } })
    }
    default:
      return setFrame(state, { ...frame, status: 'enter' })
  }
}

function popFrame(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  let s: BoardState = { ...state, proc: state.proc.filter((f) => f.id !== frame.id) }
  // 7-3: 種類が有効なアクションが終わったら、そのコストはその他のコスト（W）として扱う
  if (isActionKind(frame.kind)) {
    const costs = { ...s.costs }
    for (const seat of ['A', 'B'] as Seat[]) {
      costs[seat] = costs[seat].map((t) => (t.frameId === frame.id ? { ...t, icon: 'W' as CostKind, frameId: null } : t))
    }
    s = { ...s, costs }
  }
  // 使用代償のダウンが取り消された＝支払っていない（FAQ:2040）
  if (frame.kind === 'down' && frame.down!.canceled && frame.down!.costOf) {
    const payer = findFrame(s, frame.down!.costOf)
    if (payer) s = setFrame(s, { ...payer, paid: false })
  }
  // ダメージ[6] で起きたダウン
  for (const iid of frame.pendingDowns ?? []) s = pushDown(s, iid, null, frame.damage?.battle ?? null)
  if (frame.kind === 'simul' && frame.simul!.collect && frame.simul!.endCheck) {
    s = checkEnd(s, '同時処理内のダウンの終了判定（15-5-2）')
  }
  if (frame.kind === 'battle') {
    const b = frame.battle!
    s = setMeta(s, { battles: [...s.procMeta.battles, { id: frame.id, challenger: b.challenger, battleCard: b.battleCard, aborted: b.aborted, participants: b.participants }] })
    trace.push({ kind: 'name', text: b.aborted ? `バトル終了（中断）` : 'バトル終了' })
  }
  // ターンの進行: エントリーが終わったらメインフェイズ（13-3-1 の窓を開き直す）。手札調整が終わったらターン終了（10-8）
  if (frame.kind === 'entry' && s.turn) s = setMeta({ ...s, turn: { ...s.turn, phase: 'メイン' } }, { base: null, mainClosed: false, phaseRun: null })
  // 10-5: [2] で降りたらメインフェイズの窓（drive が procOpenMain で開く）。[3] が終わったら終了フェイズ（10-2-3）
  if (frame.kind === 'mainPhase' && s.turn) {
    s = frame.step === 2 ? setMeta(s, { base: null, mainClosed: false, phaseRun: MAIN_ACTIONS }) : setMeta({ ...s, turn: { ...s.turn, phase: '終了' } }, { base: null, mainClosed: false, phaseRun: null })
  }
  // 10-6: [2] で降りたらフェイズの窓（drive が procOpenMain で開く）。[3] が終わったら手札調整フェイズ（10-2-3）
  if (frame.kind === 'endPhase' && s.turn) {
    s = frame.step === 2 ? setMeta(s, { base: null, mainClosed: false, phaseRun: PHASE_ACTIONS }) : setMeta({ ...s, turn: { ...s.turn, phase: '手札調整' } }, { base: null, mainClosed: false, phaseRun: null })
  }
  // ターン終了（10-8）の後は相手のターン（10-2 交互に進行）。10-3 ターン開始の《ターン開始時》の処理は R3（タイミングの表に無い）【決めたこと】
  if (frame.kind === 'turnEnd' && s.turn) s = setMeta({ ...s, turn: { active: s.turn.active === 'A' ? 'B' : 'A', phase: 'エントリー', ...(s.turn.n !== undefined ? { n: s.turn.n + 1 } : {}) } }, { base: null, mainClosed: false, phaseRun: null })
  if (frame.kind === 'handAdjust') s = pushFrame(setMeta(s, { phaseRun: 'ターン終了' }), { kind: 'turnEnd', step: 1, status: 'enter', window: null, by: activeSeat(s), label: 'ターン終了', eng: {} }, 'phase')[0]
  return s
}

// ───────────────────────────────────────────────────────────────
// 同時処理（13-2・12-2-1・15-5-2）
// ───────────────────────────────────────────────────────────────

function nextItem(state: BoardState, frame: ProcFrame, _trace: ProcTrace[]): BoardState {
  const sim = frame.simul!
  const ap = activeSeat(state)
  const pending = sim.items.map((it, i) => ({ it, i })).filter(({ it }) => it.status === 'pending')
  if (pending.length === 0) return setFrame(state, { ...frame, status: 'done' })
  if (sim.order === null) {
    const onlyActions = sim.items.every((it) => it.type === 'action')
    if (sim.items.length > 1 && !onlyActions) {
      // K10: AP が処理の順を決める（13-2）
      const [s, id] = nextId(state, 'ch')
      const choice: ProcChoice = {
        id,
        by: ap,
        kind: 'order',
        prompt: '同時処理の順（AP が決める）',
        options: sim.items.map((it) => ({ key: it.key, label: it.label, sourceIid: it.sourceIid, qty: it.type === 'damage' ? it.damage!.value : undefined })),
        min: 0,
        max: sim.items.length,
        frameId: frame.id,
      }
      return setMeta(s, { choice })
    }
    // 宣言された行動だけ: 11-2-2 AP 優先処理（AP→NAP の順は固定）
    const order = sim.items.map((_, i) => i).sort((a, b) => rankAction(sim.items[a], ap) - rankAction(sim.items[b], ap))
    return setFrame(state, { ...frame, simul: { ...sim, order } })
  }
  const nextIdx = sim.order.find((i) => sim.items[i].status === 'pending')
  if (nextIdx === undefined) return setFrame(state, { ...frame, status: 'done' })
  const item = sim.items[nextIdx]
  const items = sim.items.map((it, i) => (i === nextIdx ? { ...it, status: 'running' as const } : it))
  const running: ProcFrame = { ...frame, simul: { ...sim, items } }
  if (item.type === 'effect') return setFrame(state, { ...running, status: 'engine', engineWhat: 'item' })
  const s1 = setFrame(state, { ...running, status: 'resume', resume: 'item' })
  if (item.type === 'action') return pushDeclFrame(s1, item.decl!)
  const d = item.damage!
  return pushFrame(
    s1,
    {
      kind: 'damage',
      step: 1,
      status: 'enter',
      window: null,
      by: ap,
      label: `ダメージ→${d.recipient}`,
      damage: { ...d, group: frame.id, occurred: false, rerun: false, battle: d.battle ?? null, origRecipient: null },
      eng: {},
    },
    'dmg',
  )[0]
}

function rankAction(it: SimulItem, ap: Seat): number {
  // 20-4[3]「手順[2]で宣言した同時アクションの処理」はバトルの手順の中（[4] より前）＝同じ同時処理のバトルより先（FAQ:1186・1593）
  if (it.type === 'action' && it.decl?.kind === 'battle') return 1.5
  return it.type === 'action' ? (it.by === ap ? 0 : 1) : 2
}

/** AP の選んだ順（一部だけでもよい。残りは元の並び）。宣言された行動どうしは AP→NAP を保つ（11-2-2） */
function applyOrder(state: BoardState, frame: ProcFrame, pick: string[]): BoardState {
  const sim = frame.simul!
  const ap = activeSeat(state)
  const picked: number[] = []
  for (const k of pick) {
    const i = sim.items.findIndex((it, j) => it.key === k && !picked.includes(j))
    if (i >= 0) picked.push(i)
  }
  const order = [...picked, ...sim.items.map((_, i) => i).filter((i) => !picked.includes(i))]
  const apPos = order.findIndex((i) => sim.items[i].type === 'action' && sim.items[i].by === ap)
  const napPos = order.findIndex((i) => sim.items[i].type === 'action' && sim.items[i].by !== ap)
  if (apPos >= 0 && napPos >= 0 && napPos < apPos) [order[apPos], order[napPos]] = [order[napPos], order[apPos]]
  return setFrame(state, { ...frame, simul: { ...sim, order } })
}

function pushSimul(state: BoardState, items: SimulItem[], label: string, forFrame: string | null, collect: boolean): [BoardState, string] {
  return pushFrame(
    state,
    {
      kind: 'simul',
      step: 0,
      status: 'items',
      window: null,
      by: activeSeat(state),
      label,
      simul: { items, order: null, collect, endCheck: false, forFrame },
      eng: {},
    },
    'sim',
  )
}

/** ダメージを積む。1件ならそのまま、同時に発生した複数のダメージは受け手ごとに1件の同時処理（H-1・順は AP が決める FAQ:1409） */
function pushDamages(state: BoardState, ds: DamageSeed[]): BoardState {
  const ap = activeSeat(state)
  if (ds.length === 1) {
    const d = ds[0]
    return pushFrame(
      state,
      { kind: 'damage', step: 1, status: 'enter', window: null, by: ap, label: `ダメージ→${d.recipient}`, damage: { ...d, group: null, occurred: false, rerun: false, battle: d.battle ?? null, origRecipient: null }, eng: {} },
      'dmg',
    )[0]
  }
  const items: SimulItem[] = ds.map((d) => ({
    key: d.recipient,
    label: `ダメージ→${d.recipient}`,
    by: ap,
    sourceIid: d.dealerIid,
    type: 'damage',
    damage: d,
    eng: {},
    status: 'pending',
  }))
  return pushSimul(state, items, '同時に発生したダメージ', null, true)[0]
}

function declItem(decl: ProcDecl): SimulItem {
  return { key: decl.id, label: decl.label, by: decl.by, sourceIid: decl.sourceIid, type: 'action', decl, eng: {}, status: 'pending' }
}

// ───────────────────────────────────────────────────────────────
// 窓（11-2）
// ───────────────────────────────────────────────────────────────

function windowEnd(state: BoardState, frame: ProcFrame | null, window: ProcWindow): BoardState {
  const closed: ProcWindow = { ...window, state: 'closed' }
  const decls = [window.active, window.nonActive].filter((d): d is ProcDecl => d !== null)
  if (!frame) {
    // フェイズの窓: AP のフェイズ終了の宣言を NAP が認めた（見送った）＝そのフェイズは終わる（10-2-2 oldrule.txt:367-369）
    if (decls.length === 0 && window.phaseEnd) return phaseEndAgreed(state)
    // メインフェイズの窓: 何も宣言されなければメインフェイズの宣言の機会は終わり（13-3-1）
    if (decls.length === 0) return setMeta(state, { base: null, mainClosed: true })
    const s = setMeta(state, { base: null })
    return pushSimul(s, decls.map(declItem), '行動の処理（11-2 [4][5]）', null, false)[0]
  }
  // タイミングの段: エンジンに《〜とき》の処理を聞く（宣言された行動とまとめて同時処理にする）
  return setFrame(state, { ...frame, window: closed, status: 'engine', engineWhat: 'timing' })
}

/**
 * 10-2-2: フェイズ終了の宣言が認められた。メイン→終了フェイズ（10-2-3）。終了フェイズ→ [3]《終了フェイズ終了時》の段
 * （それが終わると popFrame が手札調整フェイズへ）。エントリー・手札調整は段が終わると自分で次へ進む（R2u-1 の決めたこと）
 */
function phaseEndAgreed(state: BoardState): BoardState {
  const turn = state.turn
  if (!turn) return setMeta(state, { base: null, mainClosed: true })
  if (turn.phase === '終了') {
    const s = setMeta(state, { base: null, mainClosed: false, phaseRun: '終了[3]' })
    return pushFrame(s, { kind: 'endPhase', step: 3, status: 'enter', window: null, by: activeSeat(s), label: '終了フェイズ', eng: {} }, 'phase')[0]
  }
  // 10-5[3]《メインフェイズ終了時》（[1] から始めたメインフェイズだけ。turn.n の無い盤面は今までどおり終了フェイズへ）
  if (turn.phase === 'メイン' && state.procMeta.phaseRun === MAIN_ACTIONS) {
    const s = setMeta(state, { base: null, mainClosed: false, phaseRun: 'メイン[3]' })
    return pushFrame(s, { kind: 'mainPhase', step: 3, status: 'enter', window: null, by: activeSeat(s), label: 'メインフェイズ', eng: {} }, 'phase')[0]
  }
  const next: Phase = turn.phase === 'メイン' ? '終了' : turn.phase
  return setMeta({ ...state, turn: { ...turn, phase: next } }, { base: null, mainClosed: false, phaseRun: null })
}

/** 10-2-2: AP がフェイズ終了を宣言できるか（フェイズの窓で AP の番＝まだ誰も宣言していない） */
export function canDeclarePhaseEnd(state: BoardState, by: Seat): boolean {
  const b = state.procMeta.base
  return !!state.turn && !state.result && !state.procMeta.choice && state.proc.length === 0 && !!b && b.state === 'awaitActive' && !b.active && by === activeSeat(state)
}

/** 10-2-2: NAP がフェイズ終了の宣言に答える番か */
export function phaseEndPending(state: BoardState): boolean {
  const b = state.procMeta.base
  return state.proc.length === 0 && !!b && !!b.phaseEnd && b.state === 'awaitNonActive' && !b.active && !state.procMeta.choice
}

function applyDeclare(state: BoardState, by: Seat, decl: ProcDecl): BoardState | null {
  const cur = currentWindow(state)
  if (!cur) return null
  const w = cur.window
  const ap = activeSeat(state)
  if (awaitingSeat(state) !== by) return null
  if (w.only && w.only !== by) return null
  let next: ProcWindow
  let ended = false
  if (w.state === 'awaitActive') {
    next = { ...w, active: decl, state: w.only ? 'closed' : 'awaitNonActive' }
    ended = !!w.only
  } else if (w.state === 'awaitNonActive') {
    next = { ...w, nonActive: decl, state: w.active || w.only ? 'closed' : 'awaitActiveSimul' }
    ended = !!(w.active || w.only)
  } else if (w.state === 'awaitActiveSimul') {
    next = { ...w, active: decl, state: 'closed' }
    ended = true
  } else return null
  void ap
  let s = state
  // 16-1[3]・15-10-1[3]・15-10-2[3]・17-3[3]・18-2[3]・19-2[3] 提示: 手札のカードは提示エリアへ（提示した時点で使用したと見なされる）
  if ((decl.kind === 'event' || isCardUse(decl.kind)) && decl.sourceIid) {
    const c = s.cards[decl.sourceIid]
    if (c && c.zone === 'hand') s = moveCard(s, { iid: c.iid, toZone: 'pending', cardName: c.cardId }).state
  }
  // 15-13-1[3]: 提示した特殊能力はこの時点で使用したと見なされる（【１ターンにｎ回まで】を数える）
  if (decl.usageKey) s = setMeta(s, { used: { ...s.procMeta.used, [decl.usageKey]: (s.procMeta.used[decl.usageKey] ?? 0) + 1 } })
  // 20-4[19][20][22]: 特殊能力は1回
  const bf = cur.frame && cur.frame.kind === 'battle' && decl.kind === 'ability' ? findFrame(s, cur.frame.id)! : null
  if (cur.frame) s = setFrame(s, { ...findFrame(s, cur.frame.id)!, window: next, ...(bf ? { battle: { ...bf.battle!, abilityUsed: true } } : {}) })
  else s = setMeta(s, { base: next })
  if (ended) s = windowEnd(s, cur.frame ? findFrame(s, cur.frame.id)! : null, next)
  // 7-2 宣言[1]〜[3]: コストを発生させるアクションは、その宣言の中で [3]《コストを発生するとき》の窓を開く（その宣言をしたプレイヤーだけ）。
  // 15-13-1[4]・16-1[4] ほかで宣言したコスト発生も、その宣言の中で [1]〜[3] を行う（統括11 の検証 C19・NH-4）
  const phases: ProcFrame[] = []
  if (decl.kind === 'costGen') phases.push(declPhaseFrame(decl, null))
  else decl.costGens.forEach((_, i) => phases.push(declPhaseFrame(decl, i)))
  for (const f of phases.reverse()) s = { ...s, proc: [...s.proc, f] }
  return s
}

function declPhaseFrame(decl: ProcDecl, cg: number | null): ProcFrame {
  return {
    id: cg === null ? `${decl.id}.d3` : `${decl.id}.cg${cg}.d3`,
    kind: 'costGen',
    step: 3,
    status: 'enter',
    window: null,
    by: decl.by,
    label: 'コスト発生（宣言）',
    decl,
    declPhase: { forDecl: decl.id, cg },
    eng: {},
  }
}

/** 宣言を書き換える（窓・同時処理の待ち・手順の中のどこにあっても） */
function patchDecl(state: BoardState, declId: string, fn: (d: ProcDecl) => ProcDecl): BoardState {
  const p = (d: ProcDecl | null | undefined) => (d && d.id === declId ? fn(d) : d)
  const pw = (w: ProcWindow | null) => (w ? { ...w, active: p(w.active) ?? null, nonActive: p(w.nonActive) ?? null } : w)
  return {
    ...state,
    proc: state.proc.map((f) => ({
      ...f,
      window: pw(f.window),
      decl: f.decl && f.id === declId ? fn(f.decl) : f.decl,
      simul: f.simul ? { ...f.simul, items: f.simul.items.map((it) => (it.decl ? { ...it, decl: p(it.decl)! } : it)) } : f.simul,
    })),
    procMeta: { ...state.procMeta, base: pw(state.procMeta.base) },
  }
}

function applyPass(state: BoardState, by: Seat): BoardState | null {
  const cur = currentWindow(state)
  if (!cur) return null
  const w = cur.window
  if (awaitingSeat(state) !== by) return null
  let next: ProcWindow
  let ended = false
  if (w.state === 'awaitActive') {
    ended = !!w.only
    next = { ...w, state: ended ? 'closed' : 'awaitNonActive' }
  } else if (w.state === 'awaitNonActive' || w.state === 'awaitActiveSimul') {
    next = { ...w, state: 'closed' }
    ended = true
  } else return null
  let s = state
  if (cur.frame) s = setFrame(s, { ...cur.frame, window: next })
  else s = setMeta(s, { base: next })
  if (ended) s = windowEnd(s, cur.frame ? findFrame(s, cur.frame.id)! : null, next)
  return s
}

// ───────────────────────────────────────────────────────────────
// 入口（BoardAction から呼ばれる）
// ───────────────────────────────────────────────────────────────

export type ProcAction =
  | { type: 'procOpenMain' }
  | { type: 'procDeclare'; by: Seat; decl: ProcDecl }
  | { type: 'procPass'; by: Seat }
  | { type: 'procDeclPatch'; declId: string; targets?: string[]; eng?: Record<string, unknown> }
  | { type: 'procChoice'; choice: Omit<ProcChoice, 'id'> & { id?: string } }
  | { type: 'procChoose'; id: string; pick: string[] }
  /** エンジン: タイミングの処理（処理条件がある常時効果）。宣言された行動とまとめて同時処理にする */
  | { type: 'procTimingDone'; frameId: string; items: Omit<SimulItem, 'status' | 'type'>[] }
  /** エンジン: [9] 使用代償の支払い（ok=false は支払えない） */
  | {
      type: 'procPay'
      frameId: string
      ok: boolean
      consume: string[]
      kiryoku: { iid: string; delta: number }[]
      trash: string[]
      down: string[]
    }
  /** エンジン: [10][12] 構成要素の確かめ */
  | { type: 'procCheck'; frameId: string; ok: boolean; reason?: string }
  /** エンジン: [14] 効果の処理（項目が空なら効果なし） */
  | { type: 'procEffect'; frameId: string; items: Omit<SimulItem, 'status' | 'type'>[] }
  /** エンジン: 同時処理の項目を終えた／読み飛ばした（K10: 条件を満たさなくなった効果） */
  | { type: 'procItemDone'; frameId: string; skipped?: boolean }
  /** エンジン: 持ち物を書き換える（フレーム・同時処理の実行中の項目・宣言） */
  | { type: 'procEngine'; frameId: string; item?: boolean; patch: Record<string, unknown> }
  /** 効果の操作 */
  | { type: 'procDamage'; damages: DamageSeed[] }
  | { type: 'procKiryoku'; iid: string; delta: number; max: number | null }
  | { type: 'procSetKiryoku'; iid: string; value: number }
  | { type: 'procOrient'; iid: string; to: 'ready' | 'rested' }
  | { type: 'procMove'; iid: string; to: 'trash' | 'hand' | 'deckTop' | 'deckBottom' | 'field' | 'battle'; orientation?: 'ready' | 'rested'; kiryoku?: number; attachItemsFrom?: string; owner?: Seat }
  | { type: 'procSwapZones'; seat: Seat; order: string[] }
  | { type: 'procDraw'; seat: Seat; n: number }
  | { type: 'procAddDowns'; seat: Seat; n: number }
  /** 効果でコストを発生させる（D21・7-3「その他の代償」として即使える。frameId 無し） */
  // useAsSeat（D20・R4a-2）＝発生させたのは seat だが、発生済みのコストは useAsSeat のものになる（《借金取り》）
  | { type: 'procGenCost'; seat: Seat; tokens: { icon: CostKind; attrs: string[] }[]; useAsSeat?: Seat }
  /** PHASE-R4b §2(D): who の発生済みのコスト（tokenIds）を払う（7-4）。giveTo があればアイコン W・属性そのままで移す。無ければ消費 */
  | { type: 'procPayCost'; seat: Seat; tokenIds: string[]; giveTo: Seat | null }
  /**
   * PHASE-R4b §2(D)・統括17の直し: payByPlayer の「発生させる」を、単独の 7-2 のコスト発生の宣言と同じ経路
   * （applyDeclare の tail・windowEnd の frame=null 分岐と同じ pushSimul→declItem→pushDeclFrame、
   * その上に [3]《コストを発生するとき》の declPhaseFrame）で積む。sources は who が選んだ発生源（0件でもよい。
   * 臨時収入などを [3] の窓で使うだけでも良いため）。declId は drive 側が発行し、genPending 段の「まだ処理中か」の
   * 判定（findFrame）に使う
   */
  | { type: 'procStartCostGen'; by: Seat; sources: CostSource[]; declId: string }
  | { type: 'procCancelDown'; frameId: string }
  /**
   * 効果の乗っ取り（hijack・D11）が「適切な対象が無い」等で失敗したとき、乗っ取りの効果自身（いただきます等）を
   * 立ち消えにする（procMeta.aborted に記録＝FAQ の fizzled 期待が拾える）。対象のフレームは今の段（enter/window/
   * engine/resume のどれでも）にかかわらず終える。abortFrame と同じ扱い（宣言 id は procMeta.aborted に残る）
   */
  | { type: 'procAbortEffect'; frameId: string; reason: string }
  | {
      type: 'procDamageEdit'
      frameId: string
      recipient?: string
      delta?: number
      all?: boolean
      /** 受け手がこのダメージを受けない（継続効果「ダメージを受けない」。15-4-2[5] の前＝身代わりの後 FAQ:1706）。値は理由 */
      prevent?: string
    }
  | { type: 'procCounter'; frameId: string }
  | { type: 'procCounterPart'; frameId: string; part: 'draw' }
  | { type: 'procTrace'; entry: ProcTrace }
  /** 状況を作る（FAQ テストの force・画面の手動）: 同時処理の効果を1つ積む */
  | { type: 'procStart'; item: Omit<SimulItem, 'status' | 'type'> }
  // ── R2b
  /** エンジン: 15-10-1[13]・15-10-2[13] フィールドに出すときの気力（呼び出し＝印刷値・タッグ＝ダメージを引き継いだ値） */
  | { type: 'procPlace'; frameId: string; kiryoku: number | null }
  /** エンジン: バトルの状態を変える（[23] 攻防の値・結果ダメージの増減・先に与える・結果をすぐ出す・中断・種目・終了時にゴミ箱送り・K13 の選んだ能力値） */
  | {
      type: 'procBattle'
      frameId: string
      values?: Record<Seat, Record<string, { atk: number; def: number; rounds?: { atk: number; def: number }[] }> | null>
      edit?: BattleEdit
      firstStrike?: { seat: Seat; key: string }
      skipActions?: boolean
      abort?: string
      battleCard?: string
      endTrash?: string
      /** K13: 隠し芸などの「各陣営が能力値を1つ選ぶ」の答え（chosenStat）。key は今は使っていない（1つだけの枠） */
      battleChoice?: { seat: Seat; key: string; value: string }
      /** 交渉売買 R4b-3a-2: [23] の交渉を1回済ませた印（二重に積まない） */
      negotiated?: boolean
      /** 交渉売買 R4b-3a-2: payByPlayer の addToBattlePaid が積む、払った数（席ごとに加算） */
      paidAdd?: { seat: Seat; amount: number }
      /** 交渉売買 R4b-3a-2（NH-21）: 結果ダメージの上限。カードの記述（battle.dmgCap）を engine が渡す */
      dmgCap?: number
      /** 漫画 R4b-3c-1: 結果ダメージを半分にする（battle.dmgHalf） */
      dmgHalf?: 'ceil'
    }
  /** K9: 参加キャラを差し替える（鬼ごっこ系「待機状態の味方キャラ全てに変更」）。previous: 'readyIfWasReady' は未実装（人が処理・報告） */
  | { type: 'procSetParticipants'; frameId: string; seat: Seat; to: string[]; exhaust: boolean; previous: 'keepState' | 'readyIfWasReady' }
  /** 効果でバトルを始める（《抜き打ち》「相手にバトルを挑む」）。[3] から */
  | { type: 'procStartBattle'; by: Seat; id: string }
  /** 効果でアイテムを移し替える（「アイテムの装備と同じ扱い」FAQ:804・2874）。17-3[11] から */
  | { type: 'procTransfer'; by: Seat; item: string; to: string; id: string }
  /**
   * 継続効果の層（K3・R3）: 層を足す・外す・中身を書き換える。エンジンの控え（bound・unusable）を置く。
   * clamp＝気力を上限まで下げる（15-4「気力は気力上限以上の値はとりません」。ダメージでも気力の減少でもない FAQ:249・4203）。
   * orient＝効果で状態を戻す（「常に消耗状態」FAQ:2476・3184）
   */
  | {
      type: 'procLayers'
      add?: LayerSeed[]
      remove?: string[]
      update?: { id: string; body: Record<string, unknown> }[]
      bound?: Record<string, string | null>
      unusable?: string[]
      reuse?: { reusable: string[]; oncePerChar: string[] }
      bar?: { challenge: string[]; any: string[]; receiveRested: string[] }
      clamp?: { iid: string; value: number }[]
      orient?: { iid: string; to: 'ready' | 'rested'; why: string }[]
    }
  /** 場の制限の是正（K12）: 選ぶ余地が無いときのゴミ箱送り（選ぶときは procChoice の purpose limitTrash） */
  | { type: 'procLimitTrash'; iids: string[]; reason: string }
  /** アイテムを付け替える（《替え玉》の交換。同時に行う）。装備の手順ではない */
  | { type: 'procAttach'; moves: { item: string; to: string }[] }
  /** 効果でキャラをダウンさせる（15-5 のダウン処理を起こす。《サクリファイス》） */
  | { type: 'procDown'; iid: string }
  /** 効果で「呼び出す」（D17・R4a-2）: kind summon のフレームを積む。fromZone＝実行時点でカードがあった場所 */
  | { type: 'procSummon'; iid: string; seat: Seat; orientation: 'ready' | 'rested'; fromZone: ZoneId }
  /** そのフェイズの段を始める（エントリー 10-4・手札調整 10-7）。エンジンの drive が出す */
  | { type: 'procPhaseStart' }
  /** フェイズを進める（10-2-2 のフェイズ終了の合意の後。ターン全体の進行は R2u） */
  | { type: 'procPhase'; to: Phase | 'ターン終了' }
  /** 積んだだけの手順を止まる点まで進める（盤面を直接作ったとき） */
  | { type: 'procRun' }
  /** 手順を捨てる（詰まったとき用・R2u §2-3）: 手順と選択と窓を空にする。メインなら drive がメインの窓から開き直す */
  | { type: 'procAbandon' }
  /** 10-2-2: AP がフェイズ終了を宣言する（フェイズの窓での AP の見送りを兼ねる）。NAP が見送る＝認める */
  | { type: 'procPhaseEnd'; by: Seat }
  /** 10-2-2: NAP がフェイズ終了の宣言を認めない（宣言は無効になり、フェイズは続く＝フェイズの窓を AP から開き直す） */
  | { type: 'procPhaseDeny'; by: Seat }

/**
 * 選択の答えが受け付けられるか。割り振り（repeat）は選択肢ごとの上限（caps）を超えられない（《サバイバル》FAQ:4109）。
 * repeat でない選択は同じ選択肢を2度選べない。（それ以外の数の確かめは呼び出し側。R2a の約束を変えない）
 */
export function validChoicePick(ch: ProcChoice, pick: string[]): boolean {
  if (!ch.repeat) return ch.kind === 'order' || new Set(pick).size === pick.length
  const count: Record<string, number> = {}
  for (const k of pick) {
    count[k] = (count[k] ?? 0) + 1
    if (ch.caps && count[k] > (ch.caps[k] ?? 0)) return false
  }
  return pick.length >= ch.min && pick.length <= ch.max
}

/** 継続効果の層の出し入れ（K3・R3）。中身は読まない */
function applyLayers(state: BoardState, a: Extract<ProcAction, { type: 'procLayers' }>, trace: ProcTrace[]): { state: BoardState; log: string } {
  let s = state
  let list = s.layers.list
  if (a.remove?.length) list = list.filter((l) => !a.remove!.includes(l.id))
  for (const u of a.update ?? []) list = list.map((l) => (l.id === u.id ? { ...l, body: u.body } : l))
  for (const seed of a.add ?? []) {
    const [s2, id] = nextId(s, 'L')
    s = s2
    const battleId = seed.until === 'battle' || seed.kind === '攻防修正' ? nearestBattle(s)?.id ?? null : null
    list = [...list, { ...seed, id, seq: s.procMeta.seq, battleId }]
    if (seed.kind && seed.ability === null) trace.push({ kind: 'name', text: `修正:${seed.targets.join(',')}:${seed.label}` })
  }
  let bound = s.layers.bound
  if (a.bound) {
    bound = { ...bound }
    for (const [k, v] of Object.entries(a.bound)) {
      if (v === null) delete bound[k]
      else bound[k] = v
    }
  }
  const unusable = a.unusable ?? s.layers.unusable
  s = { ...s, layers: { list, bound, unusable, reusable: a.reuse?.reusable ?? s.layers.reusable, oncePerChar: a.reuse?.oncePerChar ?? s.layers.oncePerChar, barChallenge: a.bar?.challenge ?? s.layers.barChallenge, barAny: a.bar?.any ?? s.layers.barAny, receiveRested: a.bar?.receiveRested ?? s.layers.receiveRested } }
  if (a.clamp?.length || a.orient?.length) {
    const cards = { ...s.cards }
    for (const c of a.clamp ?? []) {
      const k = cards[c.iid]?.kiryoku
      if (k !== null && k !== undefined && k > c.value) cards[c.iid] = { ...cards[c.iid], kiryoku: c.value }
    }
    for (const o of a.orient ?? []) {
      if (!cards[o.iid] || cards[o.iid].orientation === o.to) continue
      cards[o.iid] = { ...cards[o.iid], orientation: o.to }
      trace.push({ kind: 'name', text: `${o.to === 'rested' ? '消耗' : '待機'}（${o.why}）:${o.iid}` })
    }
    s = { ...s, cards }
  }
  return { state: s, log: '' }
}

export function applyProc(state: BoardState, action: ProcAction): ProcResult {
  const trace: ProcTrace[] = []
  const r = applyProcCore(state, action, trace)
  if (!r) return { state, log: '', trace: [] }
  const s = run(r.state, trace)
  return { state: s, log: r.log, trace }
}

function applyProcCore(state: BoardState, action: ProcAction, trace: ProcTrace[]): { state: BoardState; log: string } | null {
  switch (action.type) {
    case 'procOpenMain': {
      if (state.proc.length || state.procMeta.base || state.result) return null
      return { state: setMeta(state, { base: openWindow(null, activeSeat(state)), mainClosed: false }), log: `${state.turn?.phase === '終了' ? '終了' : 'メイン'}フェイズの宣言の機会` }
    }
    case 'procPhaseEnd': {
      if (!canDeclarePhaseEnd(state, action.by)) return null
      const b = state.procMeta.base!
      return { state: setMeta(state, { base: { ...b, state: 'awaitNonActive', phaseEnd: true } }), log: `${action.by} が${state.turn!.phase}フェイズの終了を宣言（10-2-2）` }
    }
    case 'procPhaseDeny': {
      if (!phaseEndPending(state) || action.by === activeSeat(state)) return null
      return { state: setMeta(state, { base: openWindow(null, activeSeat(state)) }), log: `${action.by} がフェイズ終了を認めない（10-2-2）` }
    }
    case 'procDeclare': {
      const s = applyDeclare(state, action.by, action.decl)
      return s ? { state: s, log: `${action.by} が「${action.decl.label}」を宣言` } : null
    }
    case 'procPass': {
      const s = applyPass(state, action.by)
      // フェイズ終了の宣言への NAP の見送り＝認める（10-2-2）
      const agreed = phaseEndPending(state) && action.by !== activeSeat(state)
      return s ? { state: s, log: agreed ? `${action.by} がフェイズ終了を認めた（10-2-2）` : `${action.by} が通した` } : null
    }
    case 'procDeclPatch': {
      const patchDecl = (d: ProcDecl | null) =>
        d && d.id === action.declId ? { ...d, targets: action.targets ?? d.targets, eng: { ...d.eng, ...(action.eng ?? {}) } } : d
      const patchWin = (w: ProcWindow | null) => (w ? { ...w, active: patchDecl(w.active), nonActive: patchDecl(w.nonActive) } : w)
      const s: BoardState = {
        ...state,
        proc: state.proc.map((f) => ({ ...f, window: patchWin(f.window) })),
        procMeta: { ...state.procMeta, base: patchWin(state.procMeta.base) },
      }
      return { state: s, log: '' }
    }
    case 'procChoice': {
      if (state.procMeta.choice) return null
      const [s, gen] = nextId(state, 'ch')
      const id = action.choice.id ?? gen
      return { state: setMeta(s, { choice: { ...action.choice, id } }), log: `${action.choice.by} が選ぶ: ${action.choice.prompt}` }
    }
    case 'procChoose': {
      const ch = state.procMeta.choice
      if (!ch || ch.id !== action.id) return null
      if (!validChoicePick(ch, action.pick)) return null
      let s = setMeta(state, { choice: null, answers: { ...state.procMeta.answers, [ch.id]: action.pick } })
      if (ch.purpose) s = applyCoreChoice(s, ch, action.pick, trace)
      else if (ch.kind === 'order' && ch.frameId) {
        const f = findFrame(s, ch.frameId)
        if (f) s = applyOrder(s, f, action.pick)
      }
      return { state: s, log: `${ch.by} が選んだ: ${action.pick.join('・') || '（なし）'}` }
    }
    case 'procTimingDone': {
      const f = findFrame(state, action.frameId)
      if (!f || f.status !== 'engine' || f.engineWhat !== 'timing') return null
      let decls = f.window ? [f.window.active, f.window.nonActive].filter((d): d is ProcDecl => d !== null) : []
      let s0 = state
      if (f.declPhase && decls.length) {
        // 7-2[3] で宣言した行動は [5]（処理の段）で処理する＝宣言に持たせる
        const { forDecl, cg } = f.declPhase
        const subs = decls
        s0 = patchDecl(s0, forDecl, (d) =>
          cg === null ? { ...d, subDecls: [...(d.subDecls ?? []), ...subs] } : { ...d, cgSubs: Object.assign([...(d.cgSubs ?? [])], { [cg]: [...(d.cgSubs?.[cg] ?? []), ...subs] }) },
        )
        decls = []
      }
      const g = findFrame(s0, f.id)!
      // 20-4[19][20][22]: 宣言があったら同じ段の機会をもう一度開く
      const battle = g.kind === 'battle' && [19, 20, 22].includes(g.step) ? { ...g.battle!, reopen: decls.length > 0 } : g.battle
      // NH-17（D15・R4a-2）: engine が「合成の宣言」（decl 付き）として渡した項目は type:'action'（14段の処理を
      // 通す＝アクション宣言の窓を持たせる）。それ以外はこれまでどおり type:'effect'
      const items: SimulItem[] = [...decls.map(declItem), ...action.items.map((it) => ({ ...it, type: (it.decl ? 'action' : 'effect') as SimulItem['type'], status: 'pending' as const }))]
      if (items.length === 0) return { state: setFrame(s0, { ...advance({ ...g, battle }), window: null }), log: '' }
      const s1 = setFrame(s0, { ...g, battle, status: 'resume', resume: 'afterTiming' })
      const label = `《${STEP_TIMINGS[f.kind][f.step]?.names.join('》《')}》の処理`
      return { state: pushSimul(s1, items, label, f.id, items.length > 1)[0], log: label }
    }
    case 'procPay': {
      const f = findFrame(state, action.frameId)
      if (!f || f.status !== 'engine' || f.engineWhat !== 'pay') return null
      const seat = f.by
      let s = setFrame(state, { ...advance(f), paid: action.ok })
      if (!action.ok) return { state: s, log: `${f.label}: 使用代償を支払えない` }
      s = { ...s, costs: { ...s.costs, [seat]: s.costs[seat].filter((t) => !action.consume.includes(t.id)) } }
      for (const iid of action.trash) s = moveTo(s, iid, 'trash')
      for (const k of action.kiryoku) {
        const c = s.cards[k.iid]
        if (c && c.kiryoku !== null) s = changeKiryoku(s, k.iid, c.kiryoku + k.delta)
      }
      for (const iid of action.down) if (onField(s.cards[iid])) s = pushDown(s, iid, f.id, null, false)
      trace.push({ kind: 'name', text: `支払い:${f.label}` })
      return { state: s, log: `${f.label}: 使用代償を支払った` }
    }
    case 'procCheck': {
      const f = findFrame(state, action.frameId)
      if (!f || f.status !== 'engine' || f.engineWhat !== 'check') return null
      if (!action.ok) return { state: abortFrame(state, f, action.reason ?? '構成要素が満たされていない', trace), log: `${f.label}: 中断（${action.reason ?? ''}）` }
      return { state: setFrame(state, advance(f)), log: '' }
    }
    case 'procEffect': {
      const f = findFrame(state, action.frameId)
      if (!f || f.status !== 'engine' || f.engineWhat !== 'effect') return null
      if (action.items.length === 0 || f.countered) return { state: setFrame(state, { ...f, status: 'done' }), log: '' }
      const s1 = setFrame(state, { ...f, status: 'resume', resume: 'advance' })
      const items = action.items.map((it) => ({ ...it, type: 'effect' as const, status: 'pending' as const }))
      return { state: pushSimul(s1, items, `${f.label} の効果`, null, items.length > 1)[0], log: '' }
    }
    case 'procItemDone': {
      const f = findFrame(state, action.frameId)
      if (!f || f.kind !== 'simul' || f.status !== 'engine') return null
      const items = f.simul!.items.map((it) => (it.status === 'running' ? { ...it, status: action.skipped ? ('skipped' as const) : ('done' as const) } : it))
      return { state: setFrame(state, { ...f, status: 'items', engineWhat: undefined, simul: { ...f.simul!, items } }), log: '' }
    }
    case 'procEngine': {
      const f = findFrame(state, action.frameId)
      if (!f) return null
      if (action.item && f.simul) {
        const items = f.simul.items.map((it) => (it.status === 'running' ? { ...it, eng: { ...it.eng, ...action.patch } } : it))
        return { state: setFrame(state, { ...f, simul: { ...f.simul, items } }), log: '' }
      }
      return { state: setFrame(state, { ...f, eng: { ...f.eng, ...action.patch } }), log: '' }
    }
    case 'procDamage': {
      const ds = action.damages.filter((d) => onField(state.cards[d.recipient]))
      if (ds.length === 0) return { state, log: '' }
      return { state: pushDamages(state, ds), log: ds.length === 1 ? `ダメージ ${ds[0].value}` : `ダメージ ${ds.length}件（同時）` }
    }
    case 'procPlace': {
      const f = findFrame(state, action.frameId)
      if (!f || f.status !== 'engine' || f.engineWhat !== 'place') return null
      return { state: placeChar(state, f, action.kiryoku, trace), log: `${f.label}: フィールドに出した` }
    }
    case 'procBattle': {
      const f = findFrame(state, action.frameId)
      if (!f || f.kind !== 'battle' || !f.battle) return null
      let b = { ...f.battle }
      let s = state
      let next: ProcFrame = f
      if (action.values) {
        if (f.status !== 'engine' || f.engineWhat !== 'battleValues') return null
        b = { ...b, values: action.values }
        next = advance({ ...f, battle: b })
        b = next.battle!
      }
      if (action.edit) {
        if (b.damage) {
          // NH-21（交渉売買・FAQ:3921）: 《ダメージ返し》などで [24] の後に結果ダメージを増やしても、上限はそのまま当てる
          let dmg = applyBattleEdit(b.damage, action.edit)
          if (b.dmgCap !== null) dmg = dmg.map((e) => (e.value > b.dmgCap! ? { ...e, value: b.dmgCap! } : e))
          b = { ...b, damage: dmg }
          trace.push({ kind: 'name', text: `結果ダメージの増減:${action.edit.seat}:${action.edit.set !== undefined ? `=${action.edit.set}` : action.edit.delta}` })
        } else b = { ...b, pendingEdits: [...b.pendingEdits, action.edit] }
      }
      if (action.firstStrike) b = { ...b, firstStrike: [...b.firstStrike, action.firstStrike] }
      if (action.skipActions) b = { ...b, skipActions: true }
      if (action.battleCard) {
        b = { ...b, battleCard: action.battleCard, cardDecided: true }
        trace.push({ kind: 'name', text: `バトル種目を決めた:${action.battleCard}` })
      }
      if (action.endTrash) b = { ...b, endTrash: [...b.endTrash, action.endTrash] }
      if (action.battleChoice) {
        b = action.battleChoice.key === 'atk' || action.battleChoice.key === 'def'
          ? { ...b, statPick: { ...b.statPick, [action.battleChoice.key]: action.battleChoice.value } }
          : { ...b, battleChoices: { ...b.battleChoices, [action.battleChoice.seat]: action.battleChoice.value } }
        trace.push({ kind: 'name', text: `選んだ能力値:${action.battleChoice.seat}:${action.battleChoice.value}` })
      }
      if (action.negotiated) b = { ...b, negotiated: true }
      if (action.paidAdd) {
        b = { ...b, paid: { ...b.paid, [action.paidAdd.seat]: b.paid[action.paidAdd.seat] + action.paidAdd.amount } }
        trace.push({ kind: 'name', text: `払った合計:${action.paidAdd.seat}:${b.paid[action.paidAdd.seat]}` })
      }
      if (action.dmgCap !== undefined) b = { ...b, dmgCap: action.dmgCap }
      if (action.dmgHalf !== undefined) b = { ...b, dmgHalf: action.dmgHalf }
      if (action.abort && !b.aborted) {
        b = { ...b, aborted: action.abort }
        trace.push({ kind: 'abort', text: `バトル中断: ${action.abort}`, id: f.decl?.id })
      }
      s = setFrame(s, { ...next, battle: b })
      return { state: s, log: '' }
    }
    case 'procSetParticipants': {
      // K9: 鬼ごっこ系「バトル参加キャラを待機状態の味方キャラ全てに変更して消耗させる」。変更前のキャラは待機状態には
      // 戻らない（previous 'keepState'。何もしない＝そのまま）。'readyIfWasReady' は根拠になるカードがプールに無く未実装
      const f = findFrame(state, action.frameId)
      if (!f || f.kind !== 'battle' || !f.battle) return null
      const b = f.battle
      if (action.previous === 'readyIfWasReady') trace.push({ kind: 'manual', text: '人が処理: previous:readyIfWasReady は未実装（K9・報告）' })
      let cards = state.cards
      if (action.exhaust) {
        cards = { ...cards }
        for (const iid of action.to) if (cards[iid]) cards[iid] = { ...cards[iid], orientation: 'rested' }
      }
      // iid はそれぞれ独立した ':' 区切りの段にする（画面の toPublicSteps が段ごとに1個の iid しか拾えないため。
      // 「,」で1段に複数 iid を詰めると画面がカード名に置き換えられず iid のまま出てしまう＝R4b-2c 🔸1）
      trace.push({ kind: 'name', text: action.to.length ? `参加キャラを変更:${action.seat}:${action.to.join(':')}` : `参加キャラを変更:${action.seat}:無し` })
      const s = { ...state, cards }
      return { state: setFrame(s, { ...f, battle: { ...b, participants: { ...b.participants, [action.seat]: action.to }, decided: { ...b.decided, [action.seat]: action.to.length > 0 } } }), log: '' }
    }
    case 'procStartBattle': {
      const decl = battleDecl(action.id, action.by)
      return { state: pushDeclFrame(state, decl), log: `${action.by} がバトルを挑んだ` }
    }
    case 'procTransfer': {
      const item = state.cards[action.item]
      if (!item || !item.attachedTo || !onField(state.cards[action.to])) return { state, log: '' }
      const decl: ProcDecl = { id: action.id, by: action.by, kind: 'equip', actionType: '割込型', label: `移し替え:${item.cardId}`, sourceIid: item.iid, targets: [action.to], costGens: [], sources: [], trigger: null, usageKey: null, eng: { cardId: item.cardId }, equipTo: action.to }
      return { state: pushDeclFrame(state, decl, { step: 11, transfer: true }), log: `${item.cardId} を移し替える` }
    }
    case 'procLayers':
      return applyLayers(state, action, trace)
    case 'procLimitTrash':
      return { state: limitTrash(state, action.iids, trace), log: `場の制限を満たすためにゴミ箱送り（${action.reason}）` }
    case 'procAttach': {
      // 同時に付け替える。付け替えたアイテムは装備の順の一番最後（FAQ:1484）
      for (const m of action.moves) if (!state.cards[m.item]?.attachedTo || !state.cards[m.to]) return null
      const cards = { ...state.cards }
      for (const m of action.moves) {
        const last = Object.values(cards).filter((c) => c.attachedTo === m.to).reduce((a, c) => Math.max(a, c.index), 99)
        cards[m.item] = { ...cards[m.item], attachedTo: m.to, index: last + 1 }
        trace.push({ kind: 'name', text: `付け替え:${m.item}→${m.to}` })
      }
      return { state: { ...state, cards }, log: 'アイテムを付け替えた' }
    }
    case 'procDown': {
      if (!onField(state.cards[action.iid])) return { state, log: '' }
      return { state: pushDown(state, action.iid, null, null, false), log: 'ダウンさせた' }
    }
    case 'procSummon': {
      // D17: 効果で「呼び出す」。kind summon のフレームを積む（宣言[1]〜[5]は経ない・down と同じ軽い形）
      const s = pushFrame(
        state,
        { kind: 'summon', step: 1, status: 'enter', window: null, by: action.seat, label: `呼び出し（効果）:${action.iid}`, summon: { iid: action.iid, seat: action.seat, orientation: action.orientation, fromZone: action.fromZone }, eng: {} },
        'summon',
      )[0]
      return { state: s, log: `${action.iid} を呼び出す（効果）` }
    }
    case 'procRun':
      return state.proc.length ? { state, log: '' } : null
    case 'procAbandon':
      // 【決めたこと】どのフェイズで捨ててもそのターンのメインの窓から（PHASE-R2u §2-3 の文のまま。エントリーをやり直すとドローが重なるため）
      // メインの窓（[2]）から: ターンの番号がある盤面は [1] をやり直さない（R2u-2）
      return { state: setMeta({ ...state, proc: [], turn: state.turn ? { ...state.turn, phase: 'メイン' } : null }, { choice: null, base: null, mainClosed: false, phaseRun: state.turn?.n !== undefined ? MAIN_ACTIONS : null }), log: '手順を捨てた' }
    case 'procPhaseStart': {
      const ph = state.turn?.phase
      if (state.proc.length || !ph || state.procMeta.phaseRun !== null) return null
      const kind: ProcKind | null = ph === 'エントリー' ? 'entry' : ph === 'メイン' ? 'mainPhase' : ph === '終了' ? 'endPhase' : ph === '手札調整' ? 'handAdjust' : null
      if (!kind) return null
      const s = setMeta(state, { phaseRun: ph, base: null })
      return { state: pushFrame(s, { kind, step: 1, status: 'enter', window: null, by: activeSeat(s), label: `${ph}フェイズ`, eng: {} }, 'phase')[0], log: `${ph}フェイズ` }
    }
    case 'procPhase': {
      if (state.proc.length || !state.turn) return null
      if (action.to === 'ターン終了') {
        const s = setMeta(state, { phaseRun: 'ターン終了', base: null })
        return { state: pushFrame(s, { kind: 'turnEnd', step: 1, status: 'enter', window: null, by: activeSeat(s), label: 'ターン終了', eng: {} }, 'phase')[0], log: 'ターン終了' }
      }
      return { state: setMeta({ ...state, turn: { ...state.turn, phase: action.to } }, { phaseRun: null, base: null, mainClosed: false }), log: `${action.to}フェイズへ` }
    }
    case 'procKiryoku': {
      const c = state.cards[action.iid]
      if (!c || c.kiryoku === null) return { state, log: '' }
      let v = c.kiryoku + action.delta
      if (action.delta > 0 && action.max !== null) v = Math.max(c.kiryoku, Math.min(v, action.max)) // 15-4: 上限を超えた分は無視
      trace.push({ kind: 'name', text: `気力:${action.iid}:${action.delta > 0 ? '+' : ''}${action.delta}` })
      return { state: changeKiryoku(state, action.iid, v), log: `気力 ${action.delta > 0 ? '+' : ''}${action.delta}` }
    }
    case 'procSetKiryoku': {
      const c = state.cards[action.iid]
      if (!c || c.kiryoku === null) return { state, log: '' }
      trace.push({ kind: 'name', text: `気力を${action.value}にする:${action.iid}` })
      return { state: changeKiryoku(state, action.iid, action.value), log: `気力を ${action.value} にした` }
    }
    case 'procOrient': {
      const c = state.cards[action.iid]
      if (!c) return { state, log: '' }
      trace.push({ kind: 'name', text: action.to === 'rested' ? '消耗' : '待機' })
      return { state: { ...state, cards: { ...state.cards, [c.iid]: { ...c, orientation: action.to } } }, log: action.to === 'rested' ? '消耗させた' : '待機状態に戻した' }
    }
    case 'procMove': {
      const c = state.cards[action.iid]
      if (!c) return { state, log: '' }
      let s = state
      if (action.to === 'field') {
        s = moveCard(s, { iid: c.iid, toOwner: c.owner, toZone: 'char', cardName: c.cardId }).state
        const moved = s.cards[c.iid]
        s = { ...s, cards: { ...s.cards, [c.iid]: { ...moved, orientation: action.orientation ?? 'ready', kiryoku: action.kiryoku ?? moved.kiryoku, attachedTo: null } } }
        if (action.attachItemsFrom) {
          for (const item of Object.values(s.cards)) {
            if (item.attachedTo === action.attachItemsFrom) s = { ...s, cards: { ...s.cards, [item.iid]: { ...item, attachedTo: c.iid } } }
          }
        }
      } else if (action.to === 'battle') {
        // バトルカードを自分のフィールドに「出す」（配置のアクション 19-2 ではない。《虎の子バトル》）
        s = moveCard(s, { iid: c.iid, toOwner: action.owner ?? c.owner, toZone: 'battle', cardName: c.cardId }).state
        s = { ...s, cards: { ...s.cards, [c.iid]: { ...s.cards[c.iid], used: false, orientation: 'ready', attachedTo: null } } }
      } else if (action.to === 'deckTop' || action.to === 'deckBottom') {
        s = moveTo(s, c.iid, 'deck', { index: action.to === 'deckTop' ? 'top' : 'bottom' })
      } else s = moveTo(s, c.iid, action.to)
      trace.push({ kind: 'name', text: `移動:${action.iid}:${action.to}` })
      return { state: s, log: `${c.cardId} を移した` }
    }
    case 'procSwapZones': {
      // ゴミ箱とデッキを入れ替える（《輪廻》）。order＝新しいデッキの並び（呼び出し側が混ぜた順）
      let s = state
      const deck = cardsInZone(s, action.seat, 'deck').map((c) => c.iid)
      const trash = cardsInZone(s, action.seat, 'trash').map((c) => c.iid)
      for (const iid of deck) s = moveCard(s, { iid, toZone: 'trash', cardName: '' }).state
      const order = action.order.filter((iid) => trash.includes(iid))
      for (const iid of [...order, ...trash.filter((x) => !order.includes(x))]) s = moveCard(s, { iid, toZone: 'deck', cardName: '' }).state
      trace.push({ kind: 'name', text: 'ゴミ箱とデッキを入れ替えた' })
      return { state: s, log: 'ゴミ箱とデッキを入れ替えた' }
    }
    case 'procDraw': {
      let s = state
      for (let i = 0; i < action.n && !s.result; i++) s = drawCard(s, action.seat)
      trace.push({ kind: 'name', text: `ドロー:${action.seat}:${action.n}` })
      return { state: s, log: `${action.seat} が ${action.n} 枚ドロー` }
    }
    case 'procAddDowns': {
      // 「勝利条件を＋１」（9-2-1）: ダウン処理[3] ではない＝割り込み側の結果なので即座に数え、即座に判定する（H-12 ②）
      const s: BoardState = { ...state, downs: { ...state.downs, [action.seat]: state.downs[action.seat] + action.n } }
      trace.push({ kind: 'name', text: `勝利条件+${action.n}:${action.seat}` })
      return { state: checkEnd(s, '勝利条件（9-2）'), log: `${action.seat} のダウン数 +${action.n}` }
    }
    case 'procGenCost': {
      // D21: 効果でコストを発生させる。得たコストは frameId 無し＝すぐ「その他の代償」として使える（7-3）。
      // D20: useAsSeat があれば、発生させた席（action.seat）ではなく useAsSeat の発生済みのコストになる（《借金取り》）
      let s = state
      const bucket = action.useAsSeat ?? action.seat
      const tokens = [...s.costs[bucket]]
      for (const t of action.tokens) {
        const [s2, id] = nextId(s, 'cost')
        s = s2
        tokens.push({ id, icon: t.icon, attrs: t.attrs, frameId: null })
      }
      s = { ...s, costs: { ...s.costs, [bucket]: tokens } }
      trace.push({ kind: 'name', text: `コスト発生（効果）:${action.tokens.map((x) => x.icon + x.attrs.join('')).join('')}` })
      return { state: s, log: `${action.seat} に発生したコスト +${action.tokens.map((x) => x.icon).join('')}` }
    }
    case 'procPayCost': {
      // PHASE-R4b §2(D): 発生済みのコストを払う（7-4）。giveTo があれば W・属性そのままで移す（FAQ:1341・1344）
      const pool = state.costs[action.seat]
      const paying = pool.filter((t) => action.tokenIds.includes(t.id))
      if (paying.length !== action.tokenIds.length) return null
      let s: BoardState = { ...state, costs: { ...state.costs, [action.seat]: pool.filter((t) => !action.tokenIds.includes(t.id)) } }
      if (action.giveTo) {
        const bucket = [...s.costs[action.giveTo]]
        for (const t of paying) {
          const [s2, id] = nextId(s, 'cost')
          s = s2
          bucket.push({ id, icon: 'W', attrs: t.attrs, frameId: null })
        }
        s = { ...s, costs: { ...s.costs, [action.giveTo]: bucket } }
      }
      trace.push({ kind: 'name', text: `コストを払う:${action.seat}${action.giveTo ? `→${action.giveTo}` : '（消費）'}` })
      return { state: s, log: `${action.seat} が発生済みのコストを払う` }
    }
    case 'procStartCostGen': {
      // 統括17の直し: 単独の 7-2 のコスト発生の宣言と同じ経路（applyDeclare の tail・windowEnd の frame=null
      // 分岐と同じ pushSimul→declItem→pushDeclFrame、その上に [3] の declPhaseFrame）で積む
      const decl: ProcDecl = {
        id: action.declId,
        by: action.by,
        kind: 'costGen',
        actionType: '割込型',
        label: 'コスト発生（払うために who が発生させる）',
        sourceIid: null,
        targets: [],
        costGens: [],
        sources: action.sources,
        trigger: nearestActionFrame(state),
        usageKey: null,
        eng: {},
      }
      let s = pushSimul(state, [declItem(decl)], 'コスト発生（払うために発生させる。7-2）', null, false)[0]
      s = { ...s, proc: [...s.proc, declPhaseFrame(decl, null)] }
      trace.push({ kind: 'name', text: `コスト発生の宣言:${action.by}` })
      return { state: s, log: `${action.by} がコストを発生させる（7-2）` }
    }
    case 'procCancelDown': {
      const f = findFrame(state, action.frameId)
      if (!f || f.kind !== 'down') return null
      trace.push({ kind: 'name', text: `ダウンしない:${f.down!.iid}` })
      return { state: setFrame(state, { ...f, down: { ...f.down!, canceled: true } }), log: 'ダウンしない' }
    }
    case 'procAbortEffect': {
      const f = findFrame(state, action.frameId)
      if (!f) return null
      return { state: abortFrame(state, f, action.reason, trace), log: `${f.label}: ${action.reason}` }
    }
    case 'procDamageEdit': {
      const f = findFrame(state, action.frameId)
      if (!f || f.kind !== 'damage') return null
      const d = f.damage!
      let s = state
      if (action.prevent) {
        trace.push({ kind: 'name', text: `受けない:${d.recipient}:${action.prevent}` })
        return { state: setFrame(s, { ...f, status: 'done', window: null }), log: `ダメージを受けない（${action.prevent}）` }
      }
      if (action.recipient && action.recipient !== d.recipient) {
        trace.push({ kind: 'name', text: `受け手の差し替え:${d.recipient}→${action.recipient}` })
        s = setFrame(s, { ...f, damage: { ...d, recipient: action.recipient, rerun: true, origRecipient: d.origRecipient ?? d.recipient } })
      }
      if (action.delta) {
        const g = findFrame(s, f.id)!
        s = setFrame(s, { ...g, damage: { ...g.damage!, value: g.damage!.value + action.delta } })
        trace.push({ kind: 'name', text: `ダメージ${action.delta > 0 ? '+' : ''}${action.delta}` })
        if (action.all && d.group) {
          const grp = findFrame(s, d.group)
          if (grp?.simul) {
            // 「１つの発生元の同時に発生したダメージすべて」（FAQ:3461: お互いのバトルの結果ダメージは発生元が別）
            const sameSource = (x: DamageSeed) => x.dealerIid === d.dealerIid && x.dealerSeat === d.dealerSeat
            const items = grp.simul.items.map((it) => (it.type === 'damage' && it.status === 'pending' && sameSource(it.damage!) ? { ...it, damage: { ...it.damage!, value: it.damage!.value + action.delta! } } : it))
            s = setFrame(s, { ...grp, simul: { ...grp.simul, items } })
          }
        }
      }
      return { state: s, log: '' }
    }
    case 'procCounter': {
      const f = findFrame(state, action.frameId)
      if (f && (f.kind === 'ability' || f.kind === 'event')) {
        trace.push({ kind: 'name', text: `打ち消す:${f.label}` })
        return { state: setFrame(state, { ...f, countered: true }), log: `「${f.label}」の効果を打ち消した` }
      }
      // まだ処理されていない宣言（同時処理の待ち・窓の中）
      let found = ''
      const mark = (d: ProcDecl | null | undefined) => (d && d.id === action.frameId ? ((found = d.label), { ...d, countered: true }) : d)
      const proc = state.proc.map((fr) => ({
        ...fr,
        window: fr.window ? { ...fr.window, active: mark(fr.window.active) ?? null, nonActive: mark(fr.window.nonActive) ?? null } : null,
        simul: fr.simul ? { ...fr.simul, items: fr.simul.items.map((it) => (it.decl ? { ...it, decl: mark(it.decl)! } : it)) } : fr.simul,
      }))
      if (!found) return null
      trace.push({ kind: 'name', text: `打ち消す:${found}` })
      return { state: { ...state, proc }, log: `「${found}」の効果を打ち消した` }
    }
    case 'procCounterPart': {
      // D23: 部分的な打ち消し（おあずけ）。frame 全体は countered にせず、counterPart を控える。
      // 対象のフレームは（割り込み側の窓を開いている）今の proc スタックに既にあるはず
      const f = findFrame(state, action.frameId)
      if (!f || (f.kind !== 'ability' && f.kind !== 'event')) return null
      trace.push({ kind: 'name', text: `部分的に打ち消す（${action.part}）:${f.label}` })
      return { state: setFrame(state, { ...f, counterPart: action.part }), log: `「${f.label}」の一部（${action.part}）を打ち消した` }
    }
    case 'procTrace':
      trace.push(action.entry)
      return { state, log: action.entry.text }
    case 'procStart': {
      const items: SimulItem[] = [{ ...action.item, type: 'effect', status: 'pending' }]
      return { state: pushSimul(state, items, action.item.label, null, false)[0], log: action.item.label }
    }
  }
}
