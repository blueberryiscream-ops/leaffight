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

import { cardsInZone, moveCard, type BoardState, type CardInstance, type Seat, type ZoneId } from './board'
import type { CostKind } from './types'

// ───────────────────────────────────────────────────────────────
// 型
// ───────────────────────────────────────────────────────────────

export type ProcKind = 'costGen' | 'ability' | 'event' | 'damage' | 'down' | 'simul'

/**
 * 窓（11-2 の2枠）。今の priority.ts の ActionWindow と同じ2枠だが、[3] 同時アクションの AP の機会
 * （NAP が [2] で宣言し AP が [1] で宣言していなかったとき）を 'awaitActiveSimul' として持つ
 * （priority.ts にはこの段が無い＝R2u で直す食い違い。HANDOFF-R2a §7-8）。
 */
export type WindowState = 'awaitActive' | 'awaitNonActive' | 'awaitActiveSimul' | 'closed'

export interface ProcWindow {
  state: WindowState
  active: ProcDecl | null
  nonActive: ProcDecl | null
  /** 7-2[3]《コストを発生するとき》はそのプレイヤーだけ */
  only: Seat | null
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
  kind: 'ability' | 'event' | 'costGen'
  actionType: '通常型' | '割込型'
  label: string
  sourceIid: string | null
  targets: string[]
  /** 15-13-1[4]・16-1[4] で宣言したコストを発生させるアクション（[7] で処理する） */
  costGens: CostSource[][]
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
  engineWhat?: 'timing' | 'pay' | 'check' | 'effect' | 'item'
  resume?: 'advance' | 'reenter' | 'afterTiming' | 'item'
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
  }
  down?: {
    iid: string
    seat: Seat
    added: boolean
    canceled: boolean
    wasLeader: boolean
    /** 使用代償としてのダウン（受け渡し）。取り消されたら支払っていない（FAQ:2040） */
    costOf: string | null
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
  options: { key: string; label: string }[]
  min: number
  max: number
  /** 同じ選択肢を何度も選べる（割り振り） */
  repeat?: boolean
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
  /** ダウン[6] でフィールドから失われたリーダー（[7] で判定する） */
  leaderLost: Seat[]
  /** 立ち消え・中断した宣言の id と理由 */
  aborted: { declId: string; reason: string }[]
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
}

const LAST_STEP: Record<ProcKind, number> = { ability: 14, event: 14, costGen: 9, damage: 6, down: 7, simul: 0 }

// ───────────────────────────────────────────────────────────────
// 小道具
// ───────────────────────────────────────────────────────────────

