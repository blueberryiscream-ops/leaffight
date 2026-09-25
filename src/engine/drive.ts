/*
 * エンジンの駆動 — PHASE-R2a §2-4・DESIGN §5.4
 *
 * drive(state, ctx): core が止まった点を見て、エンジンが自分で進められるもの（タイミングでの処理条件がある常時効果・
 * 使用代償の支払い・構成要素の確かめ・効果の Op の実行）を BoardAction にして core に渡し、プレイヤーの入力が要る点
 * （窓・選択）まで進めて返す。返り値は「適用した BoardAction の列＋最終状態＋警告＋処理の記録」。
 * 宣言（declare）: プレイヤーの宣言を、宣言[1]〜[5]（対象・支払い方法・コスト発生の宣言）を済ませた ProcDecl にする。
 *
 * 警告（R2a）は「manual に倒れた」「カードの記述が無い」の2種類（合法性の判定 K4 は R3）。
 */

import { applyAction, type BoardAction } from '../core/actions'
import type { BoardState, Seat } from '../core/board'
import {
  PHASE_ACTIONS,
  STEP_TIMINGS,
  activeSeat,
  awaitingSeat,
  currentWindow,
  findFrame,
  battleDecl,
  nearestBattle,
  topFrame,
  type ProcChoice,
  type ProcDecl,
  type ProcFrame,
  type ProcTrace,
  type SimulItem,
} from '../core/proc'
import { conditionalHits, findAbility, stillMatches, triggerMatches, type Activated, type Play } from './abilities'
import { controllerOf, isCharOnField, maxKiryoku, nameOf, other, type EngineCtx, type Env } from './ctx'
import { attrsOf, costOfAbility, parseCostText, payNow, planPayment } from './cost'
import type { Choice, Op } from './dsl'
import { battleModOf, currentStat, evalCond, evalExpr, resolvePlayer, resolveRef, select } from './eval'
import { HOLES } from './holes'

// ───────────────────────────────────────────────────────────────
// 効果の実行の状態（同時処理の項目の eng に置く）
// ───────────────────────────────────────────────────────────────

interface Task {
  op: Op
  /** 「〜できる」の最初の選択（選ばなければ使わない）。立ち消えの判定は元の数で行う */
  optionalFirst?: boolean
  bind?: Record<string, string[]>
  /** 同時に発生するダメージのまとまり（forEach・simul の中のダメージ） */
  bundle?: string
}

interface ItemEng {
  tasks: Task[]
  env: Env
  started: boolean
  optional: boolean
  /** 処理条件がある常時効果: 始めるときに《〜とき》を確かめ直す（K10）。seat＝eachPlayer のそのプレイヤー */
  recheck: { iid: string; index: number; seat?: Seat } | null
  /** 選択の答えを待っている */
  awaiting: { id: string; kind: 'use' | 'choose' | 'order'; slot?: string; optional?: boolean; ops?: Op[]; bind?: Record<string, string[]> } | null
  seq: number
  /** 処理条件がある常時効果が受け手を差し替えた（H-2: 受け渡しは1件につき1回） */
  redirects?: boolean
}

export interface DriveResult {
  state: BoardState
  actions: BoardAction[]
  warnings: string[]
  trace: ProcTrace[]
}

// ───────────────────────────────────────────────────────────────
// 宣言（宣言[1]〜[5]）
// ───────────────────────────────────────────────────────────────

export interface DeclareReq {
  by: Seat
  /** 発生源の iid（能力のキャラ・イベントカード・コスト発生の発生源） */
  source: string
  ability?: string
  targets?: string[]
  payWith?: string[]
  /** 使う発生済みのコストの id（R2u）。payWith と合わせて、指定したものだけで払う（FAQ:2959） */
  payPool?: string[]
  option?: string
  /** コストを発生させるアクション（7-2）として宣言する */
  costGen?: boolean
  /** バトルを行うアクション（20-4[1]）として宣言する。source は挑むつもりのキャラ（[7] の指定は処理のとき） */
  battle?: boolean
}

export type DeclareOutcome =
  | { ok: true; actions: BoardAction[]; decl: ProcDecl; warnings: string[] }
  | { ok: false; reason: string; missingDef?: boolean; manual?: boolean }

/** 今の窓で、その宣言ができるか（できるなら BoardAction の列を返す）。
 *  「次のうち１つ」のカードで option が無ければ、選択肢を順に試して最初に合法なものを使う */
export function declare(state: BoardState, ctx: EngineCtx, req: DeclareReq): DeclareOutcome {
  const src = state.cards[req.source]
  const plays = src && !req.ability && !req.option && !req.costGen ? (ctx.defs[src.cardId]?.abilities ?? []).filter((a) => a.kind === 'play' && a.name) : []
  if (plays.length > 1) {
    let first: DeclareOutcome | null = null
    for (const p of plays) {
      const out = declareOne(state, ctx, { ...req, option: (p as Play).name })
      if (out.ok) return out
      first ??= out
    }
    return first!
  }
  return declareOne(state, ctx, req)
}

