// バトルの状態機械（core専用・カード知識ゼロ）。DESIGN.md §5.2（バトルの多段フロー）/ PHASE3d-1.md / PHASE3d-2a.md。
// バトル全体で1アクション（原典20-1）。原典20-4の29ステップの「立ち止まる点」を `at` として直接持つ
// （PHASE3d-2a §1）。7段（`step`）は表示・detectAbort用に残すが、常に `at` から一意に決まる（不変条件）。
// 効果の解決・合法性判定は一切扱わない（DESIGN §5「あえて作らない」）。乱数・時刻は持たない。
// 優先権（priority.ts）の窓を開く/閉じる自動進行は `battleFlow.ts` が担当する（このファイルは窓を知らない）。
//
// 🚨 BoardState.battle: Battle | null を持つため board.ts と型だけ循環参照する
// （board.ts は type-only import。priority.ts⇄board.ts で既に同じ形が前例）。
// battle.ts → board.ts はランタイムでも import する（cardsInZone/setUsed/setOrientation/adjustKiryoku等を使うため）が、
// 向きが逆なので循環にはならない。

import { adjustKiryoku, cardsInZone, setOrientation, setUsed, type BoardState, type CardInstance, type Seat } from './board'

/** 7段（DESIGN.md §5.2）。括弧内は原典20-4のステップ番号。表示用・detectAbort用に残す。常に `at` から決まる */
export type BattleStep =
  | '宣言' // [1-5]  宣言→相手の同時アクション→《バトルを挑まれたとき》→中断判定
  | '挑んだ側キャラ指定' // [6-9]
  | '挑まれた側キャラ指定' // [10-14]
  | '種目決定' // [15-18]
  | 'バトル中アクション' // [19-22]
  | '結果' // [23-27]
  | '終了' // [28-29]

export interface Battle {
  /** 挑んだ側。🚨 activePlayer とは限らない（20-1: 相手のアクションの同時アクションとして宣言できる） */
  challenger: Seat
  /** 原典20-4の「立ち止まる点」のステップ番号（PHASE3d-2a §1の表）。進行はこちらで管理する */
  at: number
  /** 7段。常に `at` から決まる（不変条件・テストする） */
  step: BattleStep
  /** 参加キャラ（iid）。🚨 配列。各陣営1体が基本だが、複数参加を強制するカードが実在する（§5.2・C-1） */
  participants: { A: string[]; B: string[] }
  /** 🚨 自動リーダー参加で埋まった側は true。「指定した」ことにならず、参加に対する効果が乗らない（20-8） */
  autoLeader: { A: boolean; B: boolean }
  /** バトル種目にしたバトルカードの iid */
  battleCardIid: string | null
  /** 攻撃/防御能力値。このフェーズでは人間が入れる（自動計算は別フェーズ） */
  atk: { A: number | null; B: number | null }
  def: { A: number | null; B: number | null }
  /** [21]で[19]に戻った回数。千日手（13-3-2）の検知用に数えるだけ */
  loopCount: number
  /**
   * 🚨 差し戻し対応（2026-09-23）: [26]でバトルの結果によってダウンした参加キャラのiid。
   * detectAbortが「20-6括弧書き（バトルの結果でダウンした場合を除く）」を判定するための、
   * 原因そのものの記録。段（step）で代用してはいけない（[23]-[27]の"結果"段には[25]にも
   * 窓＝アクション宣言の機会があり、その効果で参加キャラが失われた場合は段が同じ'結果'でも
   * 中断すべきだから。PHASE3d-1-差し戻し.md §2）。
   * PHASE3d-2a: applyDamage が [26] の適用時にここへ積む（§4）。
   */
  resultDowned: string[]
  /** 中断された（[28]は行うが[29]は行わない・20-6-1） */
  aborted: boolean
  /** 中断の理由（ログ用。ルール判定には使わない） */
  abortReason: string | null
}

export interface BattleResult {
  battle: Battle
  log: string
}

export interface BattleStateResult {
  state: BoardState
  battle: Battle
  log: string
}

