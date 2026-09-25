/*
 * エンジンを画面につなぐ層（純粋な部分）— PHASE-R2u §3-1
 *
 * ホスト（と一人のとき）だけが applyEngineReq を実行する。ゲストは EngineReq をホストに送るだけ（DESIGN §6: ホストが正）。
 * 1回の要求＝history に1件（Undo 1回）。乱数（shuffle）は呼び出し側が ctx に入れて渡す。
 * DOM・React・localStorage に触らない（node でテストできる形）。
 */

import { applyAction, type BoardAction } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import type { History } from '../../core/history'
import { activeSeat, awaitingSeat, currentWindow, type ProcTrace } from '../../core/proc'
import type { CardInfo, EngineCtx } from '../../engine/ctx'
import { declare, drive, validPick, type DeclareReq } from '../../engine/drive'
import type { CardDef } from '../../engine/dsl'
import type { EngineReq } from '../../net/session'

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

export type { EngineReq }

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

/** 次のフェイズ（10-1: エントリー→メイン→手札調整→ターン終了） */
function nextPhase(state: BoardState): 'メイン' | '手札調整' | 'ターン終了' | null {
  const ph = state.turn?.phase
  if (ph === 'エントリー') return 'メイン'
  if (ph === 'メイン') return '手札調整'
  if (ph === '手札調整') return 'ターン終了'
  return null
}

/** 要求を BoardAction の列にする（合法でなければ理由）。適用はしない（ゲストの先読みにも使える） */
export function reqToActions(state: BoardState, ctx: EngineCtx, req: EngineReq): { ok: true; actions: BoardAction[]; warnings: string[] } | EngineRejected {
  if (state.result) return { ok: false, reason: '対戦は終わっている' }
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
      if (activeSeat(state) !== req.by) return { ok: false, reason: 'フェイズを進めるのはアクティブプレイヤー（10-2-2）' }
      if (state.procMeta.choice || state.proc.length) return { ok: false, reason: '手順の途中（窓を閉じてから）' }
      const to = nextPhase(state)
      if (!to) return { ok: false, reason: 'このフェイズからは進められない' }
      return { ok: true, actions: [{ type: 'procPhase', to }], warnings: [] }
    }
    case 'values':
      return { ok: false, reason: '[23] の人の入力は R2u-2 で作る' }
  }
}

/** ゲストの要求がその席から来たものか（なりすまし防止）。一人のときは sender=null で確かめない */
function reqSeat(req: EngineReq): Seat {
  return req.kind === 'declare' ? req.req.by : req.by
}

/**
 * ホストが要求を適用する: 合法を確かめる→ BoardAction を適用→ drive で次の入力待ちまで進める→ history に1件。
 * sender: 要求を送ってきた席（ゲストの席）。null＝一人のとき・ホスト自身の操作で席を問わない。
 */
export function applyEngineReq(history: History, ctx: EngineCtx, req: EngineReq, sender: Seat | null = null): EngineApplied | EngineRejected {
  if (sender !== null && reqSeat(req) !== sender) return { ok: false, reason: '自分の席の要求でない' }
  const before = history.present
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
  const text = logs[0] ?? req.kind
  return {
    ok: true,
    history: { present: state, past: [...history.past, { state: before, log: { id: `e${history.past.length}:${req.kind}`, text } }], future: [] },
    trace,
    warnings: [...plan.warnings, ...d.warnings],
  }
}

/** エンジンを（再）開始する: 手動から戻したとき・ターンを置いたとき。変化が無ければ history はそのまま */
export function driveHistory(history: History, ctx: EngineCtx): { history: History; trace: ProcTrace[]; warnings: string[] } {
  const d = drive(history.present, ctx)
  if (d.actions.length === 0) return { history, trace: d.trace, warnings: d.warnings }
  return {
    history: { present: d.state, past: [...history.past, { state: history.present, log: { id: `e${history.past.length}:drive`, text: 'エンジンが進めた' } }], future: [] },
    trace: d.trace,
    warnings: d.warnings,
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
 * 支払い（payWith）はここでは指定しない（declare が「払える案がある」ことを確かめる）。対象が要る宣言は targets 無しで
 * 不合法になることがある → 対象を取る宣言は「対象を選べば出せる」かを R2u-1 では見ない【決めたこと: 空なら見送り。
 * 対象が要るカードで取りこぼすと自動見送りしてしまうので、対象の候補があるかは declare の理由で見分ける】
 */
export function legalDeclarations(state: BoardState, ctx: EngineCtx, seat: Seat): LegalDecl[] {
  if (state.result || state.procMeta.choice || !currentWindow(state) || awaitingSeat(state) !== seat) return []
  const out: LegalDecl[] = []
  const tryReq = (req: DeclareReq, label: string) => {
    const r = declare(state, ctx, req)
    if (r.ok || /対象/.test(r.reason)) out.push({ req, label })
  }
  for (const c of Object.values(state.cards)) {
    const info = ctx.cards[c.cardId]
    if (!info) continue
    if (c.zone === 'hand' && c.owner === seat) {
      if (ctx.defs[c.cardId]) tryReq({ by: seat, source: c.iid }, `${info.name}`)
      if (info.kind === 'c' || info.kind === 't') tryReq({ by: seat, source: c.iid, costGen: true }, `${info.name}（コスト）`)
      continue
    }
    if ((c.zone === 'char' || c.zone === 'leader') && c.owner === seat) {
      tryReq({ by: seat, source: c.iid, costGen: true }, `${info.name}（コスト）`)
      tryReq({ by: seat, source: c.iid, battle: true }, `${info.name}でバトルを挑む`)
      for (const ab of ctx.defs[c.cardId]?.abilities ?? []) {
        if (ab.kind === 'activated' && ab.name) tryReq({ by: seat, source: c.iid, ability: ab.name }, `${info.name}《${ab.name}》`)
      }
    }
  }
  return out
}

/** 自動見送りの判定（§2-2）: 宣言の番がこの席で、選択が無く、宣言できるものが1つも無い */
export function shouldAutoPass(state: BoardState, ctx: EngineCtx, seat: Seat): boolean {
  if (state.result || state.procMeta.choice || !currentWindow(state) || awaitingSeat(state) !== seat) return false
  // 【決めたこと】コスト発生だけの宣言は数えない（支払いの中で選ぶもの §2-1。数えると手札にキャラがある限り止まってしまう）
  return legalDeclarations(state, ctx, seat).filter((d) => !d.req.costGen).length === 0
}
