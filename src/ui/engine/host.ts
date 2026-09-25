/*
 * エンジンを画面につなぐ層（純粋な部分）— PHASE-R2u §3-1
 *
 * ホスト（と一人のとき）だけが applyEngineReq を実行する。ゲストは EngineReq をホストに送るだけ（DESIGN §6: ホストが正）。
 * 1回の要求＝history に1件（Undo 1回）。乱数（shuffle）は呼び出し側が ctx に入れて渡す。
 * DOM・React・localStorage に触らない（node でテストできる形）。
 */

import { applyAction, type BoardAction } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import type { History, LogEntry } from '../../core/history'
import { activeSeat, awaitingSeat, canDeclarePhaseEnd, currentWindow, phaseEndPending, type ProcTrace } from '../../core/proc'
import type { CardInfo, EngineCtx } from '../../engine/ctx'
import { declare, declareTargets, drive, validPick, type DeclareReq, type TargetSpec } from '../../engine/drive'
import { costOfAbility, paymentCovers, poolOnlyPayment } from '../../engine/cost'
import type { CardDef } from '../../engine/dsl'
import type { EngineReq, PublicStep } from '../../net/session'

// ───────────────────────────────────────────────────────────────
// EngineCtx を data 層の中身から作る（形は scripts/lib/faq-run.ts の cardInfoOf と同じ）
// ───────────────────────────────────────────────────────────────

export interface PoolCardLike {
  id: string
  name: string
  kind: CardInfo['kind']
  kiryoku: number | null
  stats: Record<string, number> | null
  cost: string
  attr: string
  abilities: { header: string; cost: string }[]
  battleAtk?: string
  battleDef?: string
  cells?: string[]
}

export function cardInfoFromPool(p: PoolCardLike): CardInfo {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    kiryoku: p.kiryoku,
    stats: p.stats,
    cost: p.cost,
    attr: p.attr,
    abilities: (p.abilities ?? []).map((a) => ({ header: a.header, cost: a.cost })),
    ...(p.kind === 'b' ? { battleAtk: p.battleAtk ?? '', battleDef: p.battleDef ?? '', place: p.cells?.[1] ?? '' } : {}),
  }
}

/** carddefs が無い zip でも動く（defs が空なら declare は missingDef を返す） */
export function buildEngineCtx(pool: PoolCardLike[], defs: Record<string, CardDef> | null | undefined, shuffle?: (iids: string[]) => string[]): EngineCtx {
  const cards: Record<string, CardInfo> = {}
  for (const p of pool) cards[p.id] = cardInfoFromPool(p)
  return { cards, defs: defs ?? {}, ...(shuffle ? { shuffle } : {}) }
}

// ───────────────────────────────────────────────────────────────
// 要求
// ───────────────────────────────────────────────────────────────

export type { EngineReq, PublicStep }

export interface EngineApplied {
  ok: true
  history: History
  trace: ProcTrace[]
  warnings: string[]
}
export interface EngineRejected {
  ok: false
  reason: string
  missingDef?: boolean
  manual?: boolean
}

/** AP のフェイズの窓での見送り＝フェイズ終了の宣言（10-2-2。R2u 統括11 のレビュー「見送りと終えるは1ボタン」） */
function isPhaseEndPass(state: BoardState, by: Seat): boolean {
  return currentWindow(state)?.frame === null && canDeclarePhaseEnd(state, by)
}