function declareOne(state: BoardState, ctx: EngineCtx, req: DeclareReq): DeclareOutcome {
  const cur = currentWindow(state)
  if (!cur) return { ok: false, reason: '宣言の機会が無い（窓が開いていない）' }
  if (awaitingSeat(state) !== req.by) return { ok: false, reason: '宣言の機会はそのプレイヤーの番でない（11-2）' }
  if (cur.window.only && cur.window.only !== req.by) return { ok: false, reason: 'そのプレイヤーだけの機会（7-2[3]）' }
  const src = state.cards[req.source]
  if (!src) return { ok: false, reason: '発生源が無い' }
  const info = ctx.cards[src.cardId]
  const frame = cur.frame
  // 宣言の id は盤面から決める（乱数・時刻・モジュールの状態を持ち込まない）。1つの窓で同じ席は1回しか宣言できない
  const id = `d${state.procMeta.seq}:${req.by}:${src.iid}`

  // コストを発生させるアクション（7-2）: 通常型だが、FAQ:2725 のとおり処理中の割り込みとしても宣言できる【決めたこと】
  if (req.costGen) {
    const fromHand = src.zone === 'hand'
    if (fromHand ? src.owner !== req.by || (info?.kind !== 'c' && info?.kind !== 't') : !isCharOnField(src) || src.orientation !== 'ready' || controllerOf(state, src.iid) !== req.by) {
      return { ok: false, reason: 'コストの発生源にできない（7-2）' }
    }
    const icon = fromHand ? 'W' : src.zone === 'leader' ? 'L' : info?.kind === 't' ? 'T' : 'G'
    const decl: ProcDecl = {
      id,
      by: req.by,
      kind: 'costGen',
      actionType: frame ? '割込型' : '通常型',
      label: 'コスト発生',
      sourceIid: src.iid,
      targets: [],
      costGens: [],
      sources: [{ iid: src.iid, from: fromHand ? 'hand' : 'field', icon, attrs: fromHand ? [] : attrsOf(info) }],
      trigger: frame?.id ?? null,
      usageKey: null,
      eng: {},
    }
    return { ok: true, actions: [{ type: 'procDeclare', by: req.by, decl }], decl, warnings: [] }
  }

  if (req.battle) return declareBattle(ctx, state, req, id)
  if (!req.ability && src.zone === 'hand' && info && ['c', 't', 'i', 'f', 'b'].includes(info.kind)) return declareCardUse(ctx, state, req, id)

  if (!ctx.defs[src.cardId]) return { ok: false, reason: `カードの記述が無い: ${nameOf(ctx, state, src.iid)}`, missingDef: true }
  const found = findAbility(ctx, src.cardId, req.ability ?? null, req.option)
  if (!found) return { ok: false, reason: `能力が無い: ${req.ability ?? req.option ?? '（本体）'}`, missingDef: true }
  const { ab, index } = found
  if (ab.kind === 'manual') return { ok: false, reason: `manual の能力: ${ab.reason}`, manual: true }
  if (ab.kind !== 'activated' && ab.kind !== 'play') return { ok: false, reason: '宣言して使う能力ではない（常時効果は「使用」しない 12-2・FAQ:3257）' }
  const isEvent = ab.kind === 'play'
  // 発生源の場所: 特殊能力はそのキャラの使用者がフィールドで（15-13-1）、イベントは自分の手札から（16-1）
  if (isEvent) {
    if (src.zone !== 'hand' || src.owner !== req.by) return { ok: false, reason: '自分の手札のカードでない（16-1）' }
  } else if (!isCharOnField(src) || controllerOf(state, src.iid) !== req.by) return { ok: false, reason: '自分のフィールドのキャラでない（15-13-1）' }

  const env: Env = { self: src.iid, you: req.by, slots: {}, trigger: frame?.id ?? null, declId: id, declared: { [src.iid]: src.orientation === 'ready' ? 'ready' : 'rested' } }
  // タイミング（11-1）: 通常型はメインフェイズの窓（手順の外）だけ。割込型は記載のタイミングの窓だけ
  const speed = ab.speed
  // 20-4[19][20][22]: バトル中のアクションの機会（特殊能力は決まった側が1回・イベントは両者が複数回。その他のアクションは行えない FAQ:318・3318）
  const battleAct = frame?.kind === 'battle' && [19, 20, 22].includes(frame.step)
  if (speed === '通常型' && battleAct) {
    const b = frame!.battle!
    if (!isEvent) {
      const who = frame!.step === 20 ? other(b.challenger) : b.challenger
      if (req.by !== who) return { ok: false, reason: `この機会に特殊能力を使えるのは${frame!.step === 20 ? '挑まれた' : '挑んだ'}プレイヤー（20-4[${frame!.step}]）` }
      if (b.abilityUsed) return { ok: false, reason: 'この機会の特殊能力は1回（20-4[19][20][22]）' }
    }
  } else if (speed === '通常型') {
    if (frame) return { ok: false, reason: '通常型は処理の途中に宣言できない（11-1）' }
  } else {
    if (!frame) return { ok: false, reason: '割込型の使用タイミングでない（手順の外）' }
    if (ab.trigger && !triggerMatches(ctx, state, env, ab.trigger, frame)) {
      return { ok: false, reason: `使用タイミング《${ab.trigger.timing}》でない（今は ${frame.kind}[${frame.step}]《${STEP_TIMINGS[frame.kind][frame.step]?.names.join('・')}》）` }
    }
  }
  const usageKey = !isEvent && (ab as Activated).perTurn ? `${src.iid}:${(ab as Activated).name}` : null
  if (usageKey && (state.procMeta.used[usageKey] ?? 0) >= (ab as Activated).perTurn!) return { ok: false, reason: '【１ターンにｎ回まで】を使い切った（宣言時に使用したと見なされる 15-13-1[3]）' }
  if (ab.usableIf && !evalCond(ctx, state, env, ab.usableIf)) return { ok: false, reason: '宣言時の条件を満たさない' }

  // 宣言[3] 対象の指定（空打ちは宣言できない 11-3）
  const declChoices = ab.choices.filter((c) => c.when === 'declare')
  let given = [...(req.targets ?? [])]
  const need = declChoices.reduce((s, c) => s + c.count[1], 0)
  // 【決めたこと】FAQ ケースの約束「身代わりの targets: [ダメージを受けるキャラ, 代わりに受けるキャラ]」:
  // 選択の数より多い対象の先頭が、いま進行中の手順の当事者（ダメージの受け手・ダウンするキャラ）なら読み飛ばす
  while (given.length > need && frame && (frame.damage?.recipient === given[0] || frame.down?.iid === given[0])) given = given.slice(1)
  if (given.length > need) return { ok: false, reason: `指定した当事者のタイミングでない／対象が多すぎる: ${given.slice(0, given.length - need).map((t) => nameOf(ctx, state, t)).join('・')}` }
  const slots: Record<string, string[]> = {}
  const later: Choice[] = []
  for (const ch of declChoices) {
    const chooser = resolvePlayer(state, env, ch.chooser)
    const opts = choiceOptions(ctx, state, { ...env, slots }, ch)
    if (opts.length < ch.count[0]) return { ok: false, reason: `対象を指定できない（空打ち 11-3）: ${ch.slot}` }
    if (chooser !== req.by || given.length === 0) {
      later.push(ch)
      continue
    }
    const take = given.slice(0, ch.count[1])
    given = given.slice(take.length)
    for (const t of take) if (!opts.some((o) => o.key === t)) return { ok: false, reason: `適切な対象でない: ${nameOf(ctx, state, t)}（11-3）` }
    if (take.length < ch.count[0]) return { ok: false, reason: '対象の数が足りない' }
    slots[ch.slot] = take
  }

  // 宣言[4] 支払い方法の宣言（コストを発生させるアクションの宣言を含む）
  const { cost, unknown } = isEvent ? costOfAbility(ctx, src.cardId, null) : costOfAbility(ctx, src.cardId, (ab as Activated).name)
  const warnings: string[] = []
  if (unknown.length) warnings.push(`manual: 読めない使用代償「${unknown.join('＋')}」（人が処理）`)
  const plan = planPayment(ctx, state, req.by, isEvent ? null : src.iid, cost, req.payWith?.length ? req.payWith : null, req.payPool?.length ? req.payPool : null)
  // 16-1[4]・15-13-1[4]: 支払い方法を指定できなければ宣言の段で中断＝カードは手札に残る（FAQ:4225）
  if (!plan.ok) return { ok: false, reason: '使用代償の支払い方法を指定できない（[4]・FAQ:4225）' }
  warnings.push(...plan.warn)

  const label = isEvent ? `${info?.name ?? src.cardId}${(ab as Play).name ? `（${(ab as Play).name}）` : ''}` : (ab as Activated).name
  const decl: ProcDecl = {
    id,
    by: req.by,
    kind: isEvent ? 'event' : 'ability',
    actionType: speed,
    label,
    sourceIid: src.iid,
    targets: Object.values(slots).flat(),
    costGens: plan.costGens,
    sources: [],
    trigger: frame?.id ?? null,
    usageKey,
    eng: { cardId: src.cardId, index, slots, usePool: plan.usePool, poolIds: plan.poolIds, declared: env.declared, later: later.map((c) => c.slot) },
  }
  const actions: BoardAction[] = [{ type: 'procDeclare', by: req.by, decl }]
  return { ok: true, actions, decl, warnings }
}

/** 宣言[3] で宣言したプレイヤー自身が指定するもの（対象・装備対象・タッグの構成要素）。画面が盤面のクリックで選ばせるのに使う（R2u） */
export interface TargetSpec {
  slot: string
  min: number
  max: number
  /** カードなら iid、選択肢の名前・能力値ならその文字列 */
  options: string[]
}

