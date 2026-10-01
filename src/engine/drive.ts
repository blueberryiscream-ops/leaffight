/*
 * エンジンの駆動 — PHASE-R2a §2-4・DESIGN §5.4
 *
 * drive(state, ctx): core が止まった点を見て、エンジンが自分で進められるもの（タイミングでの処理条件がある常時効果・
 * 使用代償の支払い・構成要素の確かめ・効果の Op の実行）を BoardAction にして core に渡し、プレイヤーの入力が要る点
 * （窓・選択）まで進めて返す。返り値は「適用した BoardAction の列＋最終状態＋警告＋処理の記録」。
 * 宣言（declare）: プレイヤーの宣言を、宣言[1]〜[5]（対象・支払い方法・コスト発生の宣言）を済ませた ProcDecl にする。
 *
 * 警告（R2a）は「manual に倒れた」「カードの記述が無い」の2種類。
 * R3: 合法性の判定（K4）は declare の答えの violations（止めずに警告）。drive は状態が変わるたびに継続効果の層を足し外しし（K3）、
 * 場の制限を是正し（K12）、ダメージ[5] の前に「ダメージを受けない」を当てる（engine/layers.ts）。
 */

import { applyAction, type BoardAction } from '../core/actions'
import type { BoardState, Seat } from '../core/board'
import { parseCost } from '../core/types'
import {
  MAIN_ACTIONS,
  PHASE_ACTIONS,
  STEP_TIMINGS,
  activeSeat,
  awaitingSeat,
  currentWindow,
  findFrame,
  battleDecl,
  nearestBattle,
  topFrame,
  type BattleState,
  type CostSource,
  type ProcChoice,
  type ProcDecl,
  type ProcFrame,
  type ProcTrace,
  type SimulItem,
} from '../core/proc'
import { conditionalHits, findAbility, stillMatches, triggerMatches, type Activated, type Conditional, type Play } from './abilities'
import { controllerOf, infoOf, isCharOnField, nameOf, other, type EngineCtx, type Env } from './ctx'
import { attrsOf, costOfAbility, effectiveCost, parseCostText, payNow, planPayment } from './cost'
import { ENFORCE } from './enforce'
import type { Ability, Attr, BattleExpr, CardRef, Choice, CostIcon, Op, Selector } from './dsl'
import { battleModOf, currentStat, evalCond, evalExpr, resolvePlayer, resolveRef, select } from './eval'
import { HOLES } from './holes'
import { ATTRS, clearableMods, collectEffectTargets, continuousSeed, damagePrevented, isCharSource, limitFix, maxKiryokuOf, modSeed, swapChoiceFix, syncActions, untargetableBy, violations, type Violation } from './layers'

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
  /** 選択の答えを待っている。offer（K5・D8）: 払うか（'pay' を選べば払う・選ばなければ払わない）の答えを待つ */
  awaiting: {
    id: string
    kind: 'use' | 'choose' | 'order' | 'offer' | 'payByPlayer'
    slot?: string
    optional?: boolean
    ops?: Op[]
    bind?: Record<string, string[]>
    payOps?: Op[]
    ifPaidOps?: Op[]
    ifDeclinedOps?: Op[]
    /**
     * payByPlayer（PHASE-R4b §2(D)・R4b-3a）: 段階を追って進める。
     * ask（発生させるか）→source（発生源。0件でもよい）→genPending（procStartCostGen で積んだ 7-2 の宣言が終わるのを待つ）→
     * tokens（発生済みのコストから払うトークンを選ぶ。プールがちょうど amount 分ならここへは来ず自動で払う）
     */
    pay?: {
      stage: 'ask' | 'source' | 'genPending' | 'tokens'
      who: Seat
      giveTo: Seat | null
      /** amount { chosen:true }（R4b-3a-2・交渉売買）: 'chosen'＝払う数も who が選ぶ（0可） */
      amount: CostIcon[] | 'chosen'
      recordAs?: string
      /** 交渉売買 R4b-3a-2: 払った数を今のバトルの battle.paid[who] に積む */
      addToBattlePaid?: boolean
      ifPaid: Op[]
      ifNot: Op[]
      genDeclId?: string
    }
  } | null
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

/**
 * ok でも violations があれば、カードの効果による禁止・強制・対象にならない（K4）に当たっている＝警告して、確認のうえ通す（R3・DESIGN §5.4「段階」）。
 * ok: false は原典の手順の規則（窓・支払い・宣言時の制限など）で断ったもの
 */
export type DeclareOutcome =
  | { ok: true; actions: BoardAction[]; decl: ProcDecl; warnings: string[]; violations: Violation[] }
  | { ok: false; reason: string; missingDef?: boolean; manual?: boolean; blocked?: Violation[] }

/** 今の窓で、その宣言ができるか（できるなら BoardAction の列を返す）。
 *  「次のうち１つ」のカードで option が無ければ、選択肢を順に試して最初に合法なものを使う */
export function declare(state: BoardState, ctx: EngineCtx, req: DeclareReq): DeclareOutcome {
  const src = state.cards[req.source]
  const plays = src && !req.ability && !req.option && !req.costGen ? (ctx.defs[src.cardId]?.abilities ?? []).filter((a) => a.kind === 'play' && a.name) : []
  if (plays.length > 1) {
    let first: DeclareOutcome | null = null
    for (const p of plays) {
      const out = withViolations(state, ctx, declareOne(state, ctx, { ...req, option: (p as Play).name }))
      if (out.ok && out.violations.length === 0) return out
      if (out.ok && (!first || !first.ok)) first = out
      first ??= out
    }
    return first!
  }
  return withViolations(state, ctx, declareOne(state, ctx, req))
}

/**
 * K4（R3）: 宣言[1]〜[5] を済ませた宣言を、層の「禁止・対象にならない・特殊能力を失う」と装備対象（17-1）に照らす。
 * D9（R4a）: ENFORCE==='tested' のとき、tested のカードの記述から来た違反だけ declare を断る（ok:false・根拠つき）。
 * draft のカードの違反は今までどおり警告（ok:true・violations に残す）
 */
function withViolations(state: BoardState, ctx: EngineCtx, out: Omit<Extract<DeclareOutcome, { ok: true }>, 'violations'> | Extract<DeclareOutcome, { ok: false }>): DeclareOutcome {
  if (!out.ok) return out
  const vs = violations(ctx, state, out.decl)
  if (ENFORCE === 'tested') {
    const isTested = (iid: string | null) => !!iid && ctx.defs[state.cards[iid]?.cardId ?? '']?.status === 'tested'
    const blocked = vs.filter((v) => isTested(v.sourceIid))
    if (blocked.length) return { ok: false, reason: `断る（tested のカードの効果・K4）: ${blocked.map((v) => v.text).join('／')}`, blocked }
  }
  return { ...out, violations: vs }
}

type DeclareOne = Omit<Extract<DeclareOutcome, { ok: true }>, 'violations'> | Extract<DeclareOutcome, { ok: false }>