/** 要求を BoardAction の列にする（合法でなければ理由）。適用はしない（ゲストの先読みにも使える） */
export function reqToActions(state: BoardState, ctx: EngineCtx, req: EngineReq): { ok: true; actions: BoardAction[]; warnings: string[] } | EngineRejected {
  if (state.result && req.kind !== 'abandon') return { ok: false, reason: '対戦は終わっている' }
  switch (req.kind) {
    case 'declare': {
      if (state.procMeta.choice) return { ok: false, reason: '選択の答えを待っている' }
      const out = declare(state, ctx, req.req)
      if (!out.ok) return { ok: false, reason: out.reason, missingDef: out.missingDef, manual: out.manual }
      return { ok: true, actions: out.actions, warnings: out.warnings }
    }
    case 'pass': {
      if (state.procMeta.choice) return { ok: false, reason: '選択の答えを待っている' }
      if (!currentWindow(state)) return { ok: false, reason: '宣言の機会が無い' }
      if (awaitingSeat(state) !== req.by) return { ok: false, reason: 'そのプレイヤーの番でない（11-2）' }
      if (isPhaseEndPass(state, req.by)) return { ok: true, actions: [{ type: 'procPhaseEnd', by: req.by }], warnings: [] }
      return { ok: true, actions: [{ type: 'procPass', by: req.by }], warnings: [] }
    }
    case 'choose': {
      const ch = state.procMeta.choice
      if (!ch || ch.id !== req.id) return { ok: false, reason: 'その選択は今は無い' }
      if (ch.by !== req.by) return { ok: false, reason: 'その選択はそのプレイヤーのものでない' }
      if (!validPick(ch, req.pick)) return { ok: false, reason: '選び方が合っていない' }
      return { ok: true, actions: [{ type: 'procChoose', id: ch.id, pick: req.pick }], warnings: [] }
    }
    case 'phase': {
      if (!state.turn) return { ok: false, reason: 'ターンが始まっていない' }
      if (!req.answer) {
        if (activeSeat(state) !== req.by) return { ok: false, reason: 'フェイズ終了を宣言するのはアクティブプレイヤー（10-2-2）' }
        if (!canDeclarePhaseEnd(state, req.by)) return { ok: false, reason: '今はフェイズ終了を宣言できない（フェイズの窓で自分の番のときだけ・10-2-2）' }
        return { ok: true, actions: [{ type: 'procPhaseEnd', by: req.by }], warnings: [] }
      }
      if (activeSeat(state) === req.by) return { ok: false, reason: 'フェイズ終了を認めるのはノンアクティブプレイヤー（10-2-2）' }
      if (!phaseEndPending(state)) return { ok: false, reason: 'フェイズ終了の宣言が無い' }
      return { ok: true, actions: [req.answer === 'accept' ? { type: 'procPass', by: req.by } : { type: 'procPhaseDeny', by: req.by }], warnings: [] }
    }
    case 'values':
      return { ok: false, reason: '[23] の人の入力は R2u-2 で作る' }
    case 'start':
    case 'engineOn':
      return { ok: false, reason: `${req.kind} は applyEngineReq が扱う` }
    case 'abandon':
      return { ok: true, actions: [{ type: 'procAbandon' }], warnings: [] }
  }
}

/** ゲストの要求がその席から来たものか（なりすまし防止）。一人のときは sender=null で確かめない */
function reqSeat(req: EngineReq): Seat {
  return req.kind === 'declare' ? req.req.by : req.by
}

/** 開始準備（P5b）が済んでいるか: デッキで始めた席はリーダーを表にしていること（手で置いた盤面＝setup が無い席は問わない） */
export function setupDone(state: BoardState): boolean {
  return (['A', 'B'] as Seat[]).every((s) => !state.setup[s] || state.setup[s]!.leaderRevealed)
}

function entry(history: History, id: string, text: string, trace: ProcTrace[], state: BoardState): LogEntry {
  const steps = toPublicSteps(trace, state)
  return { id: `e${history.past.length}:${id}`, text, ...(steps.length ? { steps } : {}) }
}

/**
 * ホストが要求を適用する: 合法を確かめる→ BoardAction を適用→ drive で次の入力待ちまで進める→ history に1件。
 * sender: 要求を送ってきた席（ゲストの席）。null＝一人のとき・ホスト自身の操作で席を問わない。
 */
export function applyEngineReq(history: History, ctx: EngineCtx, req: EngineReq, sender: Seat | null = null): EngineApplied | EngineRejected {
  if (sender !== null && reqSeat(req) !== sender) return { ok: false, reason: '自分の席の要求でない' }
  const before = history.present
  if (req.kind === 'start' || req.kind === 'engineOn') {
    let placed: BoardState
    let text: string
    if (req.kind === 'start') {
      // 開始準備（P5b: マリガン→先攻を決める→リーダーを表にする）の後にターンを置いてエンジンを動かす（PHASE-R2u §3-2）
      if (before.turn || before.proc.length) return { ok: false, reason: 'ターンはもう始まっている' }
      if (!setupDone(before)) return { ok: false, reason: '開始準備が済んでいない（リーダーを表にしてから）' }
      placed = { ...before, mode: 'engine', turn: { active: req.first, phase: 'エントリー', n: 1 } }
      text = `対戦開始（先攻 ${req.first}）`
    } else {
      // 手動からエンジンに戻す: 今の proc から続ける（§2-3）
      if (before.mode === 'engine') return { ok: false, reason: 'もうエンジン' }
      placed = { ...before, mode: 'engine' }
      text = 'エンジンに切り替えた'
    }
    const d = drive(placed, ctx)
    return {
      ok: true,
      history: { present: d.state, past: [...history.past, { state: before, log: entry(history, req.kind, text, d.trace, d.state) }], future: [] },
      trace: d.trace,
      warnings: d.warnings,
    }
  }
  const plan = reqToActions(before, ctx, req)
  if (!plan.ok) return plan
  let state = before
  const trace: ProcTrace[] = []
  const logs: string[] = []
  for (const a of plan.actions) {
    const r = applyAction(state, a)
    if (!r.log) return { ok: false, reason: `適用できなかった: ${a.type}` }
    state = r.state
    logs.push(r.log)
    if (r.trace) trace.push(...r.trace)
  }
  const d = drive(state, ctx)
  state = d.state
  trace.push(...d.trace)
  let text = logs[0] ?? req.kind
  const log = entry(history, req.kind, text, trace, state)
  if (req.kind === 'choose') {
    // 選んだカードは iid のままログの文に入れない（画面が公開かどうかを見て名前か「＊」にする）。カードでない選択肢は文に書く
    const cardsPicked = req.pick.filter((k) => k in state.cards)
    const others = req.pick.filter((k) => !(k in state.cards))
    text = `${req.by} が選んだ（${req.pick.length}）${others.length ? `: ${others.join('・')}` : ''}`
    log.text = text
    if (cardsPicked.length) log.steps = [{ text: '選んだ', iids: cardsPicked }, ...(log.steps ?? [])]
  }
  return {
    ok: true,
    history: { present: state, past: [...history.past, { state: before, log }], future: [] },
    trace,
    warnings: [...plan.warnings, ...d.warnings],
  }
}