export function other(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

/**
 * isValidBattleShape: 現行shape（`at` フィールドを持つ）の Battle かどうか。
 * 旧state（P3d-1・`at` 導入前）の battle を読み込み時に null へ正規化するために使う
 * （ui/board/useBoard.ts の normalizeBattle。normalizePriority と同じ流儀。PHASE3d-2a §6）。
 */
export function isValidBattleShape(battle: unknown): boolean {
  return typeof battle === 'object' && battle !== null && 'at' in battle
}

/**
 * 原典20-4を逐語で数えた「立ち止まる点」の進行順（PHASE3d-2a §1の表のat列）。
 * [21]は loopBack で at=19 に戻れる（このシーケンス上の遷移ではない。§2-3）。
 */
export const AT_SEQUENCE: readonly number[] = [2, 4, 6, 7, 8, 10, 11, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29]

/** 窓（優先権の窓を開く点）。14個。`_local/原典照合-バトル.md`「窓の実数」表と一致させてある */
export const WINDOW_ATS: readonly number[] = [2, 4, 6, 8, 10, 13, 15, 17, 19, 20, 22, 25, 27, 29]

/** 行動の点（人間が操作して「次へ」または専用アクションを行う） */
export const ACTION_ATS: readonly number[] = [7, 11, 16, 18, 21, 23, 26, 28]

/** [19][20][22]は反復する窓（宣言があれば同じ点を開き直す。§2-2） */
export const REPEATING_WINDOW_ATS: readonly number[] = [19, 20, 22]

/**
 * 各点の表示用ラベル（PHASE3d-2a §1 の表。原典20-4 `oldrule.txt:1062-1127`）。
 * 🚨 表示専用。判定には使わない（P3d-2b がバトルパネルに出す）。
 */
export const AT_LABELS: Record<number, string> = {
  2: '相手の同時アクションの宣言の機会',
  4: '《バトルを挑まれたとき》',
  6: '《バトルに参加するとき》《バトルを挑むとき》《バトルを挑むキャラを選ぶとき》',
  7: '挑んだ側が参加キャラを指定（その後消耗させる）',
  8: '《バトルに参加したとき》《バトルを挑んだとき》《バトルを挑むキャラを選んだとき》',
  10: '《バトルに参加するとき》《バトルを受けるとき》《バトルを受けるキャラを選ぶとき》',
  11: '挑まれた側が参加キャラを指定（その後消耗させる）／指定できなければリーダーが自動参加',
  13: '《バトルに参加したとき》《バトルを受けたとき》《バトルを受けるキャラを選んだとき》',
  15: '《バトルカードを選択するとき》',
  16: 'バトルカードを1枚指定',
  17: '《バトルカードを選択したとき》《バトルを選択したとき》',
  18: 'バトルカードの効果を適用・攻防能力値を算出',
  19: '挑んだ側が特殊能力を1回／お互いがイベントを複数回',
  20: '挑まれた側が特殊能力を1回／お互いがイベントを複数回',
  21: '挑んだ側が[19]に戻るか進むかを選ぶ',
  22: '挑んだ側が特殊能力を1回／お互いがイベントを複数回',
  23: '攻撃・防御能力値の決定／結果の計算',
  25: '《バトルの結果の計算をしたとき》',
  26: '必要ならばダメージ処理、ダウン処理',
  27: '《バトルの結果を出したとき》',
  28: 'バトル終了時の処理（攻防修正を失わせる／《バトル終了時》《バトル終了時まで》）',
  29: '《バトル終了後》《バトルが終了したとき》',
}

const AT_STEP: Record<number, BattleStep> = {
  2: '宣言',
  4: '宣言',
  6: '挑んだ側キャラ指定',
  7: '挑んだ側キャラ指定',
  8: '挑んだ側キャラ指定',
  10: '挑まれた側キャラ指定',
  11: '挑まれた側キャラ指定',
  13: '挑まれた側キャラ指定',
  15: '種目決定',
  16: '種目決定',
  17: '種目決定',
  18: '種目決定',
  19: 'バトル中アクション',
  20: 'バトル中アクション',
  21: 'バトル中アクション',
  22: 'バトル中アクション',
  23: '結果',
  25: '結果',
  26: '結果',
  27: '結果',
  28: '終了',
  29: '終了',
}

/** `at` から `step` を決める（不変条件の唯一の正）。未知の at は例外を投げる（防御的） */
export function stepForAt(at: number): BattleStep {
  const step = AT_STEP[at]
  if (!step) throw new Error(`battle.ts: 未知の at=${at}`)
  return step
}

export function isWindowAt(at: number): boolean {
  return WINDOW_ATS.includes(at)
}

export function isActionAt(at: number): boolean {
  return ACTION_ATS.includes(at)
}

/** AT_SEQUENCE上で現在の次の点を返す。現在が末尾（29）なら null */
export function nextAt(at: number): number | null {
  const idx = AT_SEQUENCE.indexOf(at)
  if (idx === -1 || idx === AT_SEQUENCE.length - 1) return null
  return AT_SEQUENCE[idx + 1]
}

/**
 * canDeclareBattle: バトルを宣言できるか（20-3）。理由を返す純関数（null＝宣言できる）。
 * P3d-2b がボタンの説明に使う（PHASE3d-2a §6）。
 */
export function canDeclareBattle(state: BoardState, seat: Seat): string | null {
  if (state.battle !== null) return 'すでにバトルが進行中（2本目はフリーモードで処理する。DESIGN §5.2 C-2）'
  if (state.priority !== null) return '優先権の処理中はバトルを宣言できない'

  const anyUnusedBattleCard = (['A', 'B'] as const).some((s) =>
    cardsInZone(state, s, 'battle').some((c) => c.used !== true),
  )
  if (!anyUnusedBattleCard) return '選択可能なバトルカードがどちらのフィールドにも無い（20-3 oldrule.txt:1060）'

  // ⚠️ リーダーを数えるかは原典が明言していない。寛容側（数える）に倒す（PHASE3d-2a §6）
  const readyChar = [...cardsInZone(state, seat, 'char'), ...cardsInZone(state, seat, 'leader')].some(
    (c) => c.orientation === 'ready',
  )
  if (!readyChar) return '自分のフィールドに待機状態のキャラがいない（20-3 oldrule.txt:1061）'

  return null
}

/**
 * declareBattle: 宣言。バトルを開始する（20-1「バトル全体で１アクションと扱われます」）。
 * 受理条件（canDeclareBattle）は呼び出し側（actions.ts）が先に確認する。ここでは無条件に組み立てるだけ。
 * 受理したら at=2（20-4[2] 相手プレイヤーの、同時アクションの宣言の機会）。窓を開くのは battleFlow.ts。
 */
export function declareBattle(challenger: Seat): BattleResult {
  const battle: Battle = {
    challenger,
    at: 2,
    step: stepForAt(2),
    participants: { A: [], B: [] },
    autoLeader: { A: false, B: false },
    battleCardIid: null,
    atk: { A: null, B: null },
    def: { A: null, B: null },
    loopCount: 0,
    resultDowned: [],
    aborted: false,
    abortReason: null,
  }
  return { battle, log: `${challenger} がバトルを宣言した` }
}

/**
 * advanceStep: 次の点(at)へ進む（AT_SEQUENCE順）。純粋関数・モード/優先権を一切見ない
 * （「窓の点でだけ有効／priority===nullのときだけ」等のゲートは actions.ts 側の責務。PHASE3d-2a §2-3）。
 * 🚨 前提（状態の前提であってルールの強制ではない）が満たされていなければ進めない。log を空で返して状態を変えない。
 */
export function advanceStep(battle: Battle): BattleResult {
  const next = nextAt(battle.at)
  if (next === null) return { battle, log: '' } // at=29は末尾（これ以上進まない。窓が閉じたらbattleFlowがbattle=nullにする）

  if (battle.at === 7 && battle.participants[battle.challenger].length === 0) {
    return { battle, log: '' }
  }
  if (battle.at === 11 && battle.participants[other(battle.challenger)].length === 0) {
    return { battle, log: '' }
  }
  if (battle.at === 16 && battle.battleCardIid === null) {
    return { battle, log: '' }
  }
  if (battle.at === 23) {
    const allSet =
      typeof battle.atk.A === 'number' &&
      typeof battle.atk.B === 'number' &&
      typeof battle.def.A === 'number' &&
      typeof battle.def.B === 'number'
    if (!allSet) return { battle, log: '' }
  }

  return { battle: { ...battle, at: next, step: stepForAt(next) }, log: `バトル: [${battle.at}] → [${next}]` }
}

/** setParticipants: 参加キャラを指定する（20-4[7][11]）。人が指定し直した＝autoLeaderをfalseに戻す（20-8） */
export function setParticipants(battle: Battle, seat: Seat, iids: string[]): BattleResult {
  return {
    battle: {
      ...battle,
      participants: { ...battle.participants, [seat]: iids },
      autoLeader: { ...battle.autoLeader, [seat]: false },
    },
    log: `${seat} の参加キャラを指定した（${iids.length}体）`,
  }
}

/**
 * autoAssignLeader: 待機キャラが無いときリーダーを自動参加させる（20-4[12] / 20-8）。
 * 待機キャラ（zone='char' かつ orientation='ready'）が1体でもいれば何もしない（人間が選ぶ）。
 * リーダーが見つからない場合も何もしない（想定外の盤面。防御的に無視する）。
 * 🚨 PHASE3d-2a §3: リーダーが待機状態であれば消耗させる（20-4[12] oldrule.txt:1088）。
 *   setBattleCard と同じ理由で state も一緒に返す（board.setOrientation を呼ぶため）。
 */
export function autoAssignLeader(board: BoardState, battle: Battle, seat: Seat): BattleStateResult {
  const waiting = cardsInZone(board, seat, 'char').filter((c) => c.orientation === 'ready')
  if (waiting.length > 0) return { state: board, battle, log: '' }

  const leader = cardsInZone(board, seat, 'leader')[0]
  if (!leader) return { state: board, battle, log: '' }

  let nextState = board
  let restLog = ''
  if (leader.orientation === 'ready') {
    const rested = setOrientation(nextState, { iid: leader.iid, orientation: 'rested', cardName: leader.cardId })
    nextState = rested.state
    restLog = rested.log
  }

  const nextBattle: Battle = {
    ...battle,
    participants: { ...battle.participants, [seat]: [leader.iid] },
    autoLeader: { ...battle.autoLeader, [seat]: true },
  }
  const log = `${seat} は待機キャラが無いためリーダーが自動参加した（20-8）` + (restLog ? `／${restLog}` : '')
  return { state: nextState, battle: nextBattle, log }
}

/**
 * forceAutoLeader: 待機キャラがいても強制で[12]を適用する（PHASE3d-2a §3）。
 * 全員が効果で参加できない場合の逃げ道。参加できるかどうかは人が判断する（ルールエンジンにしない）。
 */
export function forceAutoLeader(board: BoardState, battle: Battle, seat: Seat): BattleStateResult {
  const leader = cardsInZone(board, seat, 'leader')[0]
  if (!leader) return { state: board, battle, log: '' }

  let nextState = board
  let restLog = ''
  if (leader.orientation === 'ready') {
    const rested = setOrientation(nextState, { iid: leader.iid, orientation: 'rested', cardName: leader.cardId })
    nextState = rested.state
    restLog = rested.log
  }

  const nextBattle: Battle = {
    ...battle,
    participants: { ...battle.participants, [seat]: [leader.iid] },
    autoLeader: { ...battle.autoLeader, [seat]: true },
  }
  const log = `${seat} は強制的にリーダーを参加させた（20-4[12]）` + (restLog ? `／${restLog}` : '')
  return { state: nextState, battle: nextBattle, log }
}

/**
 * setBattleCard: 種目を決め、そのカードを used=true にする（20-4[16][18]）。
 * 🚨 card.used は BoardState.cards 側のフィールドなので、board.ts への board.ts:setUsed() を
 * 呼んで state も一緒に返す（このファイルの他の関数と違い state も返す唯一の関数…ではなく、
 * autoAssignLeader/forceAutoLeader/applyDamage も同じ形になった。PHASE3d-2a）。
 * カードが存在しない場合は何もしない（防御的。log 空で state/battle とも不変）。
 */
export function setBattleCard(
  state: BoardState,
  battle: Battle,
  iid: string,
  cardName: string = iid,
): BattleStateResult {
  const used = setUsed(state, { iid, used: true, cardName })
  if (!used.log) return { state, battle, log: '' }
  return { state: used.state, battle: { ...battle, battleCardIid: iid }, log: used.log }
}

/**
 * setValue: 攻撃/防御能力値を入れる（20-4[23]）。
 * 🚨 P3d-3: `null` ＝ 自動（UI が battleValues.ts で算出して表示）／数値 ＝ 人が入れた値（手入力）。
 * `null` を渡すと「自動に戻す」になる。
 */
export function setValue(battle: Battle, seat: Seat, stat: 'atk' | 'def', value: number | null): BattleResult {
  const label = stat === 'atk' ? '攻撃' : '防御'
  return {
    battle: { ...battle, [stat]: { ...battle[stat], [seat]: value } },
    log: value === null ? `${seat} の${label}能力値を自動に戻した` : `${seat} の${label}能力値を ${value} にした`,
  }
}

/**
 * decideBattleValues: [23]で攻防4値を一括で確定し、at=25へ進める（P3d-3 §2-3）。
 * 🚨 at===23のときだけ有効（それ以外はno-op・log空）。core はカードを知らないまま、[23]で値が確定する
 * （1回のdispatch＝Undoも1回）。ゲートはactions.ts側（assistでpriority!==nullならno-op）。
 */
export function decideBattleValues(
  battle: Battle,
  values: { atk: { A: number; B: number }; def: { A: number; B: number } },
): BattleResult {
  if (battle.at !== 23) return { battle, log: '' }
  const withValues: Battle = { ...battle, atk: { ...values.atk }, def: { ...values.def } }
  const advanced = advanceStep(withValues)
  const log = `攻防能力値を確定した（攻A${values.atk.A}/防A${values.def.A}／攻B${values.atk.B}/防B${values.def.B}）`
  return { battle: advanced.battle, log: advanced.log ? `${log}／${advanced.log}` : log }
}

/** loopBack: [21]で[19]（バトル中アクション）に戻る。at=19に戻し、loopCountを増やすだけ（千日手検知用） */
export function loopBack(battle: Battle): BattleResult {
  if (battle.at !== 21) return { battle, log: '' }
  const loopCount = battle.loopCount + 1
  return { battle: { ...battle, at: 19, step: stepForAt(19), loopCount }, log: `バトル: [21] → [19]に戻る（${loopCount}周目）` }
}

/**
 * abortBattle: 中断する。aborted=true にして at=28・step='終了' へ（20-6 / 20-6-1）。
 * 🚨 [28]は行うが[29]は行わない。呼び出し側は Battle.aborted を見て窓の出し分けをする（battleFlow.ts）。
 * 🚨 中断してもバトル種目は使用済みのまま（FAQ oldfaq.txt:3751-3752）。ここでは used をロール
 * バックしない（呼ばない）＝setBattleCard で立てた used=true は中断後もそのまま残る。
 */
export function abortBattle(battle: Battle, reason: string): BattleResult {
  return {
    battle: { ...battle, aborted: true, abortReason: reason, at: 28, step: stepForAt(28) },
    log: `バトル中断: ${reason}`,
  }
}

/**
 * computeDamage: ダメージ式（20-10）を計算するだけ。盤面には適用しない（適用は applyDamage）。
 * 受けるダメージ = 相手の攻撃能力値 − 自分の防御能力値。両者同時に算出。0以下は無効。
 * 未入力（null）は0として扱う（このフェーズでは advanceStep の前提チェックにより、
 * '結果' 段に到達している時点で4値とも入力済みのはずだが、単体で呼ばれた場合も安全に倒れる）。
 */
export function computeDamage(battle: Battle): { A: number; B: number } {
  const atkA = battle.atk.A ?? 0
  const atkB = battle.atk.B ?? 0
  const defA = battle.def.A ?? 0
  const defB = battle.def.B ?? 0
  return { A: Math.max(0, atkB - defA), B: Math.max(0, atkA - defB) }
}

export interface DamageInput {
  iid: string
  amount: number
  max: number
}

/**
 * applyDamage: ダメージの適用（at=26でのみ有効。PHASE3d-2a §4）。
 * - amount<=0は何もしない（20-10「この値が０以下の場合はダメージが発生しなかったと見なされ」oldrule.txt:1157）。
 * - 気力が1以上から0以下になった参加キャラのiidを resultDowned に積む（15-5 oldrule.txt:633）。
 *   元から0以下だったキャラは積まない。
 * - 誰に何点入れるかは呼び出し側（UI）が決める。core はカードを知らないので配分は決め打たない。
 * - 適用したら at=27 に進む（窓を開くのは battleFlow.ts の汎用ロジックに任せる）。
 * - 🚨 ダウン処理（ダウン数・ボーナスドロー・ゴミ箱送り・ゲーム終了判定）はここでは自動化しない（P4）。
 */
export function applyDamage(state: BoardState, battle: Battle, damages: DamageInput[]): BattleStateResult {
  if (battle.at !== 26) return { state, battle, log: '' }

  let nextState = state
  const resultDowned = [...battle.resultDowned]
  const logs: string[] = []

  for (const d of damages) {
    if (d.amount <= 0) continue // 20-10: 0以下はダメージが発生しなかったと見なす
    const card: CardInstance | undefined = nextState.cards[d.iid]
    const before = card?.kiryoku ?? d.max
    const result = adjustKiryoku(nextState, {
      iid: d.iid,
      delta: -d.amount,
      max: d.max,
      cardName: card?.cardId ?? d.iid,
    })
    nextState = result.state
    if (result.log) logs.push(result.log)
    const after = nextState.cards[d.iid]?.kiryoku ?? before
    if (before >= 1 && after <= 0 && !resultDowned.includes(d.iid)) {
      resultDowned.push(d.iid) // 15-5: 気力が１以上から０以下になった＝ダウン（oldrule.txt:633）
    }
  }

  const nextBattle: Battle = { ...battle, resultDowned, at: 27, step: stepForAt(27) }
  return { state: nextState, battle: nextBattle, log: logs.length ? logs.join('／') : 'ダメージ適用（変化なし）' }
}

/** そのiidの参加キャラが「場に居る」と言えるか（リーダー or キャラゾーン）。detectAbort専用の内部判定 */
function isOnField(card: CardInstance | undefined): boolean {
  return !!card && (card.zone === 'char' || card.zone === 'leader')
}

/**
 * detectAbort: 20-6の即時中断を、盤面の before/after 差分から検出する純粋関数（BoardActionには依存しない。
 * P3c の core/timing.ts と同じ流儀＝ゲスト側でも同じロジックで動く）。中断理由の文字列を返す。無ければ null。
 *
 * 🚨 差し戻し対応（2026-09-23・PHASE3d-1-差し戻し.md）で設計を修正した。判定した設計
 * （HANDOFF-P3d-1.md にも記載。統括が独立検証する箇所）。PHASE3d-2a §5: この関数自体の判定範囲
 * （バトル中アクション・結果の2段＝battle.stepで判定）は変えない。呼び出し側（battleFlow.ts）を新設しただけ。
 *
 * - **対象の段は `バトル中アクション` と `結果` の2段だけ**（旧実装は `終了` も含めていたが外した）。
 *   20-6の範囲は原典「手順[19]～手順[28]」。[28]自体はアクション宣言の機会を持たない処理段
 *   （攻防修正を失わせるだけ）なので、[28]の間に参加キャラが消える＝《バトル終了時》《バトル終了時
 *   まで》の効果が働いた場合に限られる。しかし §5.2 の7段圧縮では[28]と[29]（バトル終了後の
 *   通常の窓）が1つの `終了` 段に合体しており、盤面の状態だけからは「今[28]の途中か、もう[29]の
 *   通常の窓に入ったか」を区別できない。区別できないものを機械的に中断と断定すると、通常のバトル
 *   終了後の効果まで誤って中断扱いにしかねないため、`終了` 段では自動判定せず、人間が状況を見て
 *   `abortBattle` を呼ぶ運用にした（PHASE3d-1-差し戻し.md 統括4補足）。
 * - 「参加キャラが失われる」の判定対象は before 時点で zone が char/leader（＝場に居た）参加キャラが、
 *   after では char/leader のどちらでもなくなった（trashへ移動・盤外に消えた等）場合。
 * - 「バトルの結果でダウンした場合を除く」（20-6括弧書き）は、**段（battle.step）ではなく
 *   `battle.resultDowned`（原因そのものの記録）で判定する**。旧実装は `battle.step === '結果'` を
 *   丸ごと除外していたが、これは誤り: `oldrule.txt:1114-1119`（20-4結果段）を見ると
 *   `[23]攻撃能力値、防御能力値の決定。[24]バトルの結果の計算を行う。
 *   [25]《バトルの結果の計算をしたとき》の処理、アクション宣言の機会。←窓
 *   [26]必要ならば、ダメージ処理、ダウン処理を行う。
 *   [27]《バトルの結果を出したとき》の処理、アクション宣言の機会。←窓`
 *   と"結果"段の中に[25][27]の2つの窓（アクション宣言の機会）がある。[25]の窓で誰かが効果を使い、
 *   それによって参加キャラが場を離れた場合、それは「バトルの結果でダウンした」（[26]由来）ではないので
 *   本来は中断すべきだが、段だけで判定すると見逃してしまう。そこでdetectAbortはbefore/afterの
 *   差分だけでは"原因"が分からないため、[26]でダウンした参加キャラのiidを`battle.resultDowned`に
 *   記録しておいてもらい（PHASE3d-2a: applyDamage が[26]の適用時に埋める）、
 *   `resultDowned`に載っているiidの喪失だけを除外する。
 * - **「バトル種目が失われる」の判定は削除した（旧実装の誤り。PHASE3d-1-差し戻し.md ③）**。
 *   20-9（`oldrule.txt:1151-1152`）「そのバトルカードがフィールドから取り除かれたとしても、
 *   決定された攻撃属性と防御属性は**バトル種目が変更されない限り有効**です。」
 *   12-2（`oldrule.txt:509-510`）「バトルカードに関しては、**バトルが行われている限りカードの有無は
 *   問われず**、バトルが行われている間有効です。」
 *   FAQ（`oldfaq.txt:3443-3444`）「バトル中にバトルカードがゴミ箱送りされた場合…／**バトルは続行します。**」
 *   → 20-6の「バトル種目が失われる」は「バトルカードが場から消える」ことではなく、効果による
 *   無効化・変更（＝種目そのものの差し替え）を指す。それは盤面の差分（カードのzone）からは
 *   判定できないため、人間が判断して `abortBattle` を呼ぶ（§5「あえて作らない」）。
 *   ここに検出コードを戻さないこと。
 */
export function detectAbort(before: BoardState, after: BoardState, battle: Battle): string | null {
  if (battle.step !== 'バトル中アクション' && battle.step !== '結果') return null

  for (const seat of ['A', 'B'] as const) {
    for (const iid of battle.participants[seat]) {
      const wasOnField = isOnField(before.cards[iid])
      const stillOnField = isOnField(after.cards[iid])
      if (wasOnField && !stillOnField) {
        if ((battle.resultDowned ?? []).includes(iid)) continue // 20-6括弧書き。原因がresultDownedに記録されている分だけ除外する
        return `${seat}側の参加キャラ(${iid})が場から失われた`
      }
    }
  }

  return null
}
