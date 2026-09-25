// FAQ ケースをエンジンに通す（PHASE-R2a §3-3）。scripts/test-faq.ts から使う。
//
//   setup（BoardSpec）から BoardState を作る → steps を BoardAction にして drive を通す → expect を確かめる
//
// 実行の約束（HANDOFF-R2a「決めたこと」に全部書く）:
//  - declare は「それが合法になる最初の窓」で行う（R1 の約束）。途中の窓は両者とも見送る。at があればその段の窓だけ。
//    手順の外（メインフェイズの窓）から始めた宣言はその窓だけを見る。手順の中から始めた宣言は、手順が全部終わるまで探す。
//    見つからなければ「合法でない」（盤面は探す前に戻す）
//  - pass はその席の番の窓まで進めて見送る。choose はその席の選択が来るまで進めて答える
//  - steps に無い窓は見送り、steps に無い選択は既定で答える（順＝並びのまま・使うか＝使う・選ぶ＝先頭から）
//  - 盤面に書いていないデッキは、結果に影響しないカード20枚で埋める（ボーナスドローでデッキ切れにしないため）

import type { BoardAction } from '../../src/core/actions'
import { EMPTY_BOARD, type BoardState, type CardInstance, type Seat, type ZoneId } from '../../src/core/board'
import { awaitingSeat, currentWindow, type ProcFrame, type ProcTrace } from '../../src/core/proc'
import { applyAction } from '../../src/core/actions'
import type { CardInfo, EngineCtx } from '../../src/engine/ctx'
import { declare, drive, forceOp } from '../../src/engine/drive'
import type { BoardSpec, CardSpec, Expect, FaqCase, Side, Step, WindowRef } from '../../src/engine/faqCase'

export type Verdict = '✅' | '❌' | '保留'

export interface CaseResult {
  id: string
  verdict: Verdict
  reasons: string[]
  /** manual に倒れた操作（✅ でも記録する） */
  manual: string[]
  failures: string[]
  warnings: string[]
}

const FILLER = '_filler'
const seatOf = (side: Side): Seat => (side === 'you' ? 'A' : 'B')

export function buildBoard(spec: BoardSpec, ctx: EngineCtx): { state: BoardState; refs: Record<string, string> } {
  const cards: Record<string, CardInstance> = {}
  const refs: Record<string, string> = {}
  const put = (cs: CardSpec, owner: Seat, zone: ZoneId, index: number, extra: Partial<CardInstance> = {}) => {
    const info = ctx.cards[cs.card]
    const base = info?.kiryoku ?? null
    const kiryoku = cs.kiryoku ?? (base === null ? null : zone === 'leader' ? base * 2 : base)
    cards[cs.ref] = {
      iid: cs.ref,
      cardId: cs.card,
      owner,
      zone,
      index,
      orientation: cs.ready === false ? 'rested' : 'ready',
      faceUp: zone !== 'deck',
      kiryoku: zone === 'leader' || zone === 'char' ? kiryoku : info?.kind === 'c' || info?.kind === 't' ? base : null,
      attachedTo: null,
      ...extra,
    }
    refs[cs.ref] = cs.ref
    cs.equips?.forEach((e, i) => put(e, owner, 'char', 100 + i, { attachedTo: cs.ref, kiryoku: null }))
  }
  const costs: BoardState['costs'] = { A: [], B: [] }
  const downs: BoardState['downs'] = { A: 0, B: 0 }
  for (const side of ['you', 'opponent'] as Side[]) {
    const seat = seatOf(side)
    const s = spec[side]
    put(s.leader, seat, 'leader', 0)
    s.field?.forEach((c, i) => put(c, seat, 'char', i))
    if (s.fieldCard) put(s.fieldCard, seat, 'field', 0)
    s.battleCards?.forEach((c, i) => put(c, seat, 'battle', i, { used: c.used ?? false }))
    s.hand?.forEach((c, i) => put(c, seat, 'hand', i))
    s.trash?.forEach((c, i) => put(c, seat, 'trash', i))
    const top = s.deckTop ?? []
    top.forEach((c, i) => put(c, seat, 'deck', i))
    for (let i = 0; i < 20; i++) {
      const iid = `filler${seat}${i}`
      cards[iid] = { iid, cardId: FILLER, owner: seat, zone: 'deck', index: top.length + i, orientation: 'ready', faceUp: false, kiryoku: null, attachedTo: null }
    }
    downs[seat] = s.downs ?? 0
    costs[seat] = (s.costs ?? []).map((c, i) => ({ id: `init${seat}${i}`, icon: c.icon, attrs: c.attr ? [c.attr] : [], frameId: null }))
  }
  const state: BoardState = {
    ...EMPTY_BOARD,
    cards,
    mode: 'assist',
    turn: { active: seatOf(spec.active), phase: spec.phase ?? 'メイン' },
    downs,
    costs,
  }
  return { state, refs }
}