export function declareTargets(state: BoardState, ctx: EngineCtx, req: DeclareReq): TargetSpec[] {
  const src = state.cards[req.source]
  if (!src || req.costGen || req.battle) return []
  const info = ctx.cards[src.cardId]
  if (!req.ability && src.zone === 'hand' && info) {
    // 17-3[3] 装備対象（フィールドのキャラ。種類の制限 17-1 は K4＝R3）・15-10-2[4] 構成要素（自分のフィールドの待機状態のキャラか手札の、名前が合う2枚）
    if (info.kind === 'i') return [{ slot: '装備対象', min: 1, max: 1, options: Object.values(state.cards).filter((c) => isCharOnField(c)).map((c) => c.iid) }]
    if (info.kind === 't') {
      const names = info.name.split('＆')
      const options = Object.values(state.cards)
        .filter((c) => c.owner === req.by && names.includes(ctx.cards[c.cardId]?.name ?? '') && ((isCharOnField(c) && c.orientation === 'ready') || c.zone === 'hand'))
        .map((c) => c.iid)
      return [{ slot: '構成要素', min: 2, max: 2, options }]
    }
    if (info.kind !== 'e') return []
  }
  const found = findAbility(ctx, src.cardId, req.ability ?? null, req.option)
  if (!found || (found.ab.kind !== 'activated' && found.ab.kind !== 'play')) return []
  const ab = found.ab as Activated | Play
  const env: Env = { self: src.iid, you: req.by, slots: {}, trigger: currentWindow(state)?.frame?.id ?? null, declId: null, declared: {} }
  return ab.choices
    .filter((c) => c.when === 'declare' && resolvePlayer(state, env, c.chooser) === req.by)
    .map((c) => ({ slot: c.slot, min: c.count[0], max: c.count[1], options: choiceOptions(ctx, state, env, c).map((o) => o.key) }))
}

function choiceOptions(ctx: EngineCtx, state: BoardState, env: Env, ch: Choice, withPrefer = true): { key: string; label: string }[] {
  const p = ch.pick
  if ('cards' in p) {
    let iids = select(ctx, state, env, p.cards)
    if (withPrefer && ch.prefer) {
      const preferred = iids.filter((it) => evalCond(ctx, state, { ...env, it }, ch.prefer!))
      if (preferred.length) iids = preferred
    }
    return iids.map((iid) => ({ key: iid, label: nameOf(ctx, state, iid) }))
  }
  if ('option' in p) return p.option.map((o) => ({ key: o, label: o }))
  // 能力値を1つ選ぶ（「このキャラの能力値１つを＋２」）。rule any だけ（maxBase・minBase は R4）
  if ('stat' in p && p.rule === 'any') return ['力', '早', '賢', '根', '感'].map((a) => ({ key: a, label: a }))
  return [] // 能力を選ぶ（模写など）は R4
}

// ───────────────────────────────────────────────────────────────
// 駆動
// ───────────────────────────────────────────────────────────────

export function drive(state: BoardState, ctx: EngineCtx, opts: { openMain?: boolean } = {}): DriveResult {
  const out: DriveResult = { state, actions: [], warnings: [], trace: [] }
  const apply = (a: BoardAction) => {
    const r = applyAction(out.state, a)
    out.state = r.state
    out.actions.push(a)
    if (r.trace) out.trace.push(...r.trace)
  }
  for (let guard = 0; guard < 5000; guard++) {
    const s = out.state
    if (s.result || s.procMeta.choice) break
    // 宣言のあとの選択（相手が対象を指定する《マジカルサンダー》FAQ:1992 など）
    const patch = declPatch(ctx, s)
    if (patch) {
      patch.forEach(apply)
      continue
    }
    const top = topFrame(s)
    if (!top) {
      // フェイズの窓: メインフェイズ（10-5-1）・終了フェイズの [2]（10-6-1）
      const actionPhase = s.turn?.phase === 'メイン' || (s.turn?.phase === '終了' && s.procMeta.phaseRun === PHASE_ACTIONS)
      if (opts.openMain !== false && !s.procMeta.base && !s.procMeta.mainClosed && actionPhase) {
        apply({ type: 'procOpenMain' })
        continue
      }
      // エントリーフェイズ（10-4）・終了フェイズ（10-6）・手札調整フェイズ（10-7）の段を始める
      const ph = s.turn?.phase
      if ((ph === 'エントリー' || ph === '終了' || ph === '手札調整') && s.procMeta.phaseRun === null) {
        apply({ type: 'procPhaseStart' })
        continue
      }
      break
    }
    if (top.status === 'enter' || top.status === 'resume' || top.status === 'done') {
      // 積んだだけの手順（盤面を直接作ったとき）は core に進めさせる
      const before = out.state
      apply({ type: 'procRun' })
      if (out.state === before) break
      continue
    }
    if (top.status !== 'engine') break
    const acts = engineStep(ctx, s, top, out.warnings)
    if (acts.length === 0) {
      out.warnings.push(`エンジンが進められない: ${top.kind}[${top.step}] ${top.engineWhat}`)
      break
    }
    const before = out.state
    acts.forEach(apply)
    if (out.state === before) {
      out.warnings.push(`エンジンの操作が受け付けられない: ${acts.map((a) => a.type).join(',')}`)
      break
    }
  }
  return out
}

/** 窓の中の宣言のうち、あとで選ぶ対象（相手が指定するなど）がまだのもの */
function declPatch(ctx: EngineCtx, state: BoardState): BoardAction[] | null {
  const decls: ProcDecl[] = []
  for (const f of state.proc) if (f.window) decls.push(...[f.window.active, f.window.nonActive].filter((d): d is ProcDecl => !!d))
  const b = state.procMeta.base
  if (b) decls.push(...[b.active, b.nonActive].filter((d): d is ProcDecl => !!d))
  for (const d of decls) {
    const later = (d.eng.later as string[] | undefined) ?? []
    if (later.length === 0) continue
    const slot = later[0]
    const found = findAbility(ctx, d.eng.cardId as string, d.kind === 'ability' ? d.label : null)
    const ab = found?.ab as Activated | Play | undefined
    const ch = ab?.choices.find((c) => c.slot === slot)
    const cid = `${d.id}:${slot}`
    const ans = state.procMeta.answers[cid]
    const slots = d.eng.slots as Record<string, string[]>
    if (ans) {
      const nextSlots = { ...slots, [slot]: ans }
      return [{ type: 'procDeclPatch', declId: d.id, targets: Object.values(nextSlots).flat(), eng: { slots: nextSlots, later: later.slice(1) } }]
    }
    if (!ch) return [{ type: 'procDeclPatch', declId: d.id, eng: { later: later.slice(1) } }]
    const env: Env = { self: d.sourceIid, you: d.by, slots, trigger: d.trigger, declId: d.id, declared: {} }
    const options = choiceOptions(ctx, state, env, ch)
    return [{ type: 'procChoice', choice: { id: cid, by: resolvePlayer(state, env, ch.chooser), kind: 'select', prompt: `${d.label}の対象（${slot}）`, options, min: ch.count[0], max: ch.count[1], frameId: null } }]
  }
  return null
}