function declareOne(state: BoardState, ctx: EngineCtx, req: DeclareReq): DeclareOne {
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
  const { cost: printedCost, unknown } = isEvent ? costOfAbility(ctx, src.cardId, null) : costOfAbility(ctx, src.cardId, (ab as Activated).name)
  const warnings: string[] = []
  if (unknown.length) warnings.push(`manual: 読めない使用代償「${unknown.join('＋')}」（人が処理）`)
  // K6（D3）: costMod（増減）を今の状態でまとめて適用したもので支払い方法を宣言する（払う段 [9] でも同じ一か所を通す＝engineStep 'pay'）
  const cost = effectiveCost(ctx, state, isEvent ? 'event' : 'ability', req.by, src.iid, Object.values(slots).flat(), printedCost)
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
  // 数を選ぶ（D16・世話焼き）。上限は無いが候補は実装で有限に区切る（今のプールの気力の実務上の範囲を広めに超える20まで）
  if ('number' in p) {
    const NUMBER_PICK_CAP = 20
    const out: { key: string; label: string }[] = []
    for (let n = p.number.min; n <= NUMBER_PICK_CAP; n++) out.push({ key: String(n), label: String(n) })
    return out
  }
  // 能力値を1つ選ぶ（「このキャラの能力値１つを＋２」）。rule any だけ（maxBase・minBase は R4）
  if ('stat' in p && p.rule === 'any') return ['力', '早', '賢', '根', '感'].map((a) => ({ key: a, label: a }))
  // プレイヤーを選ぶ（D20・借金取り）。候補は chooser の相手だけ（NH-20：自分は選べない）
  if ('player' in p) {
    const seat = other(resolvePlayer(state, env, ch.chooser))
    return [{ key: seat, label: `プレイヤー${seat}` }]
  }
  return [] // 能力を選ぶ（模写など）は R4
}

// ───────────────────────────────────────────────────────────────
// 駆動
// ───────────────────────────────────────────────────────────────

/**
 * opts.askValues: [23] の攻防の値をエンジンが出せない（特殊な攻防・複数参加）とき、人の入力を待って止まる（画面の層。R2u-2）。
 * 無いとき（FAQ テスト）は今までどおり manual の警告を出して値なしで進める
 */
export function drive(state: BoardState, ctx: EngineCtx, opts: { openMain?: boolean; askValues?: boolean } = {}): DriveResult {
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
    // K3（R3）: 状態が変わるたびに継続効果の層を足し外しする（常時効果・期限・効果が失われたときの処理・常に消耗状態・気力の上限）
    const sync = syncActions(ctx, s)
    if (sync.length) {
      const before = out.state
      sync.forEach(apply)
      if (out.state === before) {
        out.warnings.push('継続効果の層の足し外しが受け付けられない')
        break
      }
      continue
    }
    // K12（R3）: 場の制限の是正（15-2・17-1・17-2・19-1。違反なら使用権者が選ぶ）
    const fix = limitFix(ctx, s)
    if (fix) {
      const before = out.state
      apply(fix)
      if (out.state === before) {
        out.warnings.push('場の制限の是正が受け付けられない')
        break
      }
      continue
    }
    // H-6（D1）: 性格反転キノコの類で入れ替える能力値が並んだら、装備させたプレイヤーに装備するたびに1回選ばせる（FAQ:443）
    const swapChoice = swapChoiceFix(ctx, s)
    if (swapChoice) {
      const before = out.state
      apply(swapChoice)
      if (out.state === before) {
        out.warnings.push('H-6 の入れ替えの選択が受け付けられない')
        break
      }
      continue
    }
    // 「ダメージを受けない」（15-4-2[5] の前＝身代わりの後 FAQ:1706）。[5] の窓で誰も宣言していないうちに当てる
    const top0 = topFrame(s)
    if (top0?.kind === 'damage' && top0.step === 5 && top0.status === 'window' && top0.window?.state === 'awaitActive' && !top0.window.active && !top0.eng.receiveChecked) {
      const why = damagePrevented(ctx, s, top0)
      apply(why ? { type: 'procDamageEdit', frameId: top0.id, prevent: why } : { type: 'procEngine', frameId: top0.id, patch: { receiveChecked: true } })
      continue
    }
    // 宣言のあとの選択（相手が対象を指定する《マジカルサンダー》FAQ:1992 など）
    const patch = declPatch(ctx, s)
    if (patch) {
      patch.forEach(apply)
      continue
    }
    const top = topFrame(s)
    if (!top) {
      // フェイズの窓: メインフェイズの [2]（10-5-1）・終了フェイズの [2]（10-6-1）。ターンの番号が無い盤面（FAQ テスト）はメインの窓から
      const numbered = s.turn?.n !== undefined
      const actionPhase =
        (s.turn?.phase === 'メイン' && (numbered ? s.procMeta.phaseRun === MAIN_ACTIONS : true)) || (s.turn?.phase === '終了' && s.procMeta.phaseRun === PHASE_ACTIONS)
      if (opts.openMain !== false && !s.procMeta.base && !s.procMeta.mainClosed && actionPhase) {
        apply({ type: 'procOpenMain' })
        continue
      }
      // エントリーフェイズ（10-4）・メインフェイズ（10-5。ターンの番号がある盤面だけ）・終了フェイズ（10-6）・手札調整フェイズ（10-7）の段を始める
      const ph = s.turn?.phase
      if ((ph === 'エントリー' || (ph === 'メイン' && numbered) || ph === '終了' || ph === '手札調整') && s.procMeta.phaseRun === null) {
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
    // [23] 攻防の値をエンジンが出せなければ人の入力（EngineReq.values）を待つ
    if (opts.askValues && top.engineWhat === 'battleValues') {
      const w: string[] = []
      const v = battleValues(ctx, s, top, w)
      if (!v.A || !v.B) {
        out.warnings.push(...w, '[23] 攻防の値を入れてください（バトル欄）')
        break
      }
    }
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
      const { cost: printedCost } = costOfAbility(ctx, d.eng.cardId as string, d.kind === 'ability' ? d.label : null)
      // K6（D3）: 払う段で改めて評価する（declareOne と同じ effectiveCost）
      const cost = effectiveCost(ctx, state, d.kind, d.by, d.sourceIid, d.targets, printedCost)
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
      const found = abilityOf(ctx, d)
      const ab = found?.ab as Activated | Play | Conditional | undefined
      // NH-17（D15・R4a-2）: 処理条件がある常時効果（回復を含むもの）を decl 化した合成の宣言（timingItems 参照）は
      // ab.kind==='conditional'。choices を持たない（対象は元から取らない・宣言時の選択も無い）
      if (!ab || (ab.kind !== 'activated' && ab.kind !== 'play' && ab.kind !== 'conditional')) return [{ type: 'procEffect', frameId: top.id, items: [] }]
      const env: Env = { self: d.sourceIid, you: d.by, slots: (d.eng.slots as Record<string, string[]>) ?? {}, trigger: d.trigger, declId: d.id, declared: (d.eng.declared as Env['declared']) ?? {} }
      const resolveChoices: Task[] = ab.kind === 'conditional' ? [] : ab.choices.filter((c) => c.when !== 'declare').map((choice) => ({ op: { op: 'choose', choice } as Op }))
      // D23: 部分的な打ち消し（おあずけ）。counterPart:'draw' なら、この効果の中の op:'draw' だけ実行しない（他は今までどおり）
      const dropDraw = (ops: Op[]): Op[] => ops.filter((o) => o.op !== 'draw')
      const effectOps = top.counterPart === 'draw' ? dropDraw(ab.effect) : ab.effect
      const eng: ItemEng = { tasks: [...resolveChoices, ...effectOps.map((op) => ({ op }))], env, started: false, optional: false, recheck: null, awaiting: null, seq: 0 }
      return [{ type: 'procEffect', frameId: top.id, items: [{ key: d.id, label: d.label, by: d.by, sourceIid: d.sourceIid, eng: eng as unknown as Record<string, unknown> }] }]
    }
    case 'item':
      return itemStep(ctx, state, top, warnings)
    case 'battleValues': {
      // R4b-3a-2（交渉売買・NH-21）: [23] の値を求める前に、BattleExpr が { paid: true } を使うカードなら
      // 挑んだプレイヤーから交互に payByPlayer（amount { chosen:true }）を行う（FAQ:3912）。二重に積まないよう negotiated で控える
      const b = top.battle!
      const cardDef = b.battleCard ? ctx.defs[state.cards[b.battleCard]?.cardId ?? ''] : undefined
      const usesPaid = (e?: BattleExpr) => !!e && 'paid' in e
      if (cardDef?.battle && (usesPaid(cardDef.battle.atk) || usesPaid(cardDef.battle.def)) && !b.negotiated) {
        return [{ type: 'procBattle', frameId: top.id, negotiated: true }, forceOp(state, negotiateChain('challenger', 60), {}, '交渉（[23]の交互の支払い）')]
      }
      return [{ type: 'procBattle', frameId: top.id, values: battleValues(ctx, state, top, warnings), dmgCap: cardDef?.battle?.dmgCap, dmgHalf: cardDef?.battle?.dmgHalf }]
    }
    case 'place':
      return [{ type: 'procPlace', frameId: top.id, kiryoku: placeKiryoku(ctx, state, top) }]
    default:
      return []
  }
}