interface Run {
  state: BoardState
  ctx: EngineCtx
  refs: Record<string, string>
  actions: BoardAction[]
  trace: ProcTrace[]
  warnings: string[]
  steps: { legal?: boolean; reason?: string; declId?: string; consumed: boolean }[]
  pending: string[]
}

function apply(run: Run, a: BoardAction): boolean {
  const r = applyAction(run.state, a)
  if (r.state === run.state && !r.log) return false
  run.state = r.state
  run.actions.push(a)
  if (r.trace) run.trace.push(...r.trace)
  return true
}

function driveRun(run: Run) {
  const d = drive(run.state, run.ctx)
  run.state = d.state
  run.actions.push(...d.actions)
  run.trace.push(...d.trace)
  run.warnings.push(...d.warnings)
}

/** 入力が要る点で既定の入力を1つ入れる（窓は見送る・選択は既定で答える）。何もできなければ false */
function autoStep(run: Run): boolean {
  const s = run.state
  if (s.result) return false
  const ch = s.procMeta.choice
  if (ch) {
    let pick: string[] = []
    if (ch.kind === 'use') pick = ch.options.slice(0, 1).map((o) => o.key)
    else if (ch.kind === 'select') pick = ch.options.slice(0, Math.min(ch.max, Math.max(ch.min, 1))).map((o) => o.key)
    run.warnings.push(`選択を既定で答えた: ${ch.prompt} → ${pick.join('・') || '（なし）'}`)
    apply(run, { type: 'procChoose', id: ch.id, pick })
    driveRun(run)
    return true
  }
  const seat = awaitingSeat(s)
  if (seat) {
    apply(run, { type: 'procPass', by: seat })
    driveRun(run)
    return true
  }
  const before = run.state
  driveRun(run)
  return run.state !== before
}

function atMatches(frame: ProcFrame | null, at: WindowRef | undefined): boolean {
  if (!at) return true
  if (!frame) return at.proc === 'phase'
  return frame.kind === at.proc && frame.step === at.step
}

function mapPick(run: Run, pick: string[] | string): string[] {
  return (Array.isArray(pick) ? pick : [pick]).map((p) => run.refs[p] ?? p)
}

function doDeclare(run: Run, i: number, req: { by: Side; source: string; ability?: string; targets?: string[]; at?: WindowRef; payWith?: string[]; option?: string; costGen?: boolean }) {
  const by = seatOf(req.by)
  const snap = { state: run.state, actions: run.actions.length, trace: run.trace.length, warnings: run.warnings.length }
  let sawProc = run.state.proc.length > 0
  let lastReason = '宣言できる窓が無かった'
  for (let guard = 0; guard < 600; guard++) {
    const s = run.state
    if (s.result) {
      lastReason = 'ゲームが終わった'
      break
    }
    if (s.procMeta.choice) {
      autoStep(run)
      continue
    }
    // 手順の中を探していて、手順が全部終わった＝ここまでに宣言できる窓が無かった
    if (sawProc && s.proc.length === 0) break
    const w = currentWindow(s)
    const seat = awaitingSeat(s)
    if (w && seat === by && atMatches(w.frame, req.at)) {
      const out = declare(s, run.ctx, {
        by,
        source: run.refs[req.source] ?? req.source,
        ability: req.ability,
        targets: req.targets?.map((t) => run.refs[t] ?? t),
        payWith: req.payWith?.map((t) => run.refs[t] ?? t),
        option: req.option,
        costGen: req.costGen,
      })
      if (out.ok) {
        run.warnings.push(...out.warnings)
        out.actions.forEach((a) => apply(run, a))
        driveRun(run)
        run.steps[i] = { legal: true, declId: out.decl.id, consumed: true }
        return
      }
      if (!out.ok && (out.missingDef || out.manual)) {
        run.pending.push(out.missingDef ? `記述の無いカード: ${out.reason}` : `manual の能力: ${out.reason}`)
        run.steps[i] = { reason: out.reason, consumed: false }
        return
      }
      lastReason = out.reason
      // メインフェイズの窓で宣言できない通常型は、ここが唯一の機会＝合法でない。割込型はこの窓の行動の処理の中を探す
      if (!w.frame && !out.reason.startsWith('割込型の使用タイミングでない')) break
    }
    if (w && seat) {
      apply(run, { type: 'procPass', by: seat })
      driveRun(run)
      sawProc ||= run.state.proc.length > 0
      continue
    }
    if (run.state.proc.length === 0) {
      // 手順が全部終わった（ここまでに窓が無ければ合法でない）
      if (sawProc || !autoStep(run)) break
      sawProc ||= run.state.proc.length > 0
      continue
    }
    sawProc = true
    if (!autoStep(run)) break
  }
  // 合法でない: 探す前の盤面に戻す（警告として記録）
  run.state = snap.state
  run.actions.length = snap.actions
  run.trace.length = snap.trace
  run.warnings.length = snap.warnings
  run.steps[i] = { legal: false, reason: lastReason, consumed: true }
}