function engineStep(ctx: EngineCtx, state: BoardState, top: ProcFrame, warnings: string[]): BoardAction[] {
  switch (top.engineWhat) {
    case 'timing':
      return [{ type: 'procTimingDone', frameId: top.id, items: timingItems(ctx, state, top) }]
    case 'pay': {
      const d = top.decl!
      const { cost } = costOfAbility(ctx, d.eng.cardId as string, d.kind === 'ability' ? d.label : null)
      const r = payNow(ctx, state, top.id, d, cost)
      if (!r.ok) warnings.push(`${d.label}: ${r.reason}`)
      return [{ type: 'procPay', frameId: top.id, ok: r.ok, consume: r.consume, kiryoku: r.kiryoku, trash: r.trash, down: r.down }]
    }
    case 'check': {
      const reason = checkTargets(ctx, state, top)
      return [{ type: 'procCheck', frameId: top.id, ok: reason === null, reason: reason ?? undefined }]
    }
    case 'effect': {
      const d = top.decl!
      if (top.countered) return [{ type: 'procEffect', frameId: top.id, items: [] }]
      const found = findAbility(ctx, d.eng.cardId as string, d.kind === 'ability' ? d.label : null, d.kind === 'event' ? optionOf(ctx, d) : undefined)
      const ab = found?.ab as Activated | Play | undefined
      if (!ab) return [{ type: 'procEffect', frameId: top.id, items: [] }]
      const env: Env = { self: d.sourceIid, you: d.by, slots: (d.eng.slots as Record<string, string[]>) ?? {}, trigger: d.trigger, declId: d.id, declared: (d.eng.declared as Env['declared']) ?? {} }
      const resolveChoices: Task[] = ab.choices.filter((c) => c.when !== 'declare').map((choice) => ({ op: { op: 'choose', choice } as Op }))
      const eng: ItemEng = { tasks: [...resolveChoices, ...ab.effect.map((op) => ({ op }))], env, started: false, optional: false, recheck: null, awaiting: null, seq: 0 }
      return [{ type: 'procEffect', frameId: top.id, items: [{ key: d.id, label: d.label, by: d.by, sourceIid: d.sourceIid, eng: eng as unknown as Record<string, unknown> }] }]
    }
    case 'item':
      return itemStep(ctx, state, top, warnings)
    case 'battleValues':
      return [{ type: 'procBattle', frameId: top.id, values: battleValues(ctx, state, top, warnings) }]
    case 'place':
      return [{ type: 'procPlace', frameId: top.id, kiryoku: placeKiryoku(ctx, state, top) }]
    default:
      return []
  }
}

/**
 * 20-4[18] 2.3.・[23]: 攻撃能力値・防御能力値。バトルカードの攻撃属性・防御属性（[16] で決まる。場を離れても有効 20-9）の
 * 今の能力値＋攻防修正。属性が能力値アイコン1つでない（特殊な攻防）・複数参加は人が入れる（K13・K9 は R4）
 */
function battleValues(ctx: EngineCtx, state: BoardState, frame: ProcFrame, warnings: string[]): Record<Seat, { atk: number; def: number } | null> {
  const b = frame.battle!
  const out: Record<Seat, { atk: number; def: number } | null> = { A: null, B: null }
  const info = b.battleCard ? ctx.cards[state.cards[b.battleCard]?.cardId ?? ''] : undefined
  const one = (x: string | undefined) => (x && x.length === 1 && '力早賢根感'.includes(x) ? x : null)
  const atkAttr = one(info?.battleAtk)
  const defAttr = one(info?.battleDef)
  if (!atkAttr || !defAttr) {
    warnings.push(`manual: バトルの攻防の値（${info?.name ?? 'バトル種目なし'}: 攻 ${info?.battleAtk ?? '?'}・防 ${info?.battleDef ?? '?'}）を人が入れる`)
    return out
  }
  for (const seat of ['A', 'B'] as Seat[]) {
    const ps = b.participants[seat]
    if (ps.length !== 1) {
      if (ps.length > 1) warnings.push('manual: 複数参加のバトルの攻防の値（K9 は R4）')
      continue
    }
    const p = ps[0]
    out[seat] = { atk: currentStat(ctx, state, p, atkAttr) + battleModOf(state, p, 'atk'), def: currentStat(ctx, state, p, defAttr) + battleModOf(state, p, 'def') }
  }
  return out
}

/** 15-10-1[13]: 呼び出しは印刷された気力。15-10-2[13]: タッグは構成要素のダメージ（気力の上限－気力）を引き継ぐ（oldrule.txt:715・FAQ:3266） */
function placeKiryoku(ctx: EngineCtx, state: BoardState, frame: ProcFrame): number | null {
  const d = frame.decl!
  const info = ctx.cards[state.cards[d.sourceIid ?? '']?.cardId ?? '']
  if (!info || info.kiryoku === null) return null
  if (frame.kind === 'call') return info.kiryoku
  // [12] でゴミ箱へ移った後なので、フィールドにいた構成要素は [12] の直前の気力を frame.eng に持つ（core が記録）
  const was = (frame.eng.componentKiryoku as Record<string, number | null> | undefined) ?? {}
  let dmg = 0
  for (const x of d.components ?? []) {
    const k = was[x]
    const max = ctx.cards[state.cards[x]?.cardId ?? '']?.kiryoku
    if (k !== undefined && k !== null && max !== null && max !== undefined) dmg += max - k
  }
  return info.kiryoku - dmg
}

/** 20-2・20-3: バトルを行うアクションの宣言（自分のメインフェイズにアクションとして・待機状態のキャラ・選択可能なバトルカード） */
function declareBattle(ctx: EngineCtx, state: BoardState, req: DeclareReq, id: string): DeclareOutcome {
  const cur = currentWindow(state)
  if (!cur || cur.frame) return { ok: false, reason: 'バトルの宣言はメインフェイズにアクションとしてのみ（20-2）' }
  if (req.by !== activeSeat(state) || state.turn?.phase !== 'メイン') return { ok: false, reason: '自分のメインフェイズでない（20-2・20-3）' }
  if (state.turn?.n === 1) return { ok: false, reason: '先攻の1ターン目はバトルを行えない（10-2-4）' }
  if (!Object.values(state.cards).some((c) => c.zone === 'battle' && !c.used)) return { ok: false, reason: '選択可能なバトルカードが無い（20-3）' }
  if (!Object.values(state.cards).some((c) => isCharOnField(c) && c.owner === req.by && c.orientation === 'ready')) return { ok: false, reason: '待機状態のキャラがいない（20-3）' }
  void ctx
  const decl = battleDecl(id, req.by)
  return { ok: true, actions: [{ type: 'procDeclare', by: req.by, decl }], decl, warnings: [] }
}

/**
 * 手札のカードを使う行動: キャラの呼び出し（15-10-1）・タッグ化（15-10-2）・アイテムの装備（17-3）・フィールドの配置（18-2）・
 * バトルカードの配置（19-2）。どれも AP がメインフェイズに行う（10-5-1）。カードの記述は要らない（原典の手順だけ）
 */
