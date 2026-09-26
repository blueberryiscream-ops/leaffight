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
import type { Violation } from '../../engine/layers'
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
      // K4（R3）: カードの効果による禁止・対象にならない等は止めずに警告（画面で確認してから送られてくる）。ログにも残す
      const warn = out.violations.map((v) => `警告（K4）: ${v.text}`)
      const trace: BoardAction[] = warn.map((text) => ({ type: 'procTrace', entry: { kind: 'warn', text } }))
      return { ok: true, actions: [...out.actions, ...trace], warnings: [...warn, ...out.warnings] }
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
    case 'values': {
      // [23] 攻防の値をエンジンが出せないとき、人が入れる（drive の askValues で止まっている）。どちらの席も入れられる【決めたこと】
      const top = state.proc[state.proc.length - 1]
      if (!top || top.kind !== 'battle' || top.status !== 'engine' || top.engineWhat !== 'battleValues') return { ok: false, reason: '今は攻防の値を入れる段（20-4[23]）でない' }
      const ok = (['A', 'B'] as Seat[]).every((x) => {
        const v = req.values[x]
        return !!v && Number.isInteger(v.atk) && Number.isInteger(v.def)
      })
      if (!ok) return { ok: false, reason: '攻撃・防御の値を両方の席に整数で入れる' }
      return { ok: true, actions: [{ type: 'procBattle', frameId: top.id, values: { A: req.values.A, B: req.values.B } }], warnings: [] }
    }
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

/** 画面の drive: [23] の攻防の値をエンジンが出せなければ人の入力を待つ（R2u-2） */
const DRIVE_OPTS = { askValues: true } as const

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
    const d = drive(placed, ctx, DRIVE_OPTS)
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
    // 受け付けられなかった＝状態もログも変わらない（procBattle の値の入力のようにログの無い操作もある）
    if (!r.log && r.state === state) return { ok: false, reason: `適用できなかった: ${a.type}` }
    state = r.state
    if (r.log) logs.push(r.log)
    if (r.trace) trace.push(...r.trace)
  }
  const d = drive(state, ctx, DRIVE_OPTS)
  state = d.state
  trace.push(...d.trace)
  let text = logs[0] ?? req.kind
  const log = entry(history, req.kind, text, trace, state)
  // 自動の見送り（鳴き無しボタン §2-2）はログで畳む（統括11 の検証の気づき3）。LogPanel が続いた印をまとめて1行にする
  // フェイズ終了の宣言・承認（10-2-2）はターンの進みなので畳まない
  if (req.kind === 'pass' && req.auto && /が通した$/.test(text)) log.auto = true
  if (req.kind === 'values') log.text = `${req.by} が攻防の値を入れた（A 攻${req.values.A.atk}・防${req.values.A.def}／B 攻${req.values.B.atk}・防${req.values.B.def}）`
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
  /** カードの効果による禁止・対象にならない等（K4・R3）。あれば警告して確認のうえ通す。自動見送りでは宣言できるものに数えない */
  violations?: Violation[]
}

/**
 * 手札のカード・場の自分のキャラの能力・コスト発生・バトルを挑む、を declare に試して合法なものだけ返す。
 * 支払い（payWith）はここでは指定しない（declare が「払える案がある」ことを確かめる）。
 * 対象が要る宣言: 宣言者が指定する対象（declareTargets）は候補の先頭で試す。それでも「対象」の理由で断られたものも出す
 * （対象を選べば出せるかもしれない。自動見送りで取りこぼさないため）
 */