function doPass(run: Run, i: number, side: Side, at?: WindowRef) {
  const by = seatOf(side)
  for (let guard = 0; guard < 600; guard++) {
    const s = run.state
    if (s.result) break
    if (s.procMeta.choice) {
      autoStep(run)
      continue
    }
    const w = currentWindow(s)
    const seat = awaitingSeat(s)
    if (w && seat === by && atMatches(w.frame, at)) {
      apply(run, { type: 'procPass', by })
      driveRun(run)
      run.steps[i] = { legal: true, consumed: true }
      return
    }
    if (!autoStep(run)) break
  }
  run.steps[i] = { consumed: false, reason: '見送る窓が来なかった' }
}

function doChoose(run: Run, i: number, side: Side, pick: string[] | string) {
  const by = seatOf(side)
  const want = mapPick(run, pick)
  for (let guard = 0; guard < 600; guard++) {
    const s = run.state
    if (s.result) break
    const ch = s.procMeta.choice
    if (ch && ch.by === by) {
      const keys: string[] = []
      let ok = true
      for (const w of want) {
        // 選択肢の鍵は iid・名前・効果の鍵（`${iid}#${能力の番号}`）・宣言の id（`d…:${席}:${iid}`）のどれでも指せる
        const hit = (o: { key: string; label: string }) => o.key === w || o.label === w || o.key.startsWith(`${w}#`) || o.key.endsWith(`:${w}`)
        const opt = ch.options.find((o) => hit(o) && (ch.repeat || !keys.includes(o.key)))
        if (!opt) ok = false
        else keys.push(opt.key)
      }
      if (ch.kind !== 'order' && (keys.length < ch.min || keys.length > ch.max)) ok = false
      if (!ok) {
        run.steps[i] = { legal: false, reason: `選択肢に無い／数が合わない: ${want.join('・')}（選択肢: ${ch.options.map((o) => o.label).join('・')}）`, consumed: true }
        autoStep(run)
        return
      }
      apply(run, { type: 'procChoose', id: ch.id, pick: keys })
      driveRun(run)
      run.steps[i] = { legal: true, consumed: true }
      return
    }
    if (!autoStep(run)) break
  }
  run.steps[i] = { consumed: false, reason: 'その席の選択が来なかった' }
}

function finish(run: Run) {
  for (let guard = 0; guard < 3000; guard++) if (!autoStep(run)) break
}

const ZONE_OF: Record<string, (c: CardInstance) => boolean> = {
  field: (c) => c.zone === 'char' || c.zone === 'leader',
  hand: (c) => c.zone === 'hand',
  trash: (c) => c.zone === 'trash',
  deck: (c) => c.zone === 'deck',
}