/**
 * BattleExpr を1参加キャラについて評価する（[23]・K13。統括16で attr/chosenStat/sum/const に足した6種）。
 * null＝書けない（none・manual、または chosenStat が未選択）＝そのバトル全体を人が入れる
 */
export function evalBattleExpr(ctx: EngineCtx, state: BoardState, iid: string, seat: Seat, b: BattleState, expr: BattleExpr): number | null {
  if ('attr' in expr) return currentStat(ctx, state, iid, expr.attr)
  if ('chosenStat' in expr) {
    const chosen = b.battleChoices[seat]
    return chosen ? currentStat(ctx, state, iid, chosen) + expr.plus : null
  }
  if ('sum' in expr) {
    let total = 0
    for (const x of expr.sum) {
      const v = evalBattleExpr(ctx, state, iid, seat, b, x)
      if (v === null) return null
      total += v
    }
    return total
  }
  if ('sub' in expr) {
    const a = evalBattleExpr(ctx, state, iid, seat, b, expr.sub[0])
    const c = evalBattleExpr(ctx, state, iid, seat, b, expr.sub[1])
    return a === null || c === null ? null : a - c
  }
  if ('statPick' in expr) {
    // FAQ:3840-3841: 同値が複数あれば使用者が決める（タイブレークは manual に倒す。R4b-2 以降のカードで要る）
    const vals = ATTRS.map((a) => currentStat(ctx, state, iid, a))
    return expr.statPick === 'max' ? Math.max(...vals) : Math.min(...vals)
  }
  if ('kiryoku' in expr) return state.cards[iid]?.kiryoku ?? 0
  if ('count' in expr) {
    const env: Env = { self: iid, you: seat, slots: {}, trigger: null, declId: null, declared: {} }
    return select(ctx, state, env, expr.count).length
  }
  if ('itemCost' in expr) {
    return Object.values(state.cards)
      .filter((c) => c.attachedTo === iid)
      .reduce((s, c) => s + [...(ctx.cards[c.cardId]?.cost ?? '')].filter((ch) => 'WRGLT'.includes(ch)).length, 0)
  }
  if ('const' in expr) return expr.const
  if ('paid' in expr) return b.paid[seat]
  // none・manual: 書けない（攻防が無いカード・記述の途中）
  return null
}

/**
 * 20-4[18] 2.3.・[23]: 攻撃能力値・防御能力値。バトルカードの攻撃属性・防御属性（[16] で決まる。場を離れても有効 20-9）の
 * 今の能力値＋攻防修正。K9（統括16）: 参加キャラごとに評価する（複数参加は参加キャラごとに値が要る。全員ぶん出せなければ
 * その席は人が入れる）。K13: カードの記述（defs[].battle）があれば BattleExpr として評価。無ければ基本バトルカード
 * （属性のみ・テキストなし）を {attr} として評価する
 */
export function battleValues(ctx: EngineCtx, state: BoardState, frame: ProcFrame, warnings: string[]): Record<Seat, Record<string, { atk: number; def: number; rounds?: { atk: number; def: number }[] }> | null> {
  const b = frame.battle!
  const out: Record<Seat, Record<string, { atk: number; def: number; rounds?: { atk: number; def: number }[] }> | null> = { A: null, B: null }
  const info = b.battleCard ? ctx.cards[state.cards[b.battleCard]?.cardId ?? ''] : undefined
  const cardDef = b.battleCard ? ctx.defs[state.cards[b.battleCard]?.cardId ?? ''] : undefined
  const one = (x: string | undefined): Attr | null => (x && x.length === 1 && '力早賢根感'.includes(x) ? (x as Attr) : null)
  const atkAttr = one(info?.battleAtk)
  const defAttr = one(info?.battleDef)
  const atkExpr: BattleExpr | null = cardDef?.battle?.atk ?? (atkAttr ? { attr: atkAttr } : null)
  const defExpr: BattleExpr | null = cardDef?.battle?.def ?? (defAttr ? { attr: defAttr } : null)
  if (!atkExpr || !defExpr) {
    warnings.push(`manual: バトルの攻防の値（${info?.name ?? 'バトル種目なし'}: 攻 ${info?.battleAtk ?? '?'}・防 ${info?.battleDef ?? '?'}）を人が入れる`)
    return out
  }
  // テキストのあるバトルカードは、カードの記述（defs）が無ければ効果が値に効きうるので人が入れる（統括11）
  if (info && info.abilities.length > 0 && !cardDef) {
    warnings.push(`manual: バトルの攻防の値（${info.name} はテキストのあるバトルカードで記述が無い）を人が入れる`)
    return out
  }
  // リラクゼーション「-/-」＝攻防が存在しない（FAQ:1446-1447「結果には影響しない」）。evalBattleExpr の none は
  // 「計算できない（manual・人が入れる）」と区別できないため、ここで先に弾く。値そのものが無い＝そのバトルの
  // 結果ダメージは0件（値を求めず参加キャラごと空のまま。修正前は none も evalBattleExpr が null を返す他の
  // ケースと同列に扱われ「複数参加のバトルの攻防の値を人が入れる」に落ちていた＝R4b-2b で修正）
  const isNone = (e: BattleExpr) => 'none' in e
  for (const seat of ['A', 'B'] as Seat[]) {
    const ps = b.participants[seat].filter((x) => isCharOnField(state.cards[x]))
    if (ps.length === 0) continue
    if (isNone(atkExpr) && isNone(defExpr)) {
      out[seat] = {}
      continue
    }
    const values: Record<string, { atk: number; def: number; rounds?: { atk: number; def: number }[] }> = {}
    let ok = true
    for (const p of ps) {
      const atk = evalBattleExpr(ctx, state, p, seat, b, atkExpr)
      const def = evalBattleExpr(ctx, state, p, seat, b, defExpr)
      if (atk === null || def === null) {
        ok = false
        break
      }
      values[p] = { atk: atk + battleModOf(ctx, state, p, 'atk'), def: def + battleModOf(ctx, state, p, 'def') }
      // 複数回計算（鶴来屋温泉三本勝負）: 各回の攻防を求める。攻防修正は失われる（shieldParticipants mods）ので各回には足さない
      if (cardDef?.battle?.rounds) {
        const rs: { atk: number; def: number }[] = []
        for (const r of cardDef.battle.rounds) {
          const ra = evalBattleExpr(ctx, state, p, seat, b, r.atk)
          const rd = evalBattleExpr(ctx, state, p, seat, b, r.def)
          if (ra === null || rd === null) { ok = false; break }
          rs.push({ atk: ra, def: rd })
        }
        values[p].rounds = rs
      }
    }
    if (ok) out[seat] = values
    else warnings.push(`manual: 複数参加のバトルの攻防の値（${seat} 席・K9）を人が入れる`)
  }
  return out
}