export function legalDeclarations(state: BoardState, ctx: EngineCtx, seat: Seat, opts: { withWarned?: boolean } = {}): LegalDecl[] {
  if (state.result || state.procMeta.choice || !currentWindow(state) || awaitingSeat(state) !== seat) return []
  const out: LegalDecl[] = []
  // K4（R3）: 違反のある宣言は「宣言できるもの」に数えない（withWarned のときは violations つきで出す＝画面のボタン）
  const clean = (r: ReturnType<typeof declare>) => r.ok && r.violations.length === 0
  const tryReq = (req: DeclareReq, label: string) => {
    const r0 = declare(state, ctx, req)
    // 対象の選択が「later」（画面での指定待ち）へ回っただけの ok は、まだどの候補も violations に照らしていない。
    // 実際の候補（declareTargets）で試すまでは「宣言できるもの」と決めない（K4・⑰b）
    const deferred = r0.ok && ((r0.decl.eng as { later?: string[] } | undefined)?.later?.length ?? 0) > 0
    if (clean(r0) && !deferred) {
      out.push({ req, label })
      return
    }
    let warned = r0.ok && !deferred ? r0.violations : null
    // 宣言者が指定する対象（装備対象・構成要素など）があるなら、候補の組で試す（1つの枠は2枚までの組み合わせ・それ以外は先頭）
    const specs = declareTargets(state, ctx, req)
    if (specs.length === 0 || specs.some((s) => s.options.length < s.min)) {
      if (warned && opts.withWarned) out.push({ req, label, violations: warned })
      return
    }
    const combos: string[][] = []
    if (specs.length === 1 && specs[0].max <= 2 && specs[0].options.length <= 12) {
      const { options, min } = specs[0]
      const n = Math.max(min, 1)
      if (n === 1) options.forEach((o) => combos.push([o]))
      else options.forEach((a, i) => options.slice(i + 1).forEach((b) => combos.push([a, b])))
    } else combos.push(specs.flatMap((s) => s.options.slice(0, Math.max(s.min, 1))))
    for (const targets of combos) {
      const r = declare(state, ctx, { ...req, targets })
      if (clean(r)) {
        out.push({ req, label })
        return
      }
      if (r.ok && !warned) warned = r.violations
    }
    if (warned && opts.withWarned) out.push({ req, label, violations: warned })
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
      // バトルを挑む（20-2）は1つだけ出す（参加キャラは [7] で選ぶ。宣言の source はどのキャラでも同じ）
      if (!out.some((d) => d.req.battle)) tryReq({ by: seat, source: c.iid, battle: true }, 'バトルを挑む')
      for (const ab of ctx.defs[c.cardId]?.abilities ?? []) {
        if (ab.kind === 'activated' && ab.name) tryReq({ by: seat, source: c.iid, ability: ab.name }, `${info.name}《${ab.name}》`)
      }
    }
  }
  return out
}

/**
 * 自分（AP）が自分のメインフェイズのアクションの窓で、宣言の番を待っているか（R3⑤・利用者 2026-09-26）。
 * ここでは自動見送りをしない＝宣言できるものが無くても止まり、「フェイズ終了」ボタンを光らせて誘導する。
 * 自動見送りは相手の番の窓・機会と、メイン以外のフェイズだけ
 */
export function isOwnMainDeclareWindow(state: BoardState, seat: Seat): boolean {
  const win = currentWindow(state)
  return !!win && win.frame === null && win.window.state === 'awaitActive' && state.turn?.phase === 'メイン' && activeSeat(state) === seat
}

/** 自動見送りの判定（§2-2）: 宣言の番がこの席で、選択が無く、宣言できるものが1つも無い（NAP のフェイズ終了への答えも同じ＝認める）。
 *  自分のメインフェイズだけは例外（R3⑤）: 宣言できるものが無くても自動で見送らない */
export function shouldAutoPass(state: BoardState, ctx: EngineCtx, seat: Seat): boolean {
  if (state.result || state.procMeta.choice || !currentWindow(state) || awaitingSeat(state) !== seat) return false
  if (isOwnMainDeclareWindow(state, seat)) return false
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

// ───────────────────────────────────────────────────────────────
// ログの畳み（R2u-2・統括11 の検証の気づき3）
// ───────────────────────────────────────────────────────────────

export type LogRow = { key: string; text: string; steps: { text: string; iids: string[] }[] }

/** 続いた自動の見送り（LogEntry.auto）を「自動で見送り ×N（席）」の1行にまとめる（古い順のまま。段はその下にまとめる） */
export function foldLog(log: LogEntry[]): LogRow[] {
  const rows: LogRow[] = []
  let run: { first: LogEntry; n: number; seats: Set<string>; steps: LogRow['steps'] } | null = null
  const flush = () => {
    if (!run) return
    const seats = [...run.seats].sort().join('・')
    rows.push({ key: run.first.id, text: run.n === 1 ? run.first.text : `自動で見送り ×${run.n}（${seats}）`, steps: run.steps })
    run = null
  }
  for (const e of log) {
    if (e.auto) {
      if (!run) run = { first: e, n: 0, seats: new Set(), steps: [] }
      run.n++
      const seat = /^([AB]) /.exec(e.text)?.[1]
      if (seat) run.seats.add(seat)
      run.steps.push(...(e.steps ?? []))
      continue
    }
    flush()
    rows.push({ key: e.id, text: e.text, steps: e.steps ?? [] })
  }
  flush()
  return rows
}