function checkExpect(run: Run, e: Expect, c: FaqCase): { ok: boolean | 'pending'; msg: string } {
  const s = run.state
  const card = (ref: string) => s.cards[run.refs[ref] ?? ref]
  if ('kiryoku' in e) {
    const v = card(e.kiryoku[0])?.kiryoku
    return { ok: v === e.kiryoku[1], msg: `気力 ${e.kiryoku[0]} = ${v}（期待 ${e.kiryoku[1]}）` }
  }
  if ('zone' in e) {
    const x = card(e.zone[0])
    if (e.zone[1] === 'gone') return { ok: !x, msg: `${e.zone[0]} が盤外` }
    const zoneOk = !!x && ZONE_OF[e.zone[1]](x)
    const ownerOk = !e.zone[2] || (!!x && x.owner === seatOf(e.zone[2]))
    return { ok: zoneOk && ownerOk, msg: `${e.zone[0]} の場所 = ${x ? `${x.owner}:${x.zone}` : '無し'}（期待 ${e.zone[1]}${e.zone[2] ? `・${e.zone[2]}` : ''}）` }
  }
  if ('ready' in e) {
    const x = card(e.ready[0])
    return { ok: !!x && (x.orientation === 'ready') === e.ready[1], msg: `${e.ready[0]} の状態 = ${x?.orientation}（期待 ${e.ready[1] ? '待機' : '消耗'}）` }
  }
  if ('downs' in e) {
    const v = s.downs[seatOf(e.downs[0])]
    return { ok: v === e.downs[1], msg: `ダウン数 ${e.downs[0]} = ${v}（期待 ${e.downs[1]}）` }
  }
  if ('costs' in e) {
    const v = s.costs[seatOf(e.costs[0])].length
    return { ok: v === e.costs[1], msg: `発生済みのコスト ${e.costs[0]} = ${v}（期待 ${e.costs[1]}）` }
  }
  if ('result' in e) {
    const r = s.result
    const got = !r ? 'continues' : r.winner === null ? 'draw' : r.winner === 'A' ? 'youWin' : 'opponentWins'
    return { ok: got === e.result, msg: `結果 = ${got}${r ? `（${r.reason}）` : ''}（期待 ${e.result}）` }
  }
  if ('illegal' in e) {
    const st = run.steps[e.illegal.step]
    return { ok: st?.legal === false, msg: `steps[${e.illegal.step}] が合法でない: ${st?.legal === false ? `はい（${st.reason}）` : st?.legal ? 'いいえ（通った）' : `判定できない（${st?.reason ?? '未実行'}）`}` }
  }
  if ('legal' in e) {
    const st = run.steps[e.legal.step]
    return { ok: st?.legal === true, msg: `steps[${e.legal.step}] が合法: ${st?.legal ? 'はい' : `いいえ（${st?.reason ?? '未実行'}）`}` }
  }
  if ('fizzled' in e) {
    const st = run.steps[e.fizzled.step]
    const hit = st?.declId ? s.procMeta.aborted.find((a) => a.declId === st.declId) : undefined
    return { ok: !!hit, msg: `steps[${e.fizzled.step}] の立ち消え: ${hit ? hit.reason : 'なし'}` }
  }
  if ('stat' in e) {
    const x = card(e.stat[0])
    const v = x ? run.ctx.cards[x.cardId]?.stats?.[e.stat[1]] : undefined
    return { ok: v === e.stat[2], msg: `能力値 ${e.stat[0]} ${e.stat[1]} = ${v}（印刷値。修正の層は R3）（期待 ${e.stat[2]}）` }
  }
  if ('order' in e) {
    const names = run.trace.filter((t) => t.kind === 'name')
    const hitOf = (t: ProcTrace, want: string) => {
      const iid = run.refs[want]
      if (iid) return !!t.id && t.id.endsWith(`:${iid}`)
      return t.text === want || t.text.startsWith(`${want}:`)
    }
    const seq: string[] = []
    for (const t of names) {
      const w = e.order.find((x) => hitOf(t, x))
      if (w !== undefined) seq.push(w)
    }
    return { ok: JSON.stringify(seq) === JSON.stringify(e.order), msg: `処理の順 = ${seq.join('→') || '（なし）'}（期待 ${e.order.join('→')}）` }
  }
  if ('note' in e) return { ok: 'pending', msg: `型で書けない期待（note）: ${e.note}` }
  if ('battleCard' in e) return { ok: 'pending', msg: 'バトル種目の期待（R2b）' }
  if ('battleAborted' in e) return { ok: 'pending', msg: 'バトルの中断の期待（R2b）' }
  void c
  return { ok: 'pending', msg: '知らない期待' }
}