// ───────────────────────────────────────────────────────────────
// その席が今宣言できるもの（自動見送り・ボタンの出し分け）
// ───────────────────────────────────────────────────────────────

export interface LegalDecl {
  req: DeclareReq
  label: string
}

/**
 * 手札のカード・場の自分のキャラの能力・コスト発生・バトルを挑む、を declare に試して合法なものだけ返す。
 * 支払い（payWith）はここでは指定しない（declare が「払える案がある」ことを確かめる）。
 * 対象が要る宣言: 宣言者が指定する対象（declareTargets）は候補の先頭で試す。それでも「対象」の理由で断られたものも出す
 * （対象を選べば出せるかもしれない。自動見送りで取りこぼさないため）
 */
export function legalDeclarations(state: BoardState, ctx: EngineCtx, seat: Seat): LegalDecl[] {
  if (state.result || state.procMeta.choice || !currentWindow(state) || awaitingSeat(state) !== seat) return []
  const out: LegalDecl[] = []
  const tryReq = (req: DeclareReq, label: string) => {
    if (declare(state, ctx, req).ok) {
      out.push({ req, label })
      return
    }
    // 宣言者が指定する対象（装備対象・構成要素など）があるなら、候補の組で試す（1つの枠は2枚までの組み合わせ・それ以外は先頭）
    const specs = declareTargets(state, ctx, req)
    if (specs.length === 0 || specs.some((s) => s.options.length < s.min)) return
    const combos: string[][] = []
    if (specs.length === 1 && specs[0].max <= 2 && specs[0].options.length <= 12) {
      const { options, min } = specs[0]
      const n = Math.max(min, 1)
      if (n === 1) options.forEach((o) => combos.push([o]))
      else options.forEach((a, i) => options.slice(i + 1).forEach((b) => combos.push([a, b])))
    } else combos.push(specs.flatMap((s) => s.options.slice(0, Math.max(s.min, 1))))
    if (combos.some((targets) => declare(state, ctx, { ...req, targets }).ok)) out.push({ req, label })
  }
  for (const c of Object.values(state.cards)) {
    const info = ctx.cards[c.cardId]
    if (!info) continue
    if (c.zone === 'hand' && c.owner === seat) {
      if (ctx.defs[c.cardId] || ['c', 't', 'i', 'f', 'b'].includes(info.kind)) tryReq({ by: seat, source: c.iid }, `${info.name}`)
      if (info.kind === 'c' || info.kind === 't') tryReq({ by: seat, source: c.iid, costGen: true }, `${info.name}（コスト）`)
      continue
    }
    if ((c.zone === 'char' || c.zone === 'leader') && c.owner === seat && c.attachedTo === null) {
      tryReq({ by: seat, source: c.iid, costGen: true }, `${info.name}（コスト）`)
      tryReq({ by: seat, source: c.iid, battle: true }, `${info.name}でバトルを挑む`)
      for (const ab of ctx.defs[c.cardId]?.abilities ?? []) {
        if (ab.kind === 'activated' && ab.name) tryReq({ by: seat, source: c.iid, ability: ab.name }, `${info.name}《${ab.name}》`)
      }
    }
  }
  return out
}

