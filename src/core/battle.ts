// バトルの状態機械（core専用・カード知識ゼロ）。DESIGN.md §5.2（バトルの多段フロー）/ PHASE3d-1.md。
// バトル全体で1アクション（原典20-1）。内部の29ステップ（原典20-4）を7段に圧縮した段階遷移だけを持つ。
// 効果の解決・合法性判定は一切扱わない（DESIGN §5「あえて作らない」）。優先権（priority.ts）には
// 一切触らない（接続はP3d-2）。乱数・時刻は持たない。
//
// 🚨 BoardState.battle: Battle | null を持つため board.ts と型だけ循環参照する
// （board.ts は type-only import。priority.ts⇄board.ts で既に同じ形が前例）。
// battle.ts → board.ts はランタイムでも import する（cardsInZone/setUsed等を使うため）が、
// 向きが逆なので循環にはならない。

import { cardsInZone, setUsed, type BoardState, type CardInstance, type Seat } from './board'

/** 7段（DESIGN.md §5.2）。括弧内は原典20-4のステップ番号 */
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
   * このフェーズでは誰もここへ入れない（ダメージ/ダウン処理の適用はP3d-2・[26]で埋める）。
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

function other(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

const STEP_ORDER: BattleStep[] = [
  '宣言',
  '挑んだ側キャラ指定',
  '挑まれた側キャラ指定',
  '種目決定',
  'バトル中アクション',
  '結果',
  '終了',
]

/** declareBattle: 宣言。バトルを開始する（20-1「バトル全体で１アクションと扱われます」） */
export function declareBattle(challenger: Seat): BattleResult {
  const battle: Battle = {
    challenger,
    step: '宣言',
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
 * advanceStep: 次の段へ進む（20-4）。
 * 🚨 前提が満たされていなければ進めない（PHASE3d-1.md §3）。log を空で返して状態を変えない。
 * これはルールの強制ではなく状態の前提チェック（効果の合法性は一切見ない）。
 */
export function advanceStep(battle: Battle): BattleResult {
  const idx = STEP_ORDER.indexOf(battle.step)
  if (idx === -1 || idx === STEP_ORDER.length - 1) return { battle, log: '' } // 終了は末尾（これ以上進まない）

  if (battle.step === '挑んだ側キャラ指定' && battle.participants[battle.challenger].length === 0) {
    return { battle, log: '' }
  }
  if (battle.step === '挑まれた側キャラ指定' && battle.participants[other(battle.challenger)].length === 0) {
    return { battle, log: '' }
  }
  if (battle.step === '種目決定' && battle.battleCardIid === null) {
    return { battle, log: '' }
  }
  if (battle.step === '結果') {
    const allSet =
      typeof battle.atk.A === 'number' &&
      typeof battle.atk.B === 'number' &&
      typeof battle.def.A === 'number' &&
      typeof battle.def.B === 'number'
    if (!allSet) return { battle, log: '' }
  }

  const nextStep = STEP_ORDER[idx + 1]
  return { battle: { ...battle, step: nextStep }, log: `バトル: ${battle.step} → ${nextStep}` }
}

/** setParticipants: 参加キャラを指定する（20-4[7][11]） */
export function setParticipants(battle: Battle, seat: Seat, iids: string[]): BattleResult {
  return {
    battle: { ...battle, participants: { ...battle.participants, [seat]: iids } },
    log: `${seat} の参加キャラを指定した（${iids.length}体）`,
  }
}

/**
 * autoAssignLeader: 待機キャラが無いときリーダーを自動参加させる（20-4[12] / 20-8）。
 * 待機キャラ（zone='char' かつ orientation='ready'）が1体でもいれば何もしない（人間が選ぶ）。
 * リーダーが見つからない場合も何もしない（想定外の盤面。防御的に無視する）。
 */
export function autoAssignLeader(board: BoardState, battle: Battle, seat: Seat): BattleResult {
  const waiting = cardsInZone(board, seat, 'char').filter((c) => c.orientation === 'ready')
  if (waiting.length > 0) return { battle, log: '' }

  const leader = cardsInZone(board, seat, 'leader')[0]
  if (!leader) return { battle, log: '' }

  return {
    battle: {
      ...battle,
      participants: { ...battle.participants, [seat]: [leader.iid] },
      autoLeader: { ...battle.autoLeader, [seat]: true },
    },
    log: `${seat} は待機キャラが無いためリーダーが自動参加した（20-8）`,
  }
}

export interface BattleStateResult {
  state: BoardState
  battle: Battle
  log: string
}

/**
 * setBattleCard: 種目を決め、そのカードを used=true にする（20-4[16][18]）。
 * 🚨 card.used は BoardState.cards 側のフィールドなので、board.ts への board.ts:setUsed() を
 * 呼んで state も一緒に返す（このファイルの他の関数と違い state も返す唯一の関数）。
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

/** setValue: 攻撃/防御能力値を入れる（20-4[23]。このフェーズでは自動計算せず人間が入れる） */
export function setValue(battle: Battle, seat: Seat, stat: 'atk' | 'def', value: number): BattleResult {
  return {
    battle: { ...battle, [stat]: { ...battle[stat], [seat]: value } },
    log: `${seat} の${stat === 'atk' ? '攻撃' : '防御'}能力値を ${value} にした`,
  }
}

/** loopBack: [21]で[19]（バトル中アクション）に戻る。loopCountを増やすだけ（千日手検知用） */
export function loopBack(battle: Battle): BattleResult {
  if (battle.step !== 'バトル中アクション') return { battle, log: '' }
  const loopCount = battle.loopCount + 1
  return { battle: { ...battle, loopCount }, log: `バトル: [19]に戻る（${loopCount}周目）` }
}

/**
 * abortBattle: 中断する。aborted=true にして step='終了' へ（20-6 / 20-6-1）。
 * 🚨 [28]は行うが[29]は行わない。呼び出し側は Battle.aborted を見て窓の出し分けをする（P3d-2）。
 * 🚨 中断してもバトル種目は使用済みのまま（FAQ oldfaq.txt:3751-3752）。ここでは used をロール
 * バックしない（呼ばない）＝setBattleCard で立てた used=true は中断後もそのまま残る。
 */
export function abortBattle(battle: Battle, reason: string): BattleResult {
  return { battle: { ...battle, aborted: true, abortReason: reason, step: '終了' }, log: `バトル中断: ${reason}` }
}

/**
 * computeDamage: ダメージ式（20-10）を計算するだけ。盤面には適用しない（適用はP3d-2）。
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

/** そのiidの参加キャラが「場に居る」と言えるか（リーダー or キャラゾーン）。detectAbort専用の内部判定 */
function isOnField(card: CardInstance | undefined): boolean {
  return !!card && (card.zone === 'char' || card.zone === 'leader')
}

/**
 * detectAbort: 20-6の即時中断を、盤面の before/after 差分から検出する純粋関数（BoardActionには依存しない。
 * P3c の core/timing.ts と同じ流儀＝ゲスト側でも同じロジックで動く）。中断理由の文字列を返す。無ければ null。
 *
 * 🚨 差し戻し対応（2026-09-23・PHASE3d-1-差し戻し.md）で設計を修正した。判定した設計
 * （HANDOFF-P3d-1.md にも記載。統括が独立検証する箇所）:
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
 *   記録しておいてもらい（このフェーズでは誰も入れない＝実質つねに検出する。P3d-2が[26]の適用時に
 *   埋める）、`resultDowned`に載っているiidの喪失だけを除外する。
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