function declareCardUse(ctx: EngineCtx, state: BoardState, req: DeclareReq, id: string): DeclareOutcome {
  const cur = currentWindow(state)!
  const src = state.cards[req.source]
  const info = ctx.cards[src.cardId]
  if (cur.frame) return { ok: false, reason: '処理の途中には行えない（通常型 11-1）' }
  if (req.by !== activeSeat(state) || src.owner !== req.by) return { ok: false, reason: 'アクティブプレイヤーが自分の手札から行う（10-5-1）' }
  // 終了フェイズのアクションは特殊能力・イベント・コスト発生・その他だけ（10-6-1 oldrule.txt:422-429）
  if (state.turn && state.turn.phase !== 'メイン') return { ok: false, reason: `${state.turn.phase}フェイズには行えない（メインフェイズのアクション 10-5-1・10-6-1）` }
  const kind = ({ c: 'call', t: 'tag', i: 'equip', f: 'field', b: 'battleCard' } as const)[info.kind as 'c' | 't' | 'i' | 'f' | 'b']
  const mine = Object.values(state.cards).filter((c) => isCharOnField(c) && c.owner === req.by)
  const targets = (req.targets ?? []).filter((t) => t in state.cards)
  const eng: Record<string, unknown> = { cardId: src.cardId, usePool: true }
  let equipTo: string | null = null
  let components: string[] | undefined
  if (kind === 'call') {
    // 15-2 同名キャラ制限・キャラ数制限（宣言時の制限 15-10-1）
    if (mine.some((c) => ctx.cards[c.cardId]?.name === info.name)) return { ok: false, reason: '同名のキャラが自分のフィールドにいる（15-2）' }
    if (mine.filter((c) => c.zone !== 'leader').length >= 5) return { ok: false, reason: 'キャラ数制限（15-2）' }
  } else if (kind === 'tag') {
    // 15-10-2[4]: 構成要素の2枚（フィールドの待機状態のキャラ1体以上＋残りは手札）。名前はタッグの名前（「＆」の前後）
    const names = info.name.split('＆')
    if (targets.length !== 2) return { ok: false, reason: '構成要素の2枚を提示できない（15-10-2[4][5]）' }
    const used: string[] = []
    let onFieldN = 0
    for (const t of targets) {
      const c = state.cards[t]
      const nm = ctx.cards[c.cardId]?.name ?? ''
      if (c.owner !== req.by || !names.includes(nm) || used.includes(nm)) return { ok: false, reason: `構成要素でない: ${nm}（15-10-2）` }
      used.push(nm)
      if (isCharOnField(c)) {
        if (c.orientation !== 'ready') return { ok: false, reason: `構成要素のキャラが待機状態でない: ${nm}（15-10-2）` }
        onFieldN++
      } else if (state.cards[t].zone !== 'hand') return { ok: false, reason: `構成要素が自分のフィールドにも手札にも無い: ${nm}` }
    }
    if (onFieldN === 0) return { ok: false, reason: '構成要素のキャラが自分のフィールドに1体もいない（15-10-2）' }
    if (mine.some((c) => ctx.cards[c.cardId]?.name === info.name)) return { ok: false, reason: '同名のキャラが自分のフィールドにいる（15-2）' }
    components = targets
  } else if (kind === 'equip') {
    // 17-3[3] 装備対象（フィールドのキャラ。装備対象の種類の制限 17-1 は K4＝R3）
    equipTo = targets[0] ?? null
    if (!equipTo || !isCharOnField(state.cards[equipTo])) return { ok: false, reason: '装備対象を指定できない（17-3[5]）' }
    if (Object.values(state.cards).some((c) => c.attachedTo === equipTo && c.cardId === src.cardId)) return { ok: false, reason: '同名のアイテムを装備している（17-2・宣言時の制限）' }
  } else if (kind === 'battleCard') {
    if (Object.values(state.cards).filter((c) => c.zone === 'battle' && c.owner === req.by).length >= 3) return { ok: false, reason: 'バトルカードは3枚まで（19-1・宣言時の制限）' }
  }
  // [4] 使用代償の支払い方法の宣言（タッグ化は使用代償なし 15-10-2）
  const cost = kind === 'tag' ? { icons: [], attrs: [] } : costOfAbility(ctx, src.cardId, null).cost
  const plan = planPayment(ctx, state, req.by, null, cost, req.payWith?.length ? req.payWith : null, req.payPool?.length ? req.payPool : null)
  if (!plan.ok) return { ok: false, reason: '使用代償の支払い方法を指定できない（[4]）' }
  eng.usePool = plan.usePool
  eng.poolIds = plan.poolIds
  const label = kind === 'call' ? `呼び出し:${info.name}` : kind === 'tag' ? `タッグ化:${info.name}` : kind === 'equip' ? `装備:${info.name}` : kind === 'field' ? `フィールド配置:${info.name}` : `バトルカード配置:${info.name}`
  const decl: ProcDecl = {
    id,
    by: req.by,
    kind,
    actionType: '通常型',
    label,
    sourceIid: src.iid,
    targets,
    costGens: plan.costGens,
    sources: [],
    trigger: null,
    usageKey: null,
    eng,
    equipTo,
    components,
  }
  return { ok: true, actions: [{ type: 'procDeclare', by: req.by, decl }], decl, warnings: plan.warn }
}

/** 今の能力値（印刷値＋記録した能力値修正）。画面・FAQ テスト用 */
export { currentStat }

function optionOf(ctx: EngineCtx, d: ProcDecl): string | undefined {
  const idx = d.eng.index as number
  const ab = ctx.defs[d.eng.cardId as string]?.abilities[idx]
  return ab && ab.kind === 'play' ? ab.name : undefined
}

/** [10][12] 構成要素: 対象が失われていないか（11-4 立ち消え） */
function checkTargets(ctx: EngineCtx, state: BoardState, frame: ProcFrame): string | null {
  const d = frame.decl!
  if (d.kind === 'costGen') return null
  const found = findAbility(ctx, d.eng.cardId as string, d.kind === 'ability' ? d.label : null, d.kind === 'event' ? optionOf(ctx, d) : undefined)
  const ab = found?.ab as Activated | Play | undefined
  if (!ab) return null
  const slots = (d.eng.slots as Record<string, string[]>) ?? {}
  const env: Env = { self: d.sourceIid, you: d.by, slots, trigger: d.trigger, declId: d.id, declared: {} }
  for (const ch of ab.choices) {
    if (ch.when !== 'declare' || ch.mode !== 'target') continue
    const chosen = slots[ch.slot] ?? []
    const now = new Set(choiceOptions(ctx, state, env, ch, false).map((o) => o.key))
    for (const t of chosen) if (!now.has(t)) return `対象が失われている（立ち消え 11-4）: ${nameOf(ctx, state, t)}`
  }
  return null
}

/** タイミングの段: 処理条件がある常時効果（12-2-1）を同時処理の項目にする */
function timingItems(ctx: EngineCtx, state: BoardState, frame: ProcFrame): Omit<SimulItem, 'status' | 'type'>[] {
  const applied = (frame.eng.applied as string[] | undefined) ?? []
  const condRedirected = !!frame.eng.condRedirected
  // [28]《バトル終了時》に処理される効果（atBattleEnd で預けたもの）
  type AtEnd = { key: string; label: string; by: Seat; sourceIid: string | null; ops: Op[]; env: Env }
  const atEnd: Omit<SimulItem, 'status' | 'type'>[] =
    frame.kind === 'battle' && frame.step === 28
      ? ((frame.eng.atEnd as AtEnd[] | undefined) ?? []).map((x) => {
          const eng: ItemEng = { tasks: x.ops.map((op) => ({ op })), env: x.env, started: false, optional: false, recheck: null, awaiting: null, seq: 0 }
          return { key: x.key, label: x.label, by: x.by, sourceIid: x.sourceIid, eng: eng as unknown as Record<string, unknown> }
        })
      : []
  return [...atEnd, ...conditionalHits(ctx, state, frame)
    .filter((h) => !applied.includes(h.key))
    // H-2: 処理条件がある常時効果による受け渡しは、ダメージ1件につき1回
    .filter((h) => !(condRedirected && h.ab.effect.some((op) => op.op === 'redirectDamage')))
    .map((h) => {
      const eng: ItemEng = {
        tasks: h.ab.effect.map((op) => ({ op })),
        env: h.env,
        started: false,
        optional: h.ab.optional,
        recheck: { iid: h.iid, index: h.index, seat: h.key.includes("@") ? h.env.you : undefined },
        awaiting: null,
        seq: 0,
      }
      return { key: h.key, label: h.ab.name ?? nameOf(ctx, state, h.iid), by: h.env.you, sourceIid: h.iid, eng: eng as unknown as Record<string, unknown> }
    })]
}

// ───────────────────────────────────────────────────────────────
// 効果の Op の実行（同時処理の項目1つ）
// ───────────────────────────────────────────────────────────────