export function otherSeat(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

export function activeSeat(state: BoardState): Seat {
  return state.turn?.active ?? state.priority?.activePlayer ?? 'A'
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

/** カードを動かす。場を離れるキャラに付いていたアイテムはゴミ箱へ。リーダーが場を離れたら即座に負け（9-1）。
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
  let next = state
  if (leavingField) {
    for (const item of Object.values(next.cards)) {
      if (item.attachedTo === iid) {
        next = moveCard(next, { iid: item.iid, toZone: 'trash', cardName: item.cardId }).state
        next = { ...next, cards: { ...next.cards, [item.iid]: { ...next.cards[item.iid], attachedTo: null } } }
      }
    }
  }
  const toIndex = to === 'deck' && opts.index === 'top' ? 0 : undefined
  next = moveCard(next, { iid, toOwner: card.owner, toZone: to, toIndex, cardName: card.cardId }).state
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

function pushDown(state: BoardState, iid: string, costOf: string | null): BoardState {
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
    down: { iid, seat: card.owner, added: false, canceled: false, wasLeader: card.zone === 'leader', costOf },
    eng: {},
  }
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
    return { kind: 'costGen', step: 3, status: 'enter', window: null, by: decl.by, label: decl.label, decl, bindTo: null, eng: {} }
  }
  return { kind: decl.kind, step: 6, status: 'enter', window: null, by: decl.by, label: decl.label, decl, cgIndex: 0, countered: decl.countered, eng: {} }
}

/** 最も近い「アクション」のフレーム（コストの種類を結びつける 7-3） */
function nearestActionFrame(state: BoardState): string | null {
  for (let i = state.proc.length - 1; i >= 0; i--) {
    const f = state.proc[i]
    if (f.kind === 'ability' || f.kind === 'event') return f.id
  }
  return null
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
  return frame.step >= LAST_STEP[frame.kind] ? { ...frame, status: 'done' } : { ...frame, step: frame.step + 1, status: 'enter' }
}

function enterStep(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const ap = activeSeat(state)
  if (frame.aborted) return setFrame(state, { ...frame, status: 'done' })
  if (frame.kind === 'down' && frame.down?.canceled) return setFrame(state, { ...frame, status: 'done' })
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
    case 'simul':
      return setFrame(state, { ...frame, status: 'items' })
  }
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
      } else represented = onField(src)
      return setFrame(s, { ...advance(frame), represented })
    }
    case 7: {
      // [7] [4]で宣言したコストを発生させるアクションの処理
      const i = frame.cgIndex ?? 0
      if (i < decl.costGens.length) {
        const cg: ProcDecl = { ...decl, id: `${decl.id}.cg${i}`, kind: 'costGen', label: 'コスト発生', sources: decl.costGens[i], costGens: [], eng: {} }
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

function enterDown(state: BoardState, frame: ProcFrame, trace: ProcTrace[]): BoardState {
  const d = frame.down!
  switch (frame.step) {
    case 1:
      trace.push({ kind: 'name', text: `ダウン:${d.iid}` })
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
  if (frame.kind === 'ability' || frame.kind === 'event') {
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
  for (const iid of frame.pendingDowns ?? []) s = pushDown(s, iid, null)
  if (frame.kind === 'simul' && frame.simul!.collect && frame.simul!.endCheck) {
    s = checkEnd(s, '同時処理内のダウンの終了判定（15-5-2）')
  }
  void trace
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
        options: sim.items.map((it) => ({ key: it.key, label: it.label })),
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
      damage: { ...d, group: frame.id, occurred: false, rerun: false },
      eng: {},
    },
    'dmg',
  )[0]
}

function rankAction(it: SimulItem, ap: Seat): number {
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
    // メインフェイズの窓: 何も宣言されなければメインフェイズの宣言の機会は終わり（13-3-1）
    if (decls.length === 0) return setMeta(state, { base: null, mainClosed: true })
    const s = setMeta(state, { base: null })
    return pushSimul(s, decls.map(declItem), '行動の処理（11-2 [4][5]）', null, false)[0]
  }
  // タイミングの段: エンジンに《〜とき》の処理を聞く（宣言された行動とまとめて同時処理にする）
  return setFrame(state, { ...frame, window: closed, status: 'engine', engineWhat: 'timing' })
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
  // 16-1[3] 提示: 手札のイベントカードは提示エリアへ（提示した時点で使用したと見なされる）
  if (decl.kind === 'event' && decl.sourceIid) {
    const c = s.cards[decl.sourceIid]
    if (c && c.zone === 'hand') s = moveCard(s, { iid: c.iid, toZone: 'pending', cardName: c.cardId }).state
  }
  // 15-13-1[3]: 提示した特殊能力はこの時点で使用したと見なされる（【１ターンにｎ回まで】を数える）
  if (decl.usageKey) s = setMeta(s, { used: { ...s.procMeta.used, [decl.usageKey]: (s.procMeta.used[decl.usageKey] ?? 0) + 1 } })
  if (cur.frame) s = setFrame(s, { ...findFrame(s, cur.frame.id)!, window: next })
  else s = setMeta(s, { base: next })
  if (ended) s = windowEnd(s, cur.frame ? findFrame(s, cur.frame.id)! : null, next)
  return s
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
  | { type: 'procMove'; iid: string; to: 'trash' | 'hand' | 'deckTop' | 'deckBottom' | 'field'; orientation?: 'ready' | 'rested'; kiryoku?: number; attachItemsFrom?: string }
  | { type: 'procSwapZones'; seat: Seat; order: string[] }
  | { type: 'procDraw'; seat: Seat; n: number }
  | { type: 'procAddDowns'; seat: Seat; n: number }
  | { type: 'procCancelDown'; frameId: string }
  | { type: 'procDamageEdit'; frameId: string; recipient?: string; delta?: number; all?: boolean }
  | { type: 'procCounter'; frameId: string }
  | { type: 'procTrace'; entry: ProcTrace }
  /** 状況を作る（FAQ テストの force・画面の手動）: 同時処理の効果を1つ積む */
  | { type: 'procStart'; item: Omit<SimulItem, 'status' | 'type'> }

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
      return { state: setMeta(state, { base: openWindow(null, activeSeat(state)), mainClosed: false }), log: 'メインフェイズの宣言の機会' }
    }
    case 'procDeclare': {
      const s = applyDeclare(state, action.by, action.decl)
      return s ? { state: s, log: `${action.by} が「${action.decl.label}」を宣言` } : null
    }
    case 'procPass': {
      const s = applyPass(state, action.by)
      return s ? { state: s, log: `${action.by} が通した` } : null
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
      let s = setMeta(state, { choice: null, answers: { ...state.procMeta.answers, [ch.id]: action.pick } })
      if (ch.kind === 'order' && ch.frameId) {
        const f = findFrame(s, ch.frameId)
        if (f) s = applyOrder(s, f, action.pick)
      }
      return { state: s, log: `${ch.by} が選んだ: ${action.pick.join('・') || '（なし）'}` }
    }
    case 'procTimingDone': {
      const f = findFrame(state, action.frameId)
      if (!f || f.status !== 'engine' || f.engineWhat !== 'timing') return null
      const decls = f.window ? [f.window.active, f.window.nonActive].filter((d): d is ProcDecl => d !== null) : []
      const items: SimulItem[] = [...decls.map(declItem), ...action.items.map((it) => ({ ...it, type: 'effect' as const, status: 'pending' as const }))]
      if (items.length === 0) return { state: setFrame(state, { ...advance(f), window: null }), log: '' }
      const s1 = setFrame(state, { ...f, status: 'resume', resume: 'afterTiming' })
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
      for (const iid of action.down) if (onField(s.cards[iid])) s = pushDown(s, iid, f.id)
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
      const ap = activeSeat(state)
      if (ds.length === 1) {
        const d = ds[0]
        const [s] = pushFrame(
          state,
          { kind: 'damage', step: 1, status: 'enter', window: null, by: ap, label: `ダメージ→${d.recipient}`, damage: { ...d, group: null, occurred: false, rerun: false }, eng: {} },
          'dmg',
        )
        return { state: s, log: `ダメージ ${d.value}` }
      }
      // 同時に発生した複数のダメージ（H-1: 受け手ごとに1件。順は AP が決める FAQ:1409）
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
      return { state: pushSimul(state, items, '同時に発生したダメージ', null, true)[0], log: `ダメージ ${ds.length}件（同時）` }
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
    case 'procCancelDown': {
      const f = findFrame(state, action.frameId)
      if (!f || f.kind !== 'down') return null
      trace.push({ kind: 'name', text: `ダウンしない:${f.down!.iid}` })
      return { state: setFrame(state, { ...f, down: { ...f.down!, canceled: true } }), log: 'ダウンしない' }
    }
    case 'procDamageEdit': {
      const f = findFrame(state, action.frameId)
      if (!f || f.kind !== 'damage') return null
      const d = f.damage!
      let s = state
      if (action.recipient && action.recipient !== d.recipient) {
        trace.push({ kind: 'name', text: `受け手の差し替え:${d.recipient}→${action.recipient}` })
        s = setFrame(s, { ...f, damage: { ...d, recipient: action.recipient, rerun: true } })
      }
      if (action.delta) {
        const g = findFrame(s, f.id)!
        s = setFrame(s, { ...g, damage: { ...g.damage!, value: g.damage!.value + action.delta } })
        trace.push({ kind: 'name', text: `ダメージ${action.delta > 0 ? '+' : ''}${action.delta}` })
        if (action.all && d.group) {
          const grp = findFrame(s, d.group)
          if (grp?.simul) {
            const items = grp.simul.items.map((it) => (it.type === 'damage' && it.status === 'pending' ? { ...it, damage: { ...it.damage!, value: it.damage!.value + action.delta! } } : it))
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
    case 'procTrace':
      trace.push(action.entry)
      return { state, log: action.entry.text }
    case 'procStart': {
      const items: SimulItem[] = [{ ...action.item, type: 'effect', status: 'pending' }]
      return { state: pushSimul(state, items, action.item.label, null, false)[0], log: action.item.label }
    }
  }
}