export function runCase(c: FaqCase, ctx: EngineCtx, debug = false): CaseResult & { debug?: unknown } {
  const res: CaseResult = { id: c.id, verdict: '保留', reasons: [], manual: [], failures: [], warnings: [] }
  if (!c.setup || !c.steps || !c.expect) {
    res.reasons.push('setup・steps・expect がそろっていない')
    return res
  }
  if (c.setup.battle) {
    res.reasons.push('範囲外の手順: バトル中から始める（R2b）')
    return res
  }
  const unsupported = c.steps.find((s) => 'challenge' in s || 'answer' in s || 'advancePhase' in s)
  if (unsupported) {
    res.reasons.push(`範囲外の手順: ${Object.keys(unsupported)[0]}（${'challenge' in unsupported ? 'バトル R2b' : 'advancePhase' in unsupported ? 'フェイズの進行 R2b/R2u' : '相手への問い R4'}）`)
    return res
  }
  if (c.setup.phase && c.setup.phase !== 'メイン') {
    res.reasons.push(`範囲外の手順: ${c.setup.phase}フェイズの処理（ターンの進行 10-2 は R2b/R2u）`)
    return res
  }
  const { state, refs } = buildBoard(c.setup, ctx)
  // 盤面に置いたアイテム・フィールドで記述の無いもの（常時効果が効くかもしれない）
  const noDef = [...new Set(Object.values(state.cards).filter((x) => { const k = ctx.cards[x.cardId]?.kind; return (k === 'i' || k === 'f') && !ctx.defs[x.cardId] }).map((x) => x.cardId))]
  const run: Run = { state, ctx, refs, actions: [], trace: [], warnings: [], steps: [], pending: [] }
  try {
    driveRun(run)
    c.steps.forEach((step: Step, i) => {
      if (run.pending.length) return
      if ('force' in step) {
        const bind: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(refs)) bind[k] = [v]
        apply(run, forceOp(run.state, step.force, bind))
        driveRun(run)
        run.steps[i] = { legal: true, consumed: true }
      } else if ('declare' in step) doDeclare(run, i, step.declare)
      else if ('generateCost' in step) doDeclare(run, i, { by: step.generateCost.by, source: step.generateCost.source, at: step.generateCost.at, costGen: true })
      else if ('pass' in step) {
        const p = typeof step.pass === 'string' ? { side: step.pass, at: undefined } : step.pass
        doPass(run, i, p.side, p.at)
      } else if ('choose' in step) doChoose(run, i, step.choose.by, step.choose.pick)
    })
    if (!run.pending.length) finish(run)
  } catch (err) {
    res.verdict = '❌'
    res.failures.push(`実行時エラー: ${(err as Error).stack ?? err}`)
    return res
  }
  if (debug) (res as CaseResult & { debug?: unknown }).debug = { trace: run.trace, actions: run.actions, steps: run.steps, state: run.state }
  res.warnings = [...new Set(run.warnings)]
  res.manual = res.warnings.filter((w) => w.startsWith('manual'))
  if (run.pending.length) {
    res.reasons.push(...run.pending)
    return res
  }
  const pendings: string[] = []
  for (const e of c.expect as Expect[]) {
    const r = checkExpect(run, e, c)
    if (r.ok === 'pending') pendings.push(r.msg)
    else if (!r.ok) res.failures.push(r.msg)
  }
  run.steps.forEach((st, i) => {
    if (st && !st.consumed) res.warnings.push(`steps[${i}] を使わなかった: ${st.reason ?? ''}`)
  })
  if (res.failures.length === 0 && pendings.length === 0) res.verdict = '✅'
  else if (res.failures.length === 0) {
    res.verdict = '保留'
    res.reasons.push(...pendings)
  } else if (res.manual.length) {
    res.verdict = '保留'
    res.reasons.push(`manual に倒れた（${res.manual.join(' / ')}）`, ...pendings)
  } else {
    res.verdict = '❌'
    res.reasons.push(...pendings)
    if (noDef.length) res.reasons.push(`盤面に記述の無いアイテム・フィールド: ${noDef.join('・')}`)
  }
  return res
}

/** pool.json の1枚からエンジン用の欄を取る */
export function cardInfoOf(p: { id: string; name: string; kind: CardInfo['kind']; kiryoku: number | null; stats: Record<string, number> | null; cost: string; attr: string; abilities: { header: string; cost: string }[] }): CardInfo {
  return { id: p.id, name: p.name, kind: p.kind, kiryoku: p.kiryoku, stats: p.stats, cost: p.cost, attr: p.attr, abilities: p.abilities.map((a) => ({ header: a.header, cost: a.cost })) }
}