/** 自動見送りの判定（§2-2）: 宣言の番がこの席で、選択が無く、宣言できるものが1つも無い（NAP のフェイズ終了への答えも同じ＝認める） */
export function shouldAutoPass(state: BoardState, ctx: EngineCtx, seat: Seat): boolean {
  if (state.result || state.procMeta.choice || !currentWindow(state) || awaitingSeat(state) !== seat) return false
  // 【決めたこと】コスト発生だけの宣言は数えない（支払いの中で選ぶもの §2-1。数えると手札にキャラがある限り止まってしまう）
  return legalDeclarations(state, ctx, seat).filter((d) => !d.req.costGen).length === 0
}

// ───────────────────────────────────────────────────────────────
// 段ごとの表示（§2-4）: drive の trace を公開してよい形にする
// ───────────────────────────────────────────────────────────────

/**
 * trace の文に入っている iid を取り出し、文からは iid を伏せる（カード名は入れない。画面が iid から
 * 名前を出すときに isPublicCard で確かめる）。非公開のカードの名前はここでは作らない。
 */
export function toPublicSteps(trace: ProcTrace[], state: BoardState): PublicStep[] {
  return trace
    .filter((t) => t.kind !== 'warn')
    .map((t) => {
      const parts = t.text.split(':')
      const iids = parts.filter((p) => p in state.cards)
      const text = parts.filter((p) => !(p in state.cards)).join(':')
      return { text, iids }
    })
}

// ───────────────────────────────────────────────────────────────
// 宣言を組み立てる（§2-1 支払いを選ぶ・対象の指定＝盤面のクリック）
// ───────────────────────────────────────────────────────────────

export interface PaymentNeed {
  /** true＝プレイヤーに選ばせる。false＝聞かずに宣言する（コストが無い・発生済みのコストだけで1通りに払える） */
  choose: boolean
  /** 必要なコストの表記（印刷どおり。'WG早' など） */
  costText: string
  /** 選べる発生源: 手札のキャラ／タッグ（捨てる）・場の待機状態の自分のキャラ（消耗させる） */
  candidates: string[]
  /** 選べる発生済みのコストの id（その席の costs） */
  pool: string[]
  /** 聞かないときに使う発生済みのコスト（例外の1通り） */
  autoPool?: string[]
}

export function paymentNeed(state: BoardState, ctx: EngineCtx, req: DeclareReq): PaymentNeed {
  const none: PaymentNeed = { choose: false, costText: '', candidates: [], pool: [] }
  if (req.costGen || req.battle) return none
  const src = state.cards[req.source]
  const info = src ? ctx.cards[src.cardId] : undefined
  if (!src || !info) return none
  // タッグ化は使用代償なし（15-10-2）
  if (!req.ability && src.zone === 'hand' && info.kind === 't') return none
  const { cost } = costOfAbility(ctx, src.cardId, req.ability ?? null)
  const costText = req.ability ? (info.abilities.find((a) => a.header === req.ability)?.cost ?? '') : info.kind === 'c' || info.kind === 't' ? info.cost : `${info.cost}${info.attr}`
  if (cost.icons.length === 0) return { ...none, costText }
  // 例外: 発生済みのコストだけで払えて、使う組み合わせが1通りなら聞かない（統括の解釈）
  const auto = poolOnlyPayment(ctx, state, req.by, cost)
  if (auto) return { ...none, costText, autoPool: auto }
  const candidates = Object.values(state.cards)
    .filter((c) => {
      if (c.iid === req.source && src.zone === 'hand') return false
      const k = ctx.cards[c.cardId]?.kind
      if (c.zone === 'hand') return c.owner === req.by && (k === 'c' || k === 't')
      return (c.zone === 'char' || c.zone === 'leader') && c.attachedTo === null && c.owner === req.by && c.orientation === 'ready'
    })
    .map((c) => c.iid)
  return { choose: true, costText, candidates, pool: state.costs[req.by].map((t) => t.id) }
}

/** 選んだ支払い（payWith＋payPool）で足りるか（「宣言」を押せるか） */
export function paymentReady(state: BoardState, ctx: EngineCtx, req: DeclareReq): boolean {
  const src = state.cards[req.source]
  const info = src ? ctx.cards[src.cardId] : undefined
  if (!src || !info) return false
  const { cost } = costOfAbility(ctx, src.cardId, req.ability ?? null)
  const sourceIid = !req.ability && src.zone === 'hand' ? null : src.iid
  return paymentCovers(ctx, state, req.by, sourceIid, cost, req.payWith ?? [], req.payPool ?? [])
}

/** 宣言者が盤面で指定する対象（無ければ空） */
export function targetsNeeded(state: BoardState, ctx: EngineCtx, req: DeclareReq): TargetSpec[] {
  return declareTargets(state, ctx, req).filter((s) => s.max > 0)
}

export type { TargetSpec }