function itemStep(ctx: EngineCtx, state: BoardState, frame: ProcFrame, warnings: string[]): BoardAction[] {
  const item = frame.simul!.items.find((it) => it.status === 'running')
  if (!item) return []
  const eng = { ...(item.eng as unknown as ItemEng) }
  const save = (patch: Partial<ItemEng>): BoardAction => ({ type: 'procEngine', frameId: frame.id, item: true, patch: patch as Record<string, unknown> })
  const done = (skipped = false): BoardAction => ({ type: 'procItemDone', frameId: frame.id, skipped })

  if (!eng.started) {
    const acts: BoardAction[] = [save({ started: true })]
    if (eng.recheck && eng.env.trigger) {
      const trig = findFrame(state, eng.env.trigger)
      // H-2: 処理条件がある常時効果による受け渡しは、ダメージ1件につき1回（先に処理された《尊い犠牲》が受け渡したら、他は読み飛ばす）
      const redirectDone = !!trig?.eng.condRedirected && eng.tasks.some((t) => t.op.op === 'redirectDamage')
      if (redirectDone || !stillMatches(ctx, state, eng.recheck.iid, eng.recheck.index, eng.env.trigger, eng.recheck.seat)) {
        return [...acts, { type: 'procTrace', entry: { kind: 'name', text: `読み飛ばし:${item.label}` } }, done(true)]
      }
      // この手順（ダメージ1件など）で処理済みの効果として記録する（受け手の差し替えでやり直す段で同じ効果を二度処理しない）
      if (trig) acts.push({ type: 'procEngine', frameId: trig.id, patch: { applied: [...((trig.eng.applied as string[]) ?? []), item.key] } })
    }
    // 処理条件がある常時効果は、処理を始めたところで名前を記録する（宣言した行動は [13] で core が記録する）
    if (eng.recheck) acts.push({ type: 'procTrace', entry: { kind: 'name', text: item.label } })
    if (eng.optional) {
      const first = eng.tasks[0]?.op
      if (first && first.op === 'choose') {
        // 「〜できる」: 最初の選択で「選ばない」を許す（選ばなければ効果を使わない）
        eng.tasks = [{ ...eng.tasks[0], optionalFirst: true }, ...eng.tasks.slice(1)]
        acts[0] = save({ started: true, tasks: eng.tasks, optional: false })
      } else {
        const id = `${frame.id}:${item.key}:use`
        acts[0] = save({ started: true, awaiting: { id, kind: 'use' } })
        acts.push({ type: 'procChoice', choice: { id, by: item.by, kind: 'use', prompt: `「${item.label}」を使うか（〜できる）`, options: [{ key: 'use', label: item.label }], min: 0, max: 1, frameId: frame.id } })
      }
    }
    return acts
  }

  if (eng.awaiting) {
    const a = eng.awaiting
    const ans = state.procMeta.answers[a.id]
    if (!ans) return []
    if (a.kind === 'use') {
      if (ans.length === 0) return [save({ awaiting: null, tasks: [] }), { type: 'procTrace', entry: { kind: 'name', text: `使わない:${item.label}` } }, done()]
      return [save({ awaiting: null })]
    }
    if (a.kind === 'order') {
      const ops = a.ops ?? []
      const order = [...ans.map((k) => Number(k)).filter((i) => i >= 0 && i < ops.length)]
      for (let i = 0; i < ops.length; i++) if (!order.includes(i)) order.push(i)
      const tasks: Task[] = [...order.map((i) => ({ op: ops[i], bind: a.bind })), ...eng.tasks]
      return [save({ awaiting: null, tasks })]
    }
    // choose（「〜できる」の最初の選択で何も選ばなければ、その効果は使わない）
    const slots = { ...eng.env.slots, [a.slot!]: ans }
    if (ans.length === 0 && a.optional) return [save({ awaiting: null, tasks: [] }), { type: 'procTrace', entry: { kind: 'name', text: `使わない:${item.label}` } }, done()]
    return [save({ awaiting: null, env: { ...eng.env, slots } })]
  }

  if (eng.tasks.length === 0) return [done()]
  const task = eng.tasks[0]
  const rest = eng.tasks.slice(1)
  const env: Env = { ...eng.env, slots: { ...eng.env.slots, ...(task.bind ?? {}) } }
  const r = execOp(ctx, state, frame, item, eng, env, task, rest, warnings)
  return [save({ tasks: r.tasks, seq: eng.seq + 1, ...(r.patch ?? {}) }), ...r.actions]
}

interface OpResult {
  tasks: Task[]
  actions: BoardAction[]
  patch?: Partial<ItemEng>
}

function opLabel(op: Op): string {
  switch (op.op) {
    case 'damage':
      return 'ダメージ'
    case 'orient':
      return op.to === 'rested' ? '消耗' : '待機'
    case 'kiryoku':
      return '気力'
    case 'forEach':
      return op.do.map(opLabel).join('・')
    default:
      return op.op
  }
}