/** 15-10-1[13]: 呼び出しは印刷された気力。15-10-2[13]: タッグは構成要素のダメージ（気力の上限－気力）を引き継ぐ（oldrule.txt:715・FAQ:3266）。
 *  kind summon（D17・効果で呼び出す）も呼び出しと同じ＝印刷された気力 */
function placeKiryoku(ctx: EngineCtx, state: BoardState, frame: ProcFrame): number | null {
  if (frame.kind === 'summon') {
    const info = ctx.cards[state.cards[frame.summon!.iid]?.cardId ?? '']
    return info?.kiryoku ?? null
  }
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
function declareBattle(ctx: EngineCtx, state: BoardState, req: DeclareReq, id: string): DeclareOne {
  const cur = currentWindow(state)
  if (!cur || cur.frame) return { ok: false, reason: 'バトルの宣言はメインフェイズにアクションとしてのみ（20-2）' }
  if (req.by !== activeSeat(state) || state.turn?.phase !== 'メイン') return { ok: false, reason: '自分のメインフェイズでない（20-2・20-3）' }
  if (state.turn?.n === 1) return { ok: false, reason: '先攻の1ターン目はバトルを行えない（10-2-4）' }
  if (!Object.values(state.cards).some((c) => c.zone === 'battle' && !c.used && !state.layers.unusable.includes(c.iid))) return { ok: false, reason: '選択可能なバトルカードが無い（20-3）' }
  if (!Object.values(state.cards).some((c) => isCharOnField(c) && c.owner === req.by && c.orientation === 'ready')) return { ok: false, reason: '待機状態のキャラがいない（20-3）' }
  void ctx
  const decl = battleDecl(id, req.by)
  return { ok: true, actions: [{ type: 'procDeclare', by: req.by, decl }], decl, warnings: [] }
}

/**
 * 手札のカードを使う行動: キャラの呼び出し（15-10-1）・タッグ化（15-10-2）・アイテムの装備（17-3）・フィールドの配置（18-2）・
 * バトルカードの配置（19-2）。どれも AP がメインフェイズに行う（10-5-1）。カードの記述は要らない（原典の手順だけ）
 */
function declareCardUse(ctx: EngineCtx, state: BoardState, req: DeclareReq, id: string): DeclareOne {
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
  // [4] 使用代償の支払い方法の宣言（タッグ化は使用代償なし 15-10-2）。K6（D3）: costMod をここでも同じ effectiveCost でまとめて適用
  const printedCost = kind === 'tag' ? { icons: [], attrs: [] } : costOfAbility(ctx, src.cardId, null).cost
  const cost = kind === 'tag' ? printedCost : effectiveCost(ctx, state, kind, req.by, null, targets, printedCost)
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

/** 今の能力値（継続効果の層から導き出す R3）。画面・FAQ テスト用 */
export { currentStat }

function optionOf(ctx: EngineCtx, d: ProcDecl): string | undefined {
  const idx = d.eng.index as number
  const ab = ctx.defs[d.eng.cardId as string]?.abilities[idx]
  return ab && ab.kind === 'play' ? ab.name : undefined
}

/**
 * NH-17（D15・R4a-2）: 処理条件がある常時効果（12-2-1）を decl 化した合成の宣言（timingItems 参照）は、
 * 元の能力に name が無いことが多い（選択肢の無い Auto は名前を持たない）ので、findAbility の名前一致では
 * 再び見つけられないことがある。d.eng.index（decl 化したときに控えた元の能力の番号）が指す先が conditional
 * ならそれを直接使う（1枚のカードで conditional は複数あり得るので index を優先する）
 */
function abilityOf(ctx: EngineCtx, d: ProcDecl): { ab: Ability; index: number } | null {
  const idx = d.eng.index as number | undefined
  if (idx !== undefined) {
    const ab = ctx.defs[d.eng.cardId as string]?.abilities[idx]
    if (ab && ab.kind === 'conditional') return { ab, index: idx }
  }
  return findAbility(ctx, d.eng.cardId as string, d.kind === 'ability' ? d.label : null, d.kind === 'event' ? optionOf(ctx, d) : undefined)
}

/** [10][12] 構成要素: 対象が失われていないか（11-4 立ち消え） */
function checkTargets(ctx: EngineCtx, state: BoardState, frame: ProcFrame): string | null {
  const d = frame.decl!
  if (d.kind === 'costGen') return null
  const found = abilityOf(ctx, d)
  const ab = found?.ab as Activated | Play | Conditional | undefined
  if (!ab || ab.kind === 'conditional') return null // NH-17: 合成の宣言は対象を declare 時にとらない（choices が無い）
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
      // NH-17（D15・R4a-2）: 気力を回復させる操作（kiryoku recover:true）を含む処理条件がある常時効果は、
      // 回復を適用する前に《効果が発生したとき》のアクション宣言の機会を持つ（幸せ泥棒を使える FAQ:2836）。
      // 合成の「宣言」（kind:'ability'。宣言[1]〜[5]は無い＝ [6] から。cardId・index は元のキャラの由来のまま）を
      // decl 化して 15-13-1 相当の 8/11/13 の窓（STEP_TIMINGS.ability）を持たせる（type:'action' の同時処理項目）
      const hasRecover = h.ab.effect.some((op) => op.op === 'kiryoku' && op.recover)
      if (hasRecover) {
        const decl: ProcDecl = {
          id: `${frame.id}:${h.key}`,
          by: h.env.you,
          kind: 'ability',
          actionType: '通常型',
          label: h.ab.name ?? nameOf(ctx, state, h.iid),
          sourceIid: h.iid,
          targets: [],
          costGens: [],
          sources: [],
          trigger: frame.id,
          usageKey: null,
          eng: { cardId: state.cards[h.iid]?.cardId, index: h.index, slots: {}, usePool: true, poolIds: [], declared: {}, later: [], synthetic: true },
        }
        return { key: h.key, label: decl.label, by: h.env.you, sourceIid: h.iid, decl, eng: {} as Record<string, unknown> }
      }
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

type ItemAwaiting = NonNullable<ItemEng['awaiting']>
type PayState = NonNullable<ItemAwaiting['pay']>

/** payByPlayer: 発生済みのコスト（board.costs[seat]）から amount 分を払う手筈を整える（'tokens' 段の入口）。
 *  プールが足りなければ ifNot、ちょうどなら自動で払う、余りがあれば「どれを払うか」を問う */
function finishPayFromPool(
  state: BoardState,
  frame: ProcFrame,
  item: SimulItem,
  eng: ItemEng,
  save: (patch: Partial<ItemEng>) => BoardAction,
  a: ItemAwaiting,
  pay: PayState,
): BoardAction[] {
  const pool = state.costs[pay.who] ?? []
  if (pay.amount === 'chosen') {
    // R4b-3a-2（交渉売買）: 払う数も who が選ぶ（0可・FAQ:3918「まだ払える状態でも払わないことができる」）
    if (pool.length === 0) return finishPay(state, item, eng, save, pay, [])
    const id3 = `${a.id}:tok`
    return [
      save({ awaiting: { ...a, id: id3, pay: { ...pay, stage: 'tokens' } } }),
      {
        type: 'procChoice',
        choice: {
          id: id3,
          by: pay.who,
          kind: 'select',
          prompt: '払うＷの数（0でもよい。どのアイコンも W として払える。7-1-1）',
          options: pool.map((t) => ({ key: t.id, label: `${t.icon}${t.attrs.join('')}` })),
          min: 0,
          max: pool.length,
          frameId: frame.id,
        },
      },
    ]
  }
  if (pool.length < pay.amount.length) {
    const tasks: Task[] = [...pay.ifNot.map((op) => ({ op })), ...eng.tasks]
    return [save({ awaiting: null, tasks }), { type: 'procTrace', entry: { kind: 'name', text: `払えない:${item.label}` } }]
  }
  if (pool.length === pay.amount.length) return finishPay(state, item, eng, save, pay, pool.map((t) => t.id))
  const id3 = `${a.id}:tok`
  return [
    save({ awaiting: { ...a, id: id3, pay: { ...pay, stage: 'tokens' } } }),
    {
      type: 'procChoice',
      choice: { id: id3, by: pay.who, kind: 'select', prompt: '払うトークン（どのアイコンも W として払える。7-1-1）', options: pool.map((t) => ({ key: t.id, label: `${t.icon}${t.attrs.join('')}` })), min: pay.amount.length, max: pay.amount.length, frameId: frame.id },
    },
  ]
}

/** payByPlayer: 選んだトークンを実際に払う（procPayCost）。ifPaid/ifNot へ進む
 *  amount { chosen:true }: 1枚以上払った→ifPaid／0枚（どちらかが支払わなくなった＝交渉売買）→ifNot。
 *  amount が固定配列のときは（finishPayFromPool が pool 不足を先に ifNot へ倒すので）常に ifPaid */
function finishPay(state: BoardState, item: SimulItem, eng: ItemEng, save: (patch: Partial<ItemEng>) => BoardAction, pay: PayState, tokenIds: string[]): BoardAction[] {
  const acts: BoardAction[] = tokenIds.length ? [{ type: 'procPayCost', seat: pay.who, tokenIds, giveTo: pay.giveTo }] : []
  if (pay.addToBattlePaid) {
    const bf = nearestBattle(state)
    if (bf) acts.push({ type: 'procBattle', frameId: bf.id, paidAdd: { seat: pay.who, amount: tokenIds.length } })
  }
  const envPatch = pay.recordAs ? { env: { ...eng.env, slots: { ...eng.env.slots, [pay.recordAs]: [String(tokenIds.length)] } } } : {}
  const paidSome = tokenIds.length > 0
  const branch = pay.amount === 'chosen' && !paidSome ? pay.ifNot : pay.ifPaid
  const tasks: Task[] = [...branch.map((op) => ({ op })), ...eng.tasks]
  return [save({ awaiting: null, tasks, ...envPatch }), ...acts, { type: 'procTrace', entry: { kind: 'name', text: `${paidSome ? '払う' : '払わない'}:${item.label}` } }]
}

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
    // PHASE-R4b0 追加: 処理条件がある常時効果（conditional。宣言を通らないので violations() に届かない）も、
    // 発生源がキャラなら暗黙の対象（(A) と同じ拾い方）が特殊能力の対象にならないキャラなら効果を及ぼさない（FAQ:697・3573）。
    // 暗黙の対象が全部外れるなら項目ごと読み飛ばす（optional の「使うか」の問いも出さない）。一部だけ外れる記述は今のプールに
    // 無いので manual の警告に倒す（カード側の書き分けが要る）
    if (eng.recheck && isCharSource(ctx, state, eng.recheck.iid)) {
      const implicit = collectEffectTargets(ctx, state, eng.env, eng.tasks.map((t) => t.op))
      if (implicit.length) {
        const blocked = implicit.filter((iid) => untargetableBy(ctx, state, iid, '特殊能力'))
        if (blocked.length === implicit.length) {
          return [...acts, { type: 'procTrace', entry: { kind: 'name', text: `読み飛ばし:${item.label}（魔法のサークレット）` } }, done(true)]
        }
        if (blocked.length) warnings.push(`manual: ${item.label}: 暗黙の対象の一部だけが「特殊能力の対象にならない」で外れる（未実装・カード側の書き分けが要る）`)
      }
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
    // payByPlayer の 'genPending' 段（PHASE-R4b §2(D)・統括17の直し）: procStartCostGen で積んだ 7-2 のコスト発生の
    // 宣言（declPhaseFrame の [3] の窓〜declFrame の [4]〜[9]）が終わる（フレームが proc スタックから無くなる）のを待つ。
    // procMeta.answers を使わない（procChoice を出していないので答えが来ない）ので、ans のゲートより前で見る
    if (a.kind === 'payByPlayer' && a.pay!.stage === 'genPending') {
      if (findFrame(state, a.pay!.genDeclId!)) return []
      return finishPayFromPool(state, frame, item, eng, save, a, a.pay!)
    }
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
    if (a.kind === 'offer') {
      // K5（D8）: 「pay」を選べば払う（op.pay→op.ifPaid）。選ばなければ払わない（op.ifDeclined）。既定の答えは作らない（必ず問う）
      const paid = ans.length > 0
      const chosen = paid ? [...(a.payOps ?? []), ...(a.ifPaidOps ?? [])] : (a.ifDeclinedOps ?? [])
      const tasks: Task[] = [...chosen.map((op) => ({ op })), ...eng.tasks]
      return [save({ awaiting: null, tasks }), { type: 'procTrace', entry: { kind: 'name', text: `${paid ? '払う' : '払わない'}:${item.label}` } }]
    }
    if (a.kind === 'payByPlayer') {
      const pay = a.pay!
      const seat = pay.who
      if (pay.stage === 'ask') {
        if (ans.length === 0) return finishPayFromPool(state, frame, item, eng, save, a, pay)
        // 発生源の候補（0件選んでもよい。7-2[3] の窓で臨時収入・助太刀などを使うだけでも発生させられる＝FAQ:1347）
        const fieldCands = Object.values(state.cards).filter((c) => c.owner === seat && isCharOnField(c) && c.orientation === 'ready')
        const handCands = Object.values(state.cards).filter((c) => c.owner === seat && c.zone === 'hand' && ['c', 't'].includes(ctx.cards[c.cardId]?.kind ?? ''))
        const cands = [...fieldCands, ...handCands]
        const id2 = `${a.id}:src`
        return [
          save({ awaiting: { ...a, id: id2, pay: { ...pay, stage: 'source' } } }),
          {
            type: 'procChoice',
            choice: { id: id2, by: seat, kind: 'select', prompt: '発生源に指定するキャラ・手札のカード（0枚でもよい。7-2[3] の窓で臨時収入などを使うだけでもよい）', options: cands.map((c) => ({ key: c.iid, label: c.cardId })), min: 0, max: cands.length, frameId: frame.id },
          },
        ]
      }
      if (pay.stage === 'source') {
        // PHASE-R4b §2(D)・統括17の直し: 単独の 7-2 のコスト発生の宣言と同じ経路で積む（procStartCostGen）。
        // 7-2「１回で複数の発生源を指定できる」＝ ans は複数可。発生源の消耗・ゴミ箱送り・トークン化は enterCostGen（proc.ts）が行う
        const sources: CostSource[] = ans.map((iid) => {
          const c = state.cards[iid]
          const info = ctx.cards[c.cardId]
          const fromHand = c.zone === 'hand'
          const icon: CostIcon = fromHand ? 'W' : c.zone === 'leader' ? 'L' : info?.kind === 't' ? 'T' : 'G'
          return { iid, from: fromHand ? 'hand' : 'field', icon, attrs: fromHand ? [] : attrsOf(info) }
        })
        const declId = `${a.id}:cg`
        return [save({ awaiting: { ...a, pay: { ...pay, stage: 'genPending', genDeclId: declId } } }), { type: 'procStartCostGen', by: seat, sources, declId }]
      }
      // pay.stage === 'tokens'
      return finishPay(state, item, eng, save, pay, ans)
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

/**
 * (B) forEach・selector で複数のキャラに効果を及ぼす特殊能力（PHASE-R4b0 §2(B)）: 特殊能力の対象にならないキャラを
 * 処理の時点（select する今）の状態で外す（FAQ:709・3573）。外すのは発生源がキャラ（リーダー・タッグを含む）の
 * 特殊能力のときだけ（layers.ts の isCharSource と同じ線。イベント・フィールド・アイテムの効果は外さない FAQ:1264）
 */
function targetableSelect(ctx: EngineCtx, state: BoardState, env: Env, sel: Selector): string[] {
  const iids = select(ctx, state, env, sel)
  if (!isCharSource(ctx, state, env.self)) return iids
  return iids.filter((iid) => !untargetableBy(ctx, state, iid, '特殊能力'))
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
      return { tasks: rest, actions: refs(op.who).map((iid) => ({ type: 'procKiryoku', iid, delta, max: maxKiryokuOf(ctx, state, iid) }) as BoardAction) }
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
      return { tasks: rest, actions: [{ type: 'procDraw', seat: resolvePlayer(state, env, op.player), n: evalExpr(ctx, state, env, op.n) }] }
    case 'remember':
      return { tasks: rest, patch: { env: { ...eng.env, slots: { ...eng.env.slots, [op.slot]: [String(evalExpr(ctx, state, env, op.value))] } } }, actions: [] }
    case 'callByEffect': {
      // D17: 効果で「呼び出す」。カードが宣言時（今）の場所から動いていなければ実行する
      const iid = refs(op.what)[0]
      if (!iid || !(iid in state.cards)) return { tasks: rest, actions: [] }
      return { tasks: rest, actions: [{ type: 'procSummon', iid, seat: env.you, orientation: op.orientation, fromZone: state.cards[iid].zone }] }
    }
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
    case 'generateCost': {
      // D21: 効果でコストを発生させる。icons が配列なら固定の並び、{ callCostOf } ならそのカードの印刷された呼び出しコスト＋extra
      const seat = op.who ? resolvePlayer(state, env, op.who) : env.you
      const icons = Array.isArray(op.icons)
        ? op.icons
        : [...parseCost(refs(op.icons.callCostOf).map((iid) => infoOf(ctx, state, iid)?.cost ?? '').join('')), ...(op.icons.extra ?? [])]
      if (icons.length === 0) return { tasks: rest, actions: [] }
      // D20: useAs があれば、発生させたコストは useAs（借金取りの使用者）の発生済みのコストになる
      const useAsSeat = op.useAs ? resolvePlayer(state, env, op.useAs) : undefined
      return { tasks: rest, actions: [{ type: 'procGenCost', seat, tokens: icons.map((icon) => ({ icon, attrs: [] })), useAsSeat }] }
    }
    case 'counter': {
      // H-8: 範囲は「その効果」だけ。打ち消されたイベントは手順どおりゴミ箱・使用代償は戻らない
      if (op.what === 'thisEffect') {
        // このフレーム自身（env.declId）を打ち消す。残りの Op（rest）は実行しない（H-8「その効果」の内側からの自己打ち消し）
        return { tasks: [], actions: env.declId ? [{ type: 'procCounter', frameId: env.declId }] : [] }
      }
      const r = op.what.declared
      let targetId: string | null = null
      if (r.ref === 'event' && r.role === 'declaredAction') targetId = trigger && (trigger.kind === 'ability' || trigger.kind === 'event') ? trigger.id : null
      else {
        const iid = refs(r)[0]
        targetId = iid ? findActionOf(state, iid) : null
      }
      if (!targetId) return manual('打ち消す宣言が見つからない')
      // D23: part があれば全体ではなく、その部分（draw の操作）だけを打ち消す
      if (op.part) return { tasks: rest, actions: [{ type: 'procCounterPart', frameId: targetId, part: op.part }] }
      return { tasks: rest, actions: [{ type: 'procCounter', frameId: targetId }] }
    }
    case 'hijack': {
      // D11〜D15: 効果の乗っ取り。対象の宣言を探すのは 'counter' と同じ（op.what.declared）
      const r = op.what.declared
      let targetId: string | null = null
      if (r.ref === 'event' && r.role === 'declaredAction') targetId = trigger && (trigger.kind === 'ability' || trigger.kind === 'event') ? trigger.id : null
      else {
        const iid = refs(r)[0]
        targetId = iid ? findActionOf(state, iid) : null
      }
      const targetFrame = targetId ? findFrame(state, targetId) : undefined
      const originalDecl = targetFrame?.decl
      const hijacker = env.you
      // 失敗（乗っ取る宣言・能力が見つからない／使用タイミング・使用条件を今（乗っ取った側 you）で満たさない）:
      // 元の宣言は必ず打ち消し扱い（D11「元の使用者はその効果を使えない」）。乗っ取り自身（この効果）は立ち消え
      const fizzle = (why: string): OpResult => {
        const acts: BoardAction[] = []
        if (targetId) acts.push({ type: 'procCounter', frameId: targetId })
        if (env.declId) acts.push({ type: 'procAbortEffect', frameId: env.declId, reason: `適切な対象が無い（立ち消え・D11）: ${why}` })
        return { tasks: [], actions: acts }
      }
      if (!targetFrame || (targetFrame.kind !== 'ability' && targetFrame.kind !== 'event') || !originalDecl) return fizzle('乗っ取る宣言が見つからない')
      const found = abilityOf(ctx, originalDecl)
      const origAb = found?.ab
      // NH-17: 幸せ泥棒（part:'recover'）は処理条件がある常時効果（conditional。関西魂など）も対象にできる
      if (!origAb || (origAb.kind !== 'activated' && origAb.kind !== 'play' && origAb.kind !== 'conditional')) return fizzle('乗っ取る能力が無い')
      // D11: 使用タイミング・使用条件は、乗っ取った側を you として、元の宣言が反応した窓（originalDecl.trigger）の状況で確かめ直す
      const origEnv: Env = { self: originalDecl.sourceIid, you: hijacker, slots: {}, trigger: originalDecl.trigger, declId: originalDecl.id, declared: (originalDecl.eng.declared as Env['declared']) ?? {} }
      if (origAb.trigger) {
        const trigFrame = originalDecl.trigger ? findFrame(state, originalDecl.trigger) : undefined
        if (!trigFrame || !triggerMatches(ctx, state, origEnv, origAb.trigger, trigFrame)) return fizzle('使用タイミングを満たさない')
      }
      if (origAb.kind !== 'conditional' && origAb.usableIf && !evalCond(ctx, state, origEnv, origAb.usableIf)) return fizzle('使用条件を満たさない')
      // 成功: 元の宣言はここで必ず打ち消す（乗っ取りが後で失われても元の使用者は使えない・D11）
      const counterAction: BoardAction = { type: 'procCounter', frameId: targetId! }
      let built: Task[]
      if (op.part === 'recover') {
        // D13: 「気力を回復させる効果」の部分だけを乗っ取る。受け手は乗っ取った側がその場で選ぶ
        // （候補＝元の受け手の条件を満たすもの＝元の who を今の状況で解決したもの。選ばないこともできる）
        built = []
        origAb.effect
          .filter((o): o is Extract<Op, { op: 'kiryoku' }> => o.op === 'kiryoku' && !!o.recover)
          .forEach((o, i) => {
            const cands = resolveRef(state, origEnv, o.who)
            if (cands.length === 0) return
            const srcSlot = `hjsrc${i}`
            const pickSlot = `hjpick${i}`
            const pickChoice: Choice = {
              slot: pickSlot,
              chooser: 'you',
              pick: { cards: { zone: 'field', side: 'both', where: { same: [{ ref: 'it' }, { ref: 'slot', slot: srcSlot } as CardRef] } } },
              count: [0, 1],
              mode: 'target',
              when: 'resolve',
            }
            built.push({ op: { op: 'choose', choice: pickChoice }, bind: { [srcSlot]: cands } })
            built.push({ op: { op: 'kiryoku', who: { ref: 'slot', slot: pickSlot }, delta: o.delta, recover: true } })
          })
      } else if (origAb.kind === 'conditional') {
        return fizzle('乗っ取る能力の形が合わない（conditional は part:recover だけ）')
      } else {
        // D11: そのイベントの効果（選んだ選択肢のまま）を自分が使う。対象はこのときに乗っ取った側が選ぶ
        // （宣言時の対象の選択も解決時にやり直す＝ choices を全部いま選び直す）
        built = [...origAb.choices.map((c) => ({ op: { op: 'choose', choice: c } as Op })), ...origAb.effect.map((o) => ({ op: o }))]
      }
      // D12: 乗っ取った効果の中の self/grantor/equipped は元のカードのまま。you/opponent は乗っ取った側から読み替え（env.you は既にそう）
      return {
        tasks: [...built, ...rest],
        actions: [counterAction],
        patch: { env: { ...eng.env, self: originalDecl.sourceIid, trigger: originalDecl.trigger, declId: originalDecl.id, declared: (originalDecl.eng.declared as Env['declared']) ?? {}, slots: {} } },
      }
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
      const iids = targetableSelect(ctx, state, env, op.in)
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
            ? targetableSelect(ctx, state, env, o.in).flatMap((iid) => o.do.map((x): Task => ({ op: x, bind: { ...(task.bind ?? {}), [o.as]: [iid] }, bundle })))
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
    case 'trace':
      return { tasks: rest, actions: [{ type: 'procTrace', entry: { kind: 'name', text: op.text } }] }
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
      // バトルカードは 'battle' ゾーンへ（《虎の子バトル》と同じ「出す」。19-2 の配置アクションではない）。それ以外は 'field'（フィールドカード等）
      const to = ctx.cards[state.cards[what]?.cardId ?? '']?.kind === 'b' ? 'battle' : 'field'
      return { tasks: rest, actions: [{ type: 'procMove', iid: what, to, orientation, kiryoku, attachItemsFrom: from }] }
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
      // K5（D8）: 相手（op.to）に「払うことでこの効果を打ち消せる」等を問う。既定の答えは作らない（必ず procChoice で問う）。
      // payableIf を満たさなければ問わずに ifDeclined（H-7b: 気力1未満ならただちにダウン等、払えない側の処理は ifDeclined に書く）
      const to = resolvePlayer(state, env, op.to)
      const payable = op.payableIf ? evalCond(ctx, state, env, op.payableIf) : true
      if (!payable) return { tasks: [...op.ifDeclined.map((o) => ({ op: o, bind: task.bind })), ...rest], actions: [] }
      const id = `${frame.id}:${item.key}:offer${eng.seq}`
      return {
        tasks: rest,
        patch: { awaiting: { id, kind: 'offer', payOps: op.pay, ifPaidOps: op.ifPaid, ifDeclinedOps: op.ifDeclined } },
        actions: [{ type: 'procChoice', choice: { id, by: to, kind: 'use', prompt: op.prompt, options: [{ key: 'pay', label: op.prompt }], min: 0, max: 1, purpose: 'offer', frameId: frame.id } }],
      }
    }
    case 'payByPlayer': {
      // PHASE-R4b §2(D): who にコストを発生させるアクションを行うか問う（7-2）。段階は itemStep の eng.awaiting.pay.stage で進める
      const who = resolvePlayer(state, env, op.who)
      const giveTo = op.giveTo ? resolvePlayer(state, env, op.giveTo) : null
      const amount: CostIcon[] | 'chosen' = Array.isArray(op.amount) ? op.amount : 'chosen'
      const id = `${frame.id}:${item.key}:payByPlayer${eng.seq}`
      return {
        tasks: rest,
        patch: { awaiting: { id, kind: 'payByPlayer', pay: { stage: 'ask', who, giveTo, amount, recordAs: op.recordAs, addToBattlePaid: op.addToBattlePaid, ifPaid: op.ifPaid, ifNot: op.ifNot } } },
        actions: [
          {
            type: 'procChoice',
            // purpose 'offer' を流用（払う/払わないの帯。K5・D8）。テストの answer(by, accept) もこの convention（pick ['pay']/[]）を使う
            choice: { id, by: who, kind: 'use', prompt: 'コストを発生させるアクションを行うか（自分の待機状態のキャラを消耗させる、または手札のキャラクターカード・タッグキャラクターカードをゴミ箱送りにする。7-2）', options: [{ key: 'pay', label: 'コストを発生させる' }], min: 0, max: 1, purpose: 'offer', frameId: frame.id },
          },
        ],
      }
    }
    // ── R2b
    case 'statMod': {
      // 修正の層を足す（K3・R3）。値は処理したときに決まる（12-1）。期間: バトル終了時まで・攻防修正→[28]、それ以外→ターン終了時（12-1・10-8）
      const stat = typeof op.stat === 'string' ? op.stat : env.slots[op.stat.slot]?.[0]
      if (!stat) return { tasks: rest, actions: [] }
      const delta = evalExpr(ctx, state, env, op.delta)
      const until = op.duration === 'endOfBattle' || op.kind === '攻防修正' ? 'battle' : 'turn'
      if (op.duration !== 'endOfBattle' && op.duration !== 'endOfTurn' && op.duration !== 'instant') warnings.push(`${item.label}: 期間「${JSON.stringify(op.duration)}」はターン終了時まで扱い`)
      const origin = originOf(state, env)
      const add = refs(op.who).map((iid) => modSeed(iid, stat, delta, op.kind, until, env.you, env.self, `${item.label} ${stat}${delta >= 0 ? '+' : ''}${delta}`, origin))
      return { tasks: rest, actions: add.length ? [{ type: 'procLayers', add }] : [] }
    }
    case 'addContinuous': {
      // 継続効果の層を足す（K3・R3）。対象は足したときに決まる（12-1）。期限: ターン終了時まで／バトル終了時まで／発生源がある間
      const until = op.duration === 'endOfBattle' ? 'battle' : op.duration === 'whileSource' ? 'whileSource' : 'turn'
      if (op.duration === 'instant' || typeof op.duration === 'object') warnings.push(`${item.label}: 期間「${JSON.stringify(op.duration)}」はターン終了時まで扱い`)
      return { tasks: rest, actions: [{ type: 'procLayers', add: [continuousSeed(ctx, state, env, op.effect, until, item.label, originOf(state, env))] }] }
    }
    case 'clearMods': {
      const ids = refs(op.who).flatMap((iid) => clearableMods(state, iid, op.kind))
      return { tasks: rest, actions: [{ type: 'procTrace', entry: { kind: 'name', text: `修正を0にする:${refs(op.who).join(',')}` } }, ...(ids.length ? [{ type: 'procLayers', remove: ids } as BoardAction] : [])] }
    }
    case 'swapItems': {
      const a = refs(op.a)[0]
      const b = refs(op.b)[0]
      const ha = a ? state.cards[a]?.attachedTo : null
      const hb = b ? state.cards[b]?.attachedTo : null
      if (!a || !b || !ha || !hb) return manual('交換するアイテムが装備されていない')
      return { tasks: rest, actions: [{ type: 'procAttach', moves: [{ item: a, to: hb }, { item: b, to: ha }] }] }
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
    // ── K9・K13（R4b で足した）
    case 'setParticipants': {
      const bf = nearestBattle(state)
      if (!bf?.battle) return manual('バトル中でない')
      const seat: Seat = op.side === 'challenger' ? bf.battle.challenger : other(bf.battle.challenger)
      const to = 'zone' in op.to ? select(ctx, state, env, op.to) : refs(op.to)
      return { tasks: rest, actions: [{ type: 'procSetParticipants', frameId: bf.id, seat, to, exhaust: op.exhaust, previous: op.previous }] }
    }
    case 'setBattleChoice': {
      const bf = nearestBattle(state)
      if (!bf?.battle) return manual('バトル中でない')
      const seat: Seat = op.side === 'challenger' ? bf.battle.challenger : other(bf.battle.challenger)
      const value = typeof op.value === 'string' ? op.value : 'slot' in op.value ? env.slots[op.value.slot]?.[0] : refs(op.value as CardRef)[0]
      if (!value) return { tasks: rest, actions: [] }
      return { tasks: rest, actions: [{ type: 'procBattle', frameId: bf.id, battleChoice: { seat, key: op.key, value } }] }
    }
    default:
      return manual(`R2a の範囲外の操作 ${op.op}`)
  }
}

/** 効果の層を足した行動の種類（《能力禁止》FAQ:606: 特殊能力の効果は失われる） */
function originOf(state: BoardState, env: Env): 'ability' | 'event' | 'force' {
  const k = env.self ? state.cards[env.self] : undefined
  if (!k) return 'force'
  return (k.zone === 'char' || k.zone === 'leader') && !k.attachedTo ? 'ability' : 'event'
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

/** 交渉売買（R4b-3a-2・FAQ:3912・3918）: 挑んだプレイヤーから交互に payByPlayer(amount:{chosen:true}) を行い、
 *  どちらかが0を払ったら終わる（ifNot＝空）。depth は保険の上限（現実のＷトークン数はこれよりずっと少ない） */
function negotiateChain(first: 'challenger' | 'challenged', depth: number): Op {
  const other: 'challenger' | 'challenged' = first === 'challenger' ? 'challenged' : 'challenger'
  const next: Op[] = depth > 0 ? [negotiateChain(other, depth - 1)] : []
  return { op: 'payByPlayer', who: first, amount: { chosen: true }, addToBattlePaid: true, ifPaid: next, ifNot: [] }
}

/** Op を1つ、どの宣言にも属さない効果として積む（AP が起こしたものとして扱う） */
export function forceOp(state: BoardState, op: Op, bind: Record<string, string[]> = {}, label = '状況を作る'): BoardAction {
  const you = activeSeat(state)
  const eng: ItemEng = { tasks: [{ op }], env: { self: null, you, slots: bind, trigger: null, declId: null, declared: {} }, started: false, optional: false, recheck: null, awaiting: null, seq: 0 }
  return { type: 'procStart', item: { key: 'force', label, by: you, sourceIid: null, eng: eng as unknown as Record<string, unknown> } }
}

/** 選択肢の答えを作る小道具（画面・テスト用）: 答えの中身が選択肢にあるか */
export function validPick(choice: ProcChoice, pick: string[]): boolean {
  if (pick.length < choice.min || pick.length > choice.max) return false
  const keys = choice.options.map((o) => o.key)
  if (!pick.every((p) => keys.includes(p))) return false
  return choice.repeat || new Set(pick).size === pick.length
}

export { other, parseCostText }