function execOp(ctx: EngineCtx, state: BoardState, frame: ProcFrame, item: SimulItem, eng: ItemEng, env: Env, task: Task, rest: Task[], warnings: string[]): OpResult {
  const op = task.op
  const refs = (r: Parameters<typeof resolveRef>[2]) => resolveRef(state, env, r)
  const manual = (note: string): OpResult => {
    warnings.push(`manual: ${item.label}: ${note}`)
    return { tasks: rest, actions: [{ type: 'procTrace', entry: { kind: 'manual', text: `人が処理: ${item.label}: ${note}` } }] }
  }
  const trigger = env.trigger ? findFrame(state, env.trigger) : undefined
  switch (op.op) {
    case 'damage': {
      // 同じまとまりの続くダメージを一緒に発生させる（同時に発生したダメージ・H-1: 受け手ごとに1件）
      const group = [task]
      let i = 0
      while (task.bundle && i < rest.length && rest[i].bundle === task.bundle && rest[i].op.op === 'damage') group.push(rest[i++])
      const damages = group.flatMap((t) => {
        const e = { ...eng.env, slots: { ...eng.env.slots, ...(t.bind ?? {}) } }
        const o = t.op as Extract<Op, { op: 'damage' }>
        const value = evalExpr(ctx, state, e, o.amount)
        return resolveRef(state, e, o.to).map((recipient) => ({ value, recipient, dealerIid: env.self, dealerSeat: env.you }))
      })
      return { tasks: rest.slice(i), actions: [{ type: 'procDamage', damages }] }
    }
    case 'kiryoku': {
      const delta = evalExpr(ctx, state, env, op.delta)
      return { tasks: rest, actions: refs(op.who).map((iid) => ({ type: 'procKiryoku', iid, delta, max: maxKiryoku(ctx, state, iid) }) as BoardAction) }
    }
    case 'setKiryoku':
      return { tasks: rest, actions: refs(op.who).map((iid) => ({ type: 'procSetKiryoku', iid, value: op.value }) as BoardAction) }
    case 'orient':
      return { tasks: rest, actions: refs(op.who).filter((iid) => isCharOnField(state.cards[iid])).map((iid) => ({ type: 'procOrient', iid, to: op.to }) as BoardAction) }
    case 'trash':
      return { tasks: rest, actions: refs(op.what).map((iid) => ({ type: 'procMove', iid, to: 'trash' }) as BoardAction) }
    case 'moveTo':
      return { tasks: rest, actions: refs(op.what).map((iid) => ({ type: 'procMove', iid, to: op.to }) as BoardAction) }
    case 'draw':
      return { tasks: rest, actions: [{ type: 'procDraw', seat: resolvePlayer(state, env, op.player), n: op.n }] }
    case 'redirectDamage': {
      const to = refs(op.to)[0]
      if (!trigger?.damage || !to) return manual('受け渡すダメージが無い')
      const acts: BoardAction[] = [{ type: 'procDamageEdit', frameId: trigger.id, recipient: to }]
      // H-2: 処理条件がある常時効果（《尊い犠牲》）による受け渡しはダメージ1件につき1回
      if (eng.recheck) acts.push({ type: 'procEngine', frameId: trigger.id, patch: { condRedirected: true } })
      return { tasks: rest, actions: acts }
    }
    case 'adjustDamage':
      if (!trigger?.damage) return manual('増減するダメージが無い')
      return { tasks: rest, actions: [{ type: 'procDamageEdit', frameId: trigger.id, delta: op.delta, all: op.scope === 'allSimultaneous' }] }
    case 'counter': {
      // H-8: 範囲は「その効果」だけ。打ち消されたイベントは手順どおりゴミ箱・使用代償は戻らない
      if (op.what === 'thisEffect') return manual('「この効果」の打ち消し')
      const r = op.what.declared
      let targetId: string | null = null
      if (r.ref === 'event' && r.role === 'declaredAction') targetId = trigger && (trigger.kind === 'ability' || trigger.kind === 'event') ? trigger.id : null
      else {
        const iid = refs(r)[0]
        targetId = iid ? findActionOf(state, iid) : null
      }
      if (!targetId) return manual('打ち消す宣言が見つからない')
      return { tasks: rest, actions: [{ type: 'procCounter', frameId: targetId }] }
    }
    case 'choose': {
      const ch = op.choice
      const chooser = resolvePlayer(state, env, ch.chooser)
      const options = choiceOptions(ctx, state, env, ch)
      const [min0, max] = ch.count
      // 対象にとる選択で、適切な対象が足りない＝立ち消え（11-4・FAQ:3623）。対象にとらない選択は、あるだけ選ぶ
      if (options.length < min0 && ch.mode === 'target') {
        return { tasks: [], actions: [{ type: 'procTrace', entry: { kind: 'abort', text: `${item.label}: 適切な対象が無い（立ち消え）`, id: item.key } }] }
      }
      if (options.length === 0) return { tasks: rest, patch: { env: { ...eng.env, slots: { ...eng.env.slots, [ch.slot]: [] } } }, actions: [] }
      const id = `${frame.id}:${item.key}:${ch.slot}:${eng.seq}`
      if (ch.repeat) {
        // 割り振り: 同じカードを何度も選べる。気力が0より小さくならない回数まで（《サバイバル》FAQ:4109）
        const caps: Record<string, number> = {}
        for (const o of options) caps[o.key] = Math.max(0, state.cards[o.key]?.kiryoku ?? 0)
        const total = Object.values(caps).reduce((a, x) => a + x, 0)
        const n = Math.min(min0, total)
        return {
          tasks: rest,
          patch: { awaiting: { id, kind: 'choose', slot: ch.slot } },
          actions: [{ type: 'procChoice', choice: { id, by: chooser, kind: 'select', prompt: `${item.label}: ${ch.slot}（割り振り）`, options, min: n, max: Math.min(max, total), repeat: true, caps, frameId: frame.id } }],
        }
      }
      const min = task.optionalFirst ? 0 : Math.min(min0, options.length)
      return {
        tasks: rest,
        patch: { awaiting: { id, kind: 'choose', slot: ch.slot, optional: task.optionalFirst } },
        actions: [{ type: 'procChoice', choice: { id, by: chooser, kind: 'select', prompt: `${item.label}: ${ch.slot}`, options, min, max, frameId: frame.id } }],
      }
    }
    case 'if':
      return { tasks: [...(evalCond(ctx, state, env, op.cond) ? op.then : op.else ?? []).map((o) => ({ op: o, bind: task.bind, bundle: task.bundle })), ...rest], actions: [] }
    case 'forEach': {
      const iids = select(ctx, state, env, op.in)
      const bundle = task.bundle ?? `${frame.id}:${item.key}:fe${eng.seq}`
      const expanded = iids.flatMap((iid) => op.do.map((o) => ({ op: o, bind: { ...(task.bind ?? {}), [op.as]: [iid] }, bundle })))
      return { tasks: [...expanded, ...rest], actions: [] }
    }
    case 'simul': {
      // 13-2 同時処理: ダメージだけならまとめて同時に発生させる。他の操作が混じるなら順を AP が決める（FAQ:1600）
      const onlyDamage = op.do.every((o) => o.op === 'damage' || (o.op === 'forEach' && o.do.every((x) => x.op === 'damage')))
      const bundle = `${frame.id}:${item.key}:si${eng.seq}`
      if (onlyDamage || op.do.length <= 1) {
        // 中の forEach もここで展開して、ダメージを1つのまとまりにする（同時に発生 FAQ:1235）
        const expanded: Task[] = op.do.flatMap((o): Task[] =>
          o.op === 'forEach'
            ? select(ctx, state, env, o.in).flatMap((iid) => o.do.map((x): Task => ({ op: x, bind: { ...(task.bind ?? {}), [o.as]: [iid] }, bundle })))
            : [{ op: o, bind: task.bind, bundle }],
        )
        return { tasks: [...expanded, ...rest], actions: [] }
      }
      const id = `${frame.id}:${item.key}:order${eng.seq}`
      return {
        tasks: rest,
        patch: { awaiting: { id, kind: 'order', ops: op.do, bind: task.bind } },
        actions: [{ type: 'procChoice', choice: { id, by: activeSeat(state), kind: 'order', prompt: `${item.label}: 同時処理の順（AP が決める 13-2）`, options: op.do.map((o, i) => ({ key: String(i), label: opLabel(o) })), min: 0, max: op.do.length, frameId: frame.id } }],
      }
    }
    case 'hole': {
      const setting = (ctx.holes ?? HOLES)[op.id as keyof typeof HOLES]
      const v = setting?.value
      const branch = v ? op.branches[v] : undefined
      if (!branch) return manual(`${op.id}: 未決の穴（人が処理）`)
      return { tasks: [...branch.map((o) => ({ op: o, bind: task.bind })), ...rest], actions: [] }
    }
    case 'manual':
      return manual(op.note)
    case 'putOntoField': {
      const what = refs(op.what)[0]
      if (!what) return { tasks: rest, actions: [] }
      let orientation: 'ready' | 'rested' = 'ready'
      if (typeof op.orientation === 'string') orientation = op.orientation
      else {
        const who = refs(op.orientation.asDeclared)[0] ?? env.self ?? ''
        orientation = env.declared[who] ?? state.cards[who]?.orientation ?? 'ready'
      }
      let kiryoku: number | undefined
      let from: string | undefined
      if (op.inheritFrom) {
        from = refs(op.inheritFrom)[0] ?? (op.inheritFrom.ref === 'self' ? env.self ?? undefined : undefined)
        const old = from ? state.cards[from] : undefined
        const oldMax = old ? ctx.cards[old.cardId]?.kiryoku ?? null : null
        const newMax = ctx.cards[state.cards[what].cardId]?.kiryoku ?? null
        // ダメージを引き継ぐ（15-4-1: ダメージ＝気力の上限－気力）
        if (old && old.kiryoku !== null && oldMax !== null && newMax !== null) kiryoku = newMax - (oldMax - old.kiryoku)
      }
      return { tasks: rest, actions: [{ type: 'procMove', iid: what, to: 'field', orientation, kiryoku, attachItemsFrom: from }] }
    }
    case 'cancelDown':
      if (!trigger?.down) return manual('ダウンしていない')
      return { tasks: rest, actions: [{ type: 'procCancelDown', frameId: trigger.id }] }
    case 'addDowns':
      return { tasks: rest, actions: [{ type: 'procAddDowns', seat: resolvePlayer(state, env, op.player), n: op.n }] }
    case 'swapZones': {
      const seat = resolvePlayer(state, env, op.player)
      const trash = Object.values(state.cards).filter((c) => c.owner === seat && c.zone === 'trash').sort((a, b) => a.index - b.index).map((c) => c.iid)
      const order = ctx.shuffle ? ctx.shuffle(trash) : trash
      if (!ctx.shuffle) warnings.push('シャッフルの並びが渡されていない（今の並びのまま）')
      return { tasks: rest, actions: [{ type: 'procSwapZones', seat, order }] }
    }
    case 'shuffle': {
      const seat = resolvePlayer(state, env, op.player)
      const deck = Object.values(state.cards).filter((c) => c.owner === seat && c.zone === 'deck').sort((a, b) => a.index - b.index).map((c) => c.iid)
      if (!ctx.shuffle) warnings.push('シャッフルの並びが渡されていない（今の並びのまま）')
      return { tasks: rest, actions: [{ type: 'shuffleDeck', owner: seat, orderedIids: ctx.shuffle ? ctx.shuffle(deck) : deck }] }
    }
    case 'offer': {
      // 相手に払うか聞く（K5）。R2a では「払わない」を既定にせず人に聞く
      return manual(`相手への問い「${op.prompt}」`)
    }
    // ── R2b
    case 'statMod': {
      // 修正を記録する（層 K3 は R3）。期間: バトル終了時まで→[28]、それ以外の能力値修正→ターン終了時（12-1・10-8）
      const stat = typeof op.stat === 'string' ? op.stat : env.slots[op.stat.slot]?.[0]
      if (!stat) return { tasks: rest, actions: [] }
      const delta = evalExpr(ctx, state, env, op.delta)
      const until = op.duration === 'endOfBattle' || op.kind === '攻防修正' ? 'battle' : 'turn'
      if (op.duration !== 'endOfBattle' && op.duration !== 'endOfTurn' && op.duration !== 'instant') warnings.push(`${item.label}: 期間「${JSON.stringify(op.duration)}」はターン終了時まで扱い（R3）`)
      return { tasks: rest, actions: refs(op.who).map((iid) => ({ type: 'procMod', iid, stat, delta, kind: op.kind, until }) as BoardAction) }
    }
    case 'battleDamage': {
      const bf = nearestBattle(state)
      if (!bf?.battle) return manual('バトル中でない')
      const b = bf.battle
      const seats: Seat[] = op.to === 'all' ? ['A', 'B'] : refs(op.to).flatMap((iid) => (['A', 'B'] as Seat[]).filter((st) => b.participants[st].includes(iid)))
      if (seats.length === 0) return manual('バトル参加キャラでない')
      const delta = op.delta !== undefined ? evalExpr(ctx, state, env, op.delta) : undefined
      return { tasks: rest, actions: seats.map((seat) => ({ type: 'procBattle', frameId: bf.id, edit: { seat, delta, set: op.set, evenIfZero: op.evenIfZero } }) as BoardAction) }
    }
    case 'firstStrike': {
      const bf = nearestBattle(state)
      if (!bf) return manual('バトル中でない')
      return { tasks: rest, actions: [{ type: 'procBattle', frameId: bf.id, firstStrike: { seat: env.you, key: env.declId ?? item.key } }] }
    }
    case 'skipBattleActions': {
      const bf = nearestBattle(state)
      if (!bf) return manual('バトル中でない')
      return { tasks: rest, actions: [{ type: 'procBattle', frameId: bf.id, skipActions: true }] }
    }
    case 'abortBattle': {
      const bf = nearestBattle(state)
      if (!bf) return manual('バトル中でない')
      return { tasks: rest, actions: [{ type: 'procBattle', frameId: bf.id, abort: `${item.label}（カードの効果）` }] }
    }
    case 'startBattle':
      return { tasks: rest, actions: [{ type: 'procStartBattle', by: env.you, id: `${env.declId ?? item.key}.battle` }] }
    case 'setBattleCard': {
      const bf = nearestBattle(state)
      const card = refs(op.card)[0]
      if (!bf || !card) return { tasks: rest, actions: [] }
      return { tasks: rest, actions: [{ type: 'procBattle', frameId: bf.id, battleCard: card }] }
    }
    case 'putBattleCard':
      return { tasks: rest, actions: refs(op.what).map((iid) => ({ type: 'procMove', iid, to: 'battle', owner: env.you }) as BoardAction) }
    case 'atBattleEnd': {
      const bf = nearestBattle(state)
      if (!bf) return manual('バトル中でない')
      const atEnd = [...((bf.eng.atEnd as unknown[]) ?? []), { key: `${item.key}:end${eng.seq}`, label: `${item.label}（バトル終了時）`, by: env.you, sourceIid: env.self, ops: op.do, env }]
      return { tasks: rest, actions: [{ type: 'procEngine', frameId: bf.id, patch: { atEnd } }] }
    }
    case 'moveItem': {
      const it = refs(op.item)[0]
      const to = refs(op.to)[0]
      if (!it || !to) return { tasks: rest, actions: [] }
      return { tasks: rest, actions: [{ type: 'procTransfer', by: env.you, item: it, to, id: `${env.declId ?? item.key}.mv${eng.seq}` }] }
    }
    case 'down':
      return { tasks: rest, actions: refs(op.who).map((iid) => ({ type: 'procDown', iid }) as BoardAction) }
    default:
      return manual(`R2a の範囲外の操作 ${op.op}`)
  }
}

/** そのカードの宣言された特殊能力（処理中のフレームか、まだ処理されていない宣言） */
function findActionOf(state: BoardState, iid: string): string | null {
  for (let i = state.proc.length - 1; i >= 0; i--) {
    const f = state.proc[i]
    if ((f.kind === 'ability' || f.kind === 'event') && f.decl?.sourceIid === iid && f.status !== 'done') return f.id
    for (const it of f.simul?.items ?? []) if (it.decl?.sourceIid === iid && it.status === 'pending') return it.decl.id
    for (const d of [f.window?.active, f.window?.nonActive]) if (d?.sourceIid === iid) return d.id
  }
  return null
}

// ───────────────────────────────────────────────────────────────
// 状況を作る（FAQ テストの force・画面の手動操作）
// ───────────────────────────────────────────────────────────────

/** Op を1つ、どの宣言にも属さない効果として積む（AP が起こしたものとして扱う） */
export function forceOp(state: BoardState, op: Op, bind: Record<string, string[]> = {}): BoardAction {
  const you = activeSeat(state)
  const eng: ItemEng = { tasks: [{ op }], env: { self: null, you, slots: bind, trigger: null, declId: null, declared: {} }, started: false, optional: false, recheck: null, awaiting: null, seq: 0 }
  return { type: 'procStart', item: { key: 'force', label: '状況を作る', by: you, sourceIid: null, eng: eng as unknown as Record<string, unknown> } }
}

/** 選択肢の答えを作る小道具（画面・テスト用）: 答えの中身が選択肢にあるか */
export function validPick(choice: ProcChoice, pick: string[]): boolean {
  if (pick.length < choice.min || pick.length > choice.max) return false
  const keys = choice.options.map((o) => o.key)
  if (!pick.every((p) => keys.includes(p))) return false
  return choice.repeat || new Set(pick).size === pick.length
}

export { other, parseCostText }
