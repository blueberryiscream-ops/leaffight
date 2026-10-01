/*
 * 継続効果の層（K3）・合法性の判定（K4）・場の制限の是正（K12） — DESIGN §5.4・PHASE-R3 §2
 *
 * 層（core の BoardState.layers）は「続く効果1つ＝層1枚」。core は入れ物・連番・期限だけを持ち、中身（body）はここが書いて読む:
 *   - 効果で足した修正（statMod の Op）: body.mod = { stat, delta }（値は処理したときに決まる 12-1）
 *   - 効果で足した継続効果（addContinuous の Op）: body.effect（DSL の Continuous）と body.env（評価の環境）。対象は足したときに決まる（targets）
 *   - 常時効果（12-2。アイテム・フィールド・使用代償の無い特殊能力）: body.effect・body.ei。発生源がフィールドにある間だけ層がある
 *     （syncActions が発生源を見て足し外しする＝発揮し始めた順の連番がつく）。対象は毎回導き出す
 * 能力値・気力の上限・状態は、毎回「印刷値に層を連番の順で重ね、最後に人の手直しの層（board.modifiers）を重ねる」で導き出す。
 *
 * 原典: 12-1（oldrule.txt:493-500）・12-2（501-515）・10-8（436-441）・20-4[28]（1122-1125）・15-2（590-605）・15-4（612-617）・
 *       17-1（846-853）・17-2（854-860）・17-5（892-898）・19-1（980-986）・11-3（485-486）・用語【～の対象にならない】（1178-1179）・【特殊能力を失う】（1176-1177）
 */

import type { BoardAction } from '../core/actions'
import type { BoardState, CardInstance, Layer, Seat } from '../core/board'
import { activeSeat, type LayerSeed, type ProcDecl, type ProcFrame } from '../core/proc'
import type { ActionPattern, Attr, CardDef, CardRef, Continuous, Cost, CostIcon, Op, PlayerRef, Selector } from './dsl'
import { controllerOf, isCharOnField, other, type EngineCtx, type Env } from './ctx'
import { evalCond, evalExpr, resolvePlayer, resolveRef, select } from './eval'

export const ATTRS: Attr[] = ['力', '早', '賢', '根', '感']

/** 評価の環境の保存できる形（層の中身に入れる） */
export interface EnvLite {
  self: string | null
  you: Seat
  slots: Record<string, string[]>
}

/** 層の中身（engine の持ち物） */
interface LayerBody {
  /** 効果で足した修正（statMod の Op） */
  mod?: { stat: string; delta: number }
  /** 継続効果 */
  effect?: Continuous
  /** 効果で足した継続効果の評価の環境（常時効果は毎回 self＝発生源・you＝その使用者） */
  env?: EnvLite
  /** 常時効果: 能力の effects の番号 */
  ei?: number
  /** 足した行動の種類（《能力禁止》FAQ:606 は特殊能力の効果を失わせる） */
  origin?: 'ability' | 'event' | 'static' | 'force'
  /** stayRested: 消耗状態になって固定されたカード */
  locked?: string[]
}

const bodyOf = (l: Layer) => l.body as LayerBody

/** 効果で足した修正の層（statMod の Op・12-1）。期限: バトル終了時まで・攻防修正→ battle、それ以外→ turn */
export function modSeed(iid: string, stat: string, delta: number, kind: '能力値修正' | '攻防修正', until: 'turn' | 'battle', by: Seat, source: string | null, label: string, origin: LayerBody['origin']): LayerSeed {
  return { source, ability: null, by, label, kind, until, targets: [iid], host: null, body: { mod: { stat, delta }, origin } }
}

// ───────────────────────────────────────────────────────────────
// 導き出す（K3）
// ───────────────────────────────────────────────────────────────

interface Eff {
  layer: Layer
  effect: Continuous
  env: Env
}

interface Derived {
  ctx: EngineCtx
  effs: Eff[]
  /** 特殊能力を失っているキャラ（shieldParticipants from 特殊能力・loseAbilities） */
  lost: Set<string>
  /** イベントが効果を失う参加キャラ（shieldParticipants from イベント） */
  lostEv: Set<string>
  /** 能力値修正・攻防修正を発生源を問わず失う参加キャラ（shieldParticipants mods。鶴来屋温泉三本勝負） */
  modLost: Set<string>
  /** 参加キャラ → 失わせている shieldParticipants の効果（違反の根拠の表示用） */
  srcA: Map<string, Eff>
  srcE: Map<string, Eff>
}

const cache = new WeakMap<BoardState, Derived>()

function layerEnv(state: BoardState, l: Layer): Env {
  const b = bodyOf(l)
  if (l.ability !== null) {
    const self = l.source
    const you = (self ? controllerOf(state, self) : null) ?? l.by
    return { self, you, slots: {}, trigger: null, declId: null, declared: {}, host: l.host }
  }
  const e = b.env ?? { self: l.source, you: l.by, slots: {} }
  return { self: e.self, you: e.you, slots: e.slots, trigger: null, declId: null, declared: {} }
}

function derived(ctx: EngineCtx, state: BoardState): Derived {
  const hit = cache.get(state)
  if (hit && hit.ctx === ctx) return hit
  const all: Eff[] = []
  for (const l of [...state.layers.list].sort((a, b) => a.seq - b.seq)) {
    const b = bodyOf(l)
    if (!b.effect) continue
    all.push({ layer: l, effect: b.effect, env: layerEnv(state, l) })
  }
  // 特殊能力を失う（《能力禁止》）: 失っているキャラの常時効果の層は効かない（常時効果の発生源が「特殊能力」＝キャラのものだけ）
  const d0: Derived = { ctx, effs: all, lost: new Set(), lostEv: new Set(), modLost: new Set(), srcA: new Map(), srcE: new Map() }
  cache.set(state, d0)
  const lost = new Set<string>()
  const lostEv = new Set<string>()
  const modLost = new Set<string>()
  const srcA = new Map<string, Eff>()
  const srcE = new Map<string, Eff>()
  for (const e of all) {
    if (e.effect.ce === 'loseAbilities') for (const x of targetsOf(ctx, state, e)) lost.add(x)
    else if (e.effect.ce === 'shieldParticipants') {
      const f = e.effect
      if (f.when && !evalCond(ctx, state, e.env, f.when)) continue
      for (const x of targetsOf(ctx, state, e)) {
        if (f.from.includes('特殊能力')) { lost.add(x); srcA.set(x, e) }
        if (f.from.includes('イベント')) { lostEv.add(x); srcE.set(x, e) }
        if (f.mods) modLost.add(x)
      }
    }
  }
  const effs = all.filter((e) => !(e.layer.ability !== null && e.layer.source && lost.has(e.layer.source) && isCharOnField(state.cards[e.layer.source])))
  const d: Derived = { ctx, effs, lost, lostEv, modLost, srcA, srcE }
  cache.set(state, d)
  return d
}

/** 層の効果を得ているカード（効果で足した層は足したときの対象・常時効果は毎回導き出す） */
function targetsOf(ctx: EngineCtx, state: BoardState, e: Eff): string[] {
  if (e.layer.ability === null && e.layer.targets.length) return e.layer.targets.filter((x) => x in state.cards)
  const who = (e.effect as { who?: CardRef | Selector }).who
  if (!who) return []
  return 'zone' in who ? select(ctx, state, e.env, who) : resolveRef(state, e.env, who)
}

function effectOn(ctx: EngineCtx, state: BoardState, e: Eff, iid: string): boolean {
  if (!targetsOf(ctx, state, e).includes(iid)) return false
  // 参加していないキャラの常時の特殊能力が、特殊能力を失っている参加キャラに及ぼす効果も働かない（FAQ:597 後半・R4b-3b-2）
  if (e.layer.ability !== null && isCharSource(ctx, state, e.layer.source) && derived(ctx, state).lost.has(iid)) return false
  const when = (e.effect as { when?: Parameters<typeof evalCond>[3] }).when
  if (e.effect.ce !== 'prohibit' && when && !evalCond(ctx, state, e.env, when)) return false
  // 【～の対象にならない】特殊能力: 特殊能力の常時効果（キャラの能力）の影響も受けない（《魔法のサークレット》FAQ:697・709）
  if (e.layer.ability !== null && e.effect.ce !== 'untargetable' && e.effect.ce !== 'loseAbilities' && isCharSource(ctx, state, e.layer.source) && untargetableBy(ctx, state, iid, '特殊能力', e)) return false
  return true
}

export function isCharSource(ctx: EngineCtx, state: BoardState, iid: string | null): boolean {
  const k = iid ? ctx.cards[state.cards[iid]?.cardId ?? '']?.kind : undefined
  return k === 'c' || k === 't'
}

/** そのカードが、その種類の行動の対象にならないか（層の untargetable）。skip＝判定中の効果（自分で自分を調べない） */
export function untargetableBy(ctx: EngineCtx, state: BoardState, iid: string, kind: ActionPattern['kinds'][number], skip?: Eff): Eff | null {
  for (const e of derived(ctx, state).effs) {
    if (e === skip || e.effect.ce !== 'untargetable' || !e.effect.by.kinds.includes(kind)) continue
    if (targetsOf(ctx, state, e).includes(iid)) return e
  }
  return null
}

/** 今の能力値（K3）: 印刷値に層を連番の順で重ね（修正の足し引き・性格反転 H-6＝今の値を入れ替える）、最後に手直しの層を重ねる */
export function currentStat(ctx: EngineCtx, state: BoardState, iid: string, stat: string): number {
  return currentStats(ctx, state, iid)[stat] ?? 0
}

export function currentStats(ctx: EngineCtx, state: BoardState, iid: string): Record<string, number> {
  const c = state.cards[iid]
  const printed = c ? ctx.cards[c.cardId]?.stats ?? null : null
  const v: Record<string, number> = {}
  for (const a of ATTRS) v[a] = printed?.[a] ?? 0
  if (!c) return v
  const d = derived(ctx, state)
  // 層を連番の順に（効果で足した修正と継続効果を混ぜて並べる）
  const items: { seq: number; run: () => void }[] = []
  for (const l of state.layers.list) {
    const m = bodyOf(l).mod
    if (m && l.kind === '能力値修正' && l.targets.includes(iid) && m.stat in v && !d.modLost.has(iid)) items.push({ seq: l.seq, run: () => (v[m.stat] += m.delta) })
  }
  for (const e of d.effs) {
    const f = e.effect
    if (f.ce === 'statMod' && f.kind === '能力値修正') {
      if (d.modLost.has(iid)) continue
      items.push({ seq: e.layer.seq, run: () => effectOn(ctx, state, e, iid) && (v[f.stat] += evalExpr(ctx, state, e.env, f.delta)) })
    } else if (f.ce === 'statSwap') {
      items.push({ seq: e.layer.seq, run: () => effectOn(ctx, state, e, iid) && swapStats(ctx, state, e, iid, v) })
    }
  }
  items.sort((a, b) => a.seq - b.seq).forEach((x) => x.run())
  // 人の手直しの層（最後に・連番の順）
  for (const m of manualMods(state, iid)) if (m.kind === '能力値修正' && m.stat && m.delta !== undefined) v[m.stat] += m.delta
  return v
}

/** 印刷値の最高・最低の能力値（複数あれば全部）。全属性が同じ値なら hi===lo===全部 */
function tiedHiLo(printed: Record<string, number>): { hi: Attr[]; lo: Attr[] } {
  let maxV = -Infinity
  let minV = Infinity
  for (const a of ATTRS) {
    if (printed[a] > maxV) maxV = printed[a]
    if (printed[a] < minV) minV = printed[a]
  }
  return { hi: ATTRS.filter((a) => printed[a] === maxV), lo: ATTRS.filter((a) => printed[a] === minV) }
}

/**
 * H-6（統括12 2026-09-26・D1）: 最も高い元の能力値と最も低い元の能力値（**印刷値・常に同じ**）を入れ替えて上書きする。
 * その2つの能力値にこの層より前で掛かっていた修正は消え（v の値を印刷値の入れ替えで上書きするため）、
 * 後から来た修正（この層より後の seq）は通常どおり v に足される。
 * 並びが複数あるときは装備させたプレイヤーが装備するたびに選ぶ（FAQ:443）。答えは procMeta.answers['swap:<アイテムiid>']（`swapChoiceFix` が問う）。
 * 未回答の間は原典の能力値の順（力早賢根感）で先のものを仮に使う（`swapChoiceFix` が別途止めて問う）
 */
function swapStats(ctx: EngineCtx, state: BoardState, e: Eff, iid: string, v: Record<string, number>): boolean {
  const c = state.cards[iid]
  const printed = c ? ctx.cards[c.cardId]?.stats : null
  if (!printed) return false
  const { hi, lo } = tiedHiLo(printed)
  let hiAttr = hi[0]
  let loAttr = lo[0]
  if (hiAttr === loAttr) return true // 全属性が同じ値: 入れ替えても変化なし
  if (hi.length > 1 || lo.length > 1) {
    const itemIid = e.layer.source
    const answer = itemIid ? state.procMeta.answers[`swap:${itemIid}`] : undefined
    const [pickHi, pickLo] = (answer?.[0]?.split(':') ?? []) as [Attr, Attr]
    if (pickHi && pickLo && hi.includes(pickHi) && lo.includes(pickLo)) {
      hiAttr = pickHi
      loAttr = pickLo
    }
  }
  const hiPrinted = printed[hiAttr] ?? 0
  const loPrinted = printed[loAttr] ?? 0
  v[hiAttr] = loPrinted
  v[loAttr] = hiPrinted
  return true
}

/**
 * H-6 の並び（tieBreak）: 印刷値の最高・最低が複数あるとき、装備させたプレイヤーに入れ替える組を1回選ばせる（FAQ:443・装備するたびに）。
 * 選んだ答えは procMeta.answers['swap:<アイテムiid>'] に残る（そのアイテムが場にある限り・再装備は新しい iid なので改めて問う）
 */
export function swapChoiceFix(ctx: EngineCtx, state: BoardState): BoardAction | null {
  if (state.result || state.procMeta.choice) return null
  for (const e of derived(ctx, state).effs) {
    if (e.effect.ce !== 'statSwap') continue
    const itemIid = e.layer.source
    if (!itemIid) continue
    const key = `swap:${itemIid}`
    if (state.procMeta.answers[key]) continue
    for (const iid of targetsOf(ctx, state, e)) {
      if (!effectOn(ctx, state, e, iid)) continue
      const c = state.cards[iid]
      const printed = c ? ctx.cards[c.cardId]?.stats : null
      if (!printed) continue
      const { hi, lo } = tiedHiLo(printed)
      if (hi.length <= 1 && lo.length <= 1) continue
      if (hi[0] === lo[0]) continue
      const opts: { key: string; label: string }[] = []
      for (const a of hi) for (const b of lo) if (a !== b) opts.push({ key: `${a}:${b}`, label: `${a}と${b}を入れ替える` })
      const chooser = resolvePlayer(state, layerEnv(state, e.layer), e.effect.tieBreak.chooser)
      return {
        type: 'procChoice',
        choice: { id: key, by: chooser, kind: 'select', prompt: `「${e.layer.label}」: 入れ替える能力値を選ぶ（元の能力値が並んでいる。FAQ:443）`, options: opts, min: 1, max: 1, frameId: null },
      }
    }
  }
  return null
}

function manualMods(state: BoardState, iid: string) {
  return Object.values(state.modifiers)
    .filter((m) => m.targetIid === iid)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

/** 攻防修正の合計（atk・def）: 効果で足した攻防修正の層＋手直しの層の攻防修正 */
export function battleMod(ctx: EngineCtx, state: BoardState, iid: string, side: 'atk' | 'def'): number {
  if (derived(ctx, state).modLost.has(iid)) return 0
  let n = 0
  for (const l of state.layers.list) {
    const m = bodyOf(l).mod
    if (m && l.kind === '攻防修正' && m.stat === side && l.targets.includes(iid)) n += m.delta
  }
  for (const m of manualMods(state, iid)) if (m.kind === '攻防修正' && m.battleStat === side && m.delta !== undefined) n += m.delta
  return n
}

/** 気力の上限（15-4）: 元の上限（リーダーは×2）に maxKiryoku の層を連番の順で重ねる */
export function maxKiryokuOf(ctx: EngineCtx, state: BoardState, iid: string): number | null {
  const c = state.cards[iid]
  const info = c ? ctx.cards[c.cardId] : undefined
  if (!c || !info || info.kiryoku === null) return null
  let v = c.zone === 'leader' ? info.kiryoku * 2 : info.kiryoku
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce !== 'maxKiryoku' || !effectOn(ctx, state, e, iid)) continue
    if (f.set !== undefined) v = f.set
    if (f.delta !== undefined) v += f.delta
  }
  return v
}

/** 特殊能力を失っているか（《能力禁止》など） */
export function abilitiesLost(ctx: EngineCtx, state: BoardState, iid: string): boolean {
  return derived(ctx, state).lost.has(iid)
}

/** 層の一覧（画面の表示用）: そのカードに効いている層の名前 */
export function layersOn(ctx: EngineCtx, state: BoardState, iid: string): string[] {
  const out: string[] = []
  for (const l of state.layers.list) if (bodyOf(l).mod && l.targets.includes(iid)) out.push(l.label)
  for (const e of derived(ctx, state).effs) if (effectOn(ctx, state, e, iid)) out.push(e.layer.label)
  return out
}

/**
 * ダメージを受けない（15-4-2[5] の前。身代わり [4] の後 FAQ:1706）: 進行中のダメージ1件の受け手・発生元に掛かる preventDamage。
 * 当たれば理由（層の名前）
 */
export function damagePrevented(ctx: EngineCtx, state: BoardState, frame: ProcFrame): string | null {
  const dmg = frame.damage
  if (!dmg) return null
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce !== 'preventDamage') continue
    if (f.battle === 'only' && !dmg.battle) continue
    if (f.battle === 'except' && dmg.battle) continue
    const recv = effectOn(ctx, state, e, dmg.recipient)
    const deal = !!f.deal && !!dmg.dealerIid && effectOn(ctx, state, e, dmg.dealerIid)
    if (!recv && !deal) continue
    if (recv && f.from) {
      if (!dmg.dealerIid || !evalCond(ctx, state, { ...e.env, it: dmg.dealerIid }, f.from)) {
        if (!deal) continue
      }
    }
    return e.layer.label
  }
  return null
}

// ───────────────────────────────────────────────────────────────
// 合法性（K4）: 禁止・強制・対象にならない。違反は警告（止めない。DESIGN §5.4「段階」）
// ───────────────────────────────────────────────────────────────

export interface Violation {
  kind: 'prohibit' | 'mandate' | 'untargetable' | 'lostAbility' | 'equipTarget'
  /** 画面に出す文（根拠つき） */
  text: string
  /** 根拠の層（効果）の名前 */
  source: string
  /** 根拠の効果の発生源の iid（D9: この iid のカードの記述が tested なら declare が断る）。無ければカードに基づかない違反 */
  sourceIid: string | null
}

export const ACTION_KIND: Record<ProcDecl['kind'], ActionPattern['kinds'][number]> = {
  ability: '特殊能力',
  event: 'イベント',
  costGen: 'コスト発生',
  equip: 'アイテム装備',
  call: 'キャラ呼び出し',
  tag: 'タッグ化',
  field: 'フィールド配置',
  battleCard: 'バトル配置',
  battle: 'バトル',
}

/**
 * (A) 選ばずに決まるキャラに効果を及ぼす特殊能力の「暗黙の対象」（PHASE-R4b0 §2(A)）: choices を経ずに op の
 * who/to 等（CardRef。Selector は forEach で処理する＝(B)）が決まるキャラに効果を及ぼす op を、宣言の効果（ab.effect）
 * から拾い集める。if は宣言時点の状態で分岐を決め、simul はそのまま中を見る。forEach の中は (B) が処理するので見ない。
 */
function implicitTargetsOf(ctx: EngineCtx, state: BoardState, decl: ProcDecl): string[] {
  if (decl.kind !== 'ability' && decl.kind !== 'event') return []
  const cardId = decl.eng.cardId as string | undefined
  const idx = decl.eng.index as number | undefined
  if (cardId === undefined || idx === undefined) return []
  const ab = ctx.defs[cardId]?.abilities[idx]
  if (!ab || (ab.kind !== 'activated' && ab.kind !== 'play')) return []
  const env: Env = { self: decl.sourceIid, you: decl.by, slots: (decl.eng.slots as Record<string, string[]>) ?? {}, trigger: decl.trigger, declId: decl.id, declared: (decl.eng.declared as Env['declared']) ?? {} }
  return collectEffectTargets(ctx, state, env, ab.effect)
}

/** op の中で「効果を及ぼす」CardRef（Selector は含めない＝forEach の中は (B) が別に処理する）。§2(A) の分類表は HANDOFF-R4b0 参照 */
function effectRefsOf(op: Op): CardRef[] {
  switch (op.op) {
    case 'statMod':
    case 'kiryoku':
    case 'setKiryoku':
    case 'orient':
    case 'clearMods':
      return [op.who]
    case 'damage':
    case 'redirectDamage':
      return [op.to]
    case 'trash':
    case 'moveTo':
    case 'callByEffect':
    case 'putOntoField':
      return [op.what]
    case 'grantAbility':
      return [op.to]
    case 'battleDamage':
      return op.to === 'all' ? [] : [op.to]
    case 'addContinuous': {
      const who = (op.effect as { who?: CardRef | Selector }).who
      return who && !('zone' in who) ? [who] : []
    }
    default:
      return []
  }
}

/** (A) の暗黙の対象を op の列から拾い集める（宣言の violations() 用に加え、drive.ts の conditional の項目でも使う） */
export function collectEffectTargets(ctx: EngineCtx, state: BoardState, env: Env, ops: Op[]): string[] {
  const out: string[] = []
  for (const op of ops) {
    if (op.op === 'if') {
      out.push(...collectEffectTargets(ctx, state, env, evalCond(ctx, state, env, op.cond) ? op.then : op.else ?? []))
      continue
    }
    if (op.op === 'simul') {
      out.push(...collectEffectTargets(ctx, state, env, op.do))
      continue
    }
    if (op.op === 'forEach') continue // (B): forEach・selector は drive.ts の実行時に別に外す
    for (const ref of effectRefsOf(op)) out.push(...resolveRef(state, env, ref))
  }
  return out
}

/** forEach・selector で効果が及ぶキャラ（宣言の効果のうち実際に及ぼす op を含む forEach の in。R4b-3b-2。(B) は実行時に外すが、宣言の可否には使う） */
function forEachReach(ctx: EngineCtx, state: BoardState, decl: ProcDecl): string[] {
  const cardId = decl.eng.cardId as string | undefined
  const idx = decl.eng.index as number | undefined
  if (cardId === undefined || idx === undefined) return []
  const ab = ctx.defs[cardId]?.abilities[idx]
  if (!ab || (ab.kind !== 'activated' && ab.kind !== 'play')) return []
  const env: Env = { self: decl.sourceIid, you: decl.by, slots: (decl.eng.slots as Record<string, string[]>) ?? {}, trigger: decl.trigger, declId: decl.id, declared: (decl.eng.declared as Env['declared']) ?? {} }
  const out: string[] = []
  const walk = (ops: Op[]) => {
    for (const op of ops) {
      if (op.op === 'if') walk(evalCond(ctx, state, env, op.cond) ? op.then : op.else ?? [])
      else if (op.op === 'simul') walk(op.do)
      else if (op.op === 'forEach' && op.do.some((o) => effectRefsOf(o).length > 0)) out.push(...select(ctx, state, env, op.in))
    }
  }
  walk(ab.effect)
  return out
}

/** 宣言が層の「禁止・対象にならない・特殊能力を失っている」に当たるか（宣言[1]〜[5] を済ませた ProcDecl で調べる） */
export function violations(ctx: EngineCtx, state: BoardState, decl: ProcDecl): Violation[] {
  const out: Violation[] = []
  const kind = ACTION_KIND[decl.kind]
  const d = derived(ctx, state)
  const name = (iid: string) => ctx.cards[state.cards[iid]?.cardId ?? '']?.name ?? iid
  for (const e of d.effs) {
    const f = e.effect
    if (f.ce !== 'prohibit' || !f.action.kinds.includes(kind)) continue
    if (f.when && !evalCond(ctx, state, e.env, f.when)) continue
    if (!patternHits(ctx, state, e, f.action, decl)) continue
    out.push({ kind: 'prohibit', text: `「${e.layer.label}」により${kind}を使えない`, source: e.layer.label, sourceIid: e.layer.source })
  }
  const allTargets = new Set([...decl.targets, ...implicitTargetsOf(ctx, state, decl)])
  for (const t of allTargets) {
    const u = untargetableBy(ctx, state, t, kind)
    if (u) out.push({ kind: 'untargetable', text: `${name(t)}は「${u.layer.label}」により${kind}の対象にならない（空打ち 11-3）`, source: u.layer.label, sourceIid: u.layer.source })
  }
  // 参加キャラに対して効果を発揮する特殊能力・イベントは使えない（FAQ:3735 の線引き。効果が参加キャラに及ばなければ使える＝3070・1013・3224）。
  // 及ぶ＝対象に選ぶ／選ばずに決まる（R4b0 の暗黙の対象 implicitTargetsOf）／forEach・selector で及ぶ
  if (decl.kind === 'ability' || decl.kind === 'event') {
    const sh = decl.kind === 'ability' ? d.lost : d.lostEv
    if (sh.size) {
      for (const t of [...allTargets, ...forEachReach(ctx, state, decl)]) {
        const e = (decl.kind === 'ability' ? d.srcA : d.srcE).get(t)
        if (!sh.has(t)) continue
        out.push({ kind: 'lostAbility', text: `${name(t)}はバトル参加キャラ（「${e?.layer.label ?? '特殊能力を失う'}」）なので、効果が及ぶ${kind}は使用できない`, source: e?.layer.label ?? '特殊能力を失う', sourceIid: e?.layer.source ?? null })
        break
      }
    }
  }
  if (decl.kind === 'equip' && decl.sourceIid && decl.equipTo) {
    const why = equipProblem(ctx, state, state.cards[decl.sourceIid], decl.equipTo, decl.by)
    if (why) out.push({ kind: 'equipTarget', text: `${name(decl.sourceIid)}は${name(decl.equipTo)}に装備できない（${why}・17-1）`, source: name(decl.sourceIid), sourceIid: decl.sourceIid })
  }
  return out
}

// ───────────────────────────────────────────────────────────────
// 使用代償の増減（K6・D3・D4）
// ───────────────────────────────────────────────────────────────

/** 当てはまる costMod を全部（層の順）集めて足し合わせる。宣言前（declareOne）は decl がまだ無いので軽い形で渡す。
 *  printedCost: applies.costIsZero（《ライジング・コスト》）の判定に使う印刷値の使用代償 */
export function costModOf(ctx: EngineCtx, state: BoardState, kind: ActionPattern['kinds'][number], by: Seat, sourceIid: string | null, targets: string[] = [], printedCost?: Cost): { icons: Partial<Record<CostIcon, number>>; kiryoku: number } {
  const icons: Partial<Record<CostIcon, number>> = {}
  let kiryoku = 0
  const pseudo = { by, sourceIid, targets } as ProcDecl
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce !== 'costMod' || !f.applies.kinds.includes(kind)) continue
    if (f.applies.costIsZero && (printedCost?.icons.length ?? 0) !== 0) continue
    if (!patternHits(ctx, state, e, f.applies, pseudo)) continue
    for (const [icon, delta] of Object.entries(f.icons ?? {})) icons[icon as CostIcon] = (icons[icon as CostIcon] ?? 0) + (delta ?? 0)
    kiryoku += f.kiryoku ?? 0
  }
  return { icons, kiryoku }
}

/** D3: 印刷値のコストアイコン枚数・気力コストへ増減をまとめて適用し、下限をとる（アイコンは種類ごとに0未満にならない・気力コストの最終値は0未満にならない） */
export function applyCostMod(cost: Cost, mod: { icons: Partial<Record<CostIcon, number>>; kiryoku: number }): Cost {
  const hasIcons = Object.values(mod.icons).some((n) => n)
  if (!hasIcons && mod.kiryoku === 0) return cost
  const counts: Partial<Record<CostIcon, number>> = {}
  for (const ic of cost.icons) counts[ic] = (counts[ic] ?? 0) + 1
  for (const [icon, delta] of Object.entries(mod.icons)) counts[icon as CostIcon] = (counts[icon as CostIcon] ?? 0) + (delta ?? 0)
  const icons: CostIcon[] = []
  for (const [icon, n] of Object.entries(counts)) for (let i = 0; i < Math.max(0, n ?? 0); i++) icons.push(icon as CostIcon)
  // D16: 可変の使用代償（kiryoku が Expr＝宣言時に選んだ数）は costMod の対象外（今のプールに両方が絡む例が無い。決めていない組み合わせ）
  const other = mod.kiryoku === 0 ? cost.other : cost.other?.map((o) => ('kiryoku' in o && typeof o.kiryoku === 'number' ? { ...o, kiryoku: Math.max(0, o.kiryoku + mod.kiryoku) } : o))
  return { ...cost, icons, other }
}

function patternHits(ctx: EngineCtx, state: BoardState, e: Eff, p: ActionPattern, decl: ProcDecl): boolean {
  if (p.by && p.by !== 'any' && resolvePlayer(state, e.env, p.by) !== decl.by) return false
  if (p.sourceIs) {
    const xs = resolveRef(state, e.env, p.sourceIs)
    if (!decl.sourceIid || !xs.includes(decl.sourceIid)) return false
  }
  if (p.sourceWhere && (!decl.sourceIid || !evalCond(ctx, state, { ...e.env, it: decl.sourceIid }, p.sourceWhere))) return false
  if (p.targetWhere && !decl.targets.some((t) => evalCond(ctx, state, { ...e.env, it: t }, p.targetWhere!))) return false
  return true
}

// ───────────────────────────────────────────────────────────────
// 装備対象（17-1・17-5）
// ───────────────────────────────────────────────────────────────

/** アイテムの装備対象の問題（無ければ null）。by＝装備させるプレイヤー（宣言のとき） */
function equipProblem(ctx: EngineCtx, state: BoardState, item: CardInstance | undefined, hostIid: string, by?: Seat): string | null {
  if (!item) return null
  const def: CardDef | undefined = ctx.defs[item.cardId]
  const eq = def?.equip
  const host = state.cards[hostIid]
  if (!eq || !host) return null
  if (eq.targetKind === 'バトルカード') return host.zone === 'battle' ? null : 'バトルカードに装備させるアイテム'
  if (eq.targetKind === 'キャラ') {
    if (!isCharOnField(host)) return 'フィールドのキャラでない'
    if (eq.notLeader && host.zone === 'leader') return 'リーダーには装備できない'
    if (eq.leaderOnly && host.zone !== 'leader') return 'リーダーのみ装備できる'
    // 味方キャラのみ: 装備させるプレイヤー（宣言のとき）／アイテムの持ち主（付け替えのあと。使用権の移動 K8 は後）の味方【決めたこと】
    if (eq.friendlyOnly && (by ?? item.owner) !== (controllerOf(state, hostIid) ?? host.owner)) return '味方キャラのみ装備できる'
    const bound = state.layers.bound[item.iid]
    if (eq.bound && bound && bound !== hostIid) return '装備対象はこのアイテムで選んだキャラ'
  }
  return null
}

// ───────────────────────────────────────────────────────────────
// 層の足し外し（常時効果・期限）: drive が状態の変わるたびに呼ぶ
// ───────────────────────────────────────────────────────────────

/**
 * 常時効果の発生源がフィールドにあるか（12-2）: キャラ・付いているアイテム（キャラ・バトルカードに）・フィールドカード・バトルカード。
 * D2（12-2 但し書き oldrule.txt:509-510）: バトルカードだけは例外——そのバトルカードで種目を選んだバトルが進行中の間は、
 * 場（zone==='battle'）に無くても（使用済みでゴミ箱へ送られていても）有効
 */
export function staticSourceActive(state: BoardState, iid: string): boolean {
  const c = state.cards[iid]
  if (!c) return false
  if (c.zone === 'field' || (c.zone === 'battle' && !c.attachedTo)) return true
  if (c.attachedTo) {
    const h = state.cards[c.attachedTo]
    return h?.zone === 'battle' || isCharOnField(h)
  }
  if (isCharOnField(c)) return true
  return battleCardInUse(state, iid)
}

/** D2: そのバトルカードで種目を選んだバトルが今進行中か（state.proc に kind:'battle' で battle.battleCard===iid の未完了フレームがあるか） */
function battleCardInUse(state: BoardState, iid: string): boolean {
  return state.proc.some((f) => f.kind === 'battle' && f.status !== 'done' && f.battle?.battleCard === iid)
}

function onFieldAny(c: CardInstance | undefined): boolean {
  return !!c && (c.zone === 'char' || c.zone === 'leader' || c.zone === 'battle' || c.zone === 'field')
}

/**
 * 状態に合わせて層を足し外しする BoardAction（無ければ空）:
 *  - 常時効果: 発生源がフィールドにある（アイテムは装備対象を満たす 17-5）間だけ層がある。装備先が変わったら古い層を外して新しい層を足す
 *  - 効果で足した層: 効果を得ていたカードが全部失われたら外す（12-1）。whileSource は発生源が失われたら外す（12-2）
 *  - whenLost: 常時効果の層が「発生源が離れた・装備先が変わった」で外れたら、その Op を処理する（装備対象を満たせずに外れたときは処理しない FAQ:550）
 *  - 装備対象が1枚に決まるアイテム（bound）の控え・使用できないバトルカードの控え・常に消耗状態・気力の上限を超えた気力
 */
export function syncActions(ctx: EngineCtx, state: BoardState): BoardAction[] {
  const list = state.layers.list
  const add: LayerSeed[] = []
  const remove: string[] = []
  const lostOps: { ops: Op[]; env: Env; label: string; by: Seat }[] = []
  // ── 常時効果
  const want = new Map<string, { iid: string; index: number; ei: number; host: string | null; effect: Continuous; label: string }>()
  const cards = Object.values(state.cards).sort((a, b) => (a.owner === b.owner ? rank(a) - rank(b) || a.index - b.index : a.owner < b.owner ? -1 : 1))
  for (const c of cards) {
    const def = ctx.defs[c.cardId]
    if (!def || !staticSourceActive(state, c.iid)) continue
    // 17-5: 装備対象を満たしていないアイテムの効果は発揮されない
    if (c.attachedTo && equipProblem(ctx, state, c, c.attachedTo)) continue
    def.abilities.forEach((ab, index) => {
      if (ab.kind !== 'static') return
      ab.effects.forEach((effect, ei) => {
        if (effect.ce === 'manual' || effect.ce === 'exemptLimit') return
        want.set(`${c.iid}#${index}#${ei}`, { iid: c.iid, index, ei, host: c.attachedTo, effect, label: ab.name ?? def.name })
      })
    })
  }
  const have = new Set<string>()
  for (const l of list) {
    if (l.ability === null) continue
    const b = bodyOf(l)
    const key = `${l.source}#${l.ability}#${b.ei ?? 0}`
    const w = want.get(key)
    if (w && w.host === l.host) {
      have.add(key)
      continue
    }
    remove.push(l.id)
    // 発生源が離れた・装備先が変わった（装備対象を満たせなくなっただけのときは処理しない）
    const src = l.source ? state.cards[l.source] : undefined
    const mismatchOnly = !!src && staticSourceActive(state, src.iid) && src.attachedTo === l.host && !w
    if (b.effect?.ce === 'whenLost' && !mismatchOnly) {
      const env = layerEnv(state, l)
      lostOps.push({ ops: b.effect.do, env: { ...env, host: l.host }, label: l.label, by: env.you })
    }
  }
  for (const [key, w] of want) {
    if (have.has(key)) continue
    add.push({ source: w.iid, ability: w.index, by: controllerOf(state, w.iid) ?? state.cards[w.iid].owner, label: w.label, kind: w.effect.ce === 'statMod' ? w.effect.kind : null, until: 'whileSource', targets: [], host: w.host, body: { effect: w.effect, ei: w.ei, origin: 'static' } })
  }
  // ── 効果で足した層（12-1・12-2）
  const participants = abilityLostChars(ctx, state)
  for (const l of list) {
    if (l.ability !== null || remove.includes(l.id)) continue
    if (l.targets.length && !l.targets.some((x) => onFieldAny(state.cards[x]))) remove.push(l.id)
    else if (l.until === 'whileSource' && l.source && !staticSourceActive(state, l.source)) remove.push(l.id)
    // 《能力禁止》: 参加キャラに対して効果を発揮している特殊能力の効果は失われ、バトルの後も戻らない（FAQ:597・606）
    else if (bodyOf(l).origin === 'ability' && l.targets.some((x) => participants.has(x))) remove.push(l.id)
    // 能力値修正・攻防修正を失う参加キャラ（《鶴来屋温泉三本勝負》）: 発生源を問わず、効果で足した修正の層を外す（戻さない）
    else if (bodyOf(l).mod && l.targets.some((x) => derived(ctx, state).modLost.has(x))) remove.push(l.id)
    // イベントが足した層も（《エクストリーム》《ファッション》。FAQ:3829 スランプなど。R4b-3b-2）
    else if (bodyOf(l).origin === 'event' && l.targets.some((x) => derived(ctx, state).lostEv.has(x))) remove.push(l.id)
  }
  // ── 控え: bound（装備対象が1枚に決まるアイテム）
  const bound: Record<string, string | null> = {}
  for (const c of Object.values(state.cards)) {
    const eq = ctx.defs[c.cardId]?.equip
    if (eq?.bound && c.attachedTo && !(c.iid in state.layers.bound)) bound[c.iid] = c.attachedTo
  }
  for (const k of Object.keys(state.layers.bound)) if (!state.cards[k]?.attachedTo) bound[k] = null
  // ── 控え: 使用できないバトルカード
  const unusable = new Set<string>()
  const d = derived(ctx, state)
  for (const e of d.effs) if (e.effect.ce === 'battleCardUnusable') for (const x of targetsOf(ctx, state, e)) unusable.add(x)
  const unusableList = [...unusable].sort()
  const unusableChanged = unusableList.join(',') !== [...state.layers.unusable].sort().join(',')
  // ── 常に消耗状態（stayRested）
  const orient: { iid: string; to: 'ready' | 'rested'; why: string }[] = []
  const update: { id: string; body: Record<string, unknown> }[] = []
  for (const e of d.effs) {
    const f = e.effect
    if (f.ce !== 'stayRested') continue
    const b = bodyOf(e.layer)
    const locked = new Set(b.locked ?? [])
    let changed = false
    for (const x of targetsOf(ctx, state, e)) {
      const c = state.cards[x]
      if (!isCharOnField(c)) continue
      if (f.always || locked.has(x)) {
        if (c.orientation === 'ready' && !orient.some((o) => o.iid === x)) orient.push({ iid: x, to: 'rested', why: e.layer.label })
      } else if (c.orientation === 'rested') {
        locked.add(x)
        changed = true
      }
    }
    if (changed) update.push({ id: e.layer.id, body: { ...b, locked: [...locked] } })
  }
  // ── 気力の上限を超えた気力（15-4・FAQ:249・4203）
  const clamp: { iid: string; value: number }[] = []
  for (const c of Object.values(state.cards)) {
    if (!isCharOnField(c) || c.kiryoku === null) continue
    const max = maxKiryokuOf(ctx, state, c.iid)
    if (max !== null && c.kiryoku > max) clamp.push({ iid: c.iid, value: max })
  }
  const acts: BoardAction[] = []
  const hasBound = Object.keys(bound).length > 0
  if (add.length || remove.length || update.length || hasBound || unusableChanged || clamp.length || orient.length) {
    acts.push({
      type: 'procLayers',
      ...(add.length ? { add } : {}),
      ...(remove.length ? { remove } : {}),
      ...(update.length ? { update } : {}),
      ...(hasBound ? { bound } : {}),
      ...(unusableChanged ? { unusable: unusableList } : {}),
      ...(clamp.length ? { clamp } : {}),
      ...(orient.length ? { orient } : {}),
    })
  }
  // whenLost の Op は、どの宣言にも属さない効果として積む（その場で処理する）
  for (const x of lostOps) acts.push(lostEffect(x.ops, x.env, x.label, x.by))
  return acts
}

function rank(c: CardInstance): number {
  if (c.attachedTo) return 2
  return c.zone === 'leader' ? 0 : c.zone === 'char' ? 1 : 3
}

/** 特殊能力を失っているキャラ（《能力禁止》が効いているバトルの参加キャラ＝層の loseAbilities の対象） */
function abilityLostChars(ctx: EngineCtx, state: BoardState): Set<string> {
  return derived(ctx, state).lost
}

/** 効果の Op を、どの宣言にも属さない効果として積む（drive の forceOp と同じ形） */
function lostEffect(ops: Op[], env: Env, label: string, by: Seat): BoardAction {
  const eng = { tasks: ops.map((op) => ({ op })), env, started: false, optional: false, recheck: null, awaiting: null, seq: 0 }
  return { type: 'procStart', item: { key: `lost:${label}:${env.self}`, label: `${label}（効果が失われた）`, by, sourceIid: env.self, eng: eng as unknown as Record<string, unknown> } }
}

// ───────────────────────────────────────────────────────────────
// 場の制限（K12）: 状態が変わるたびに判定し、違反なら使用権者に選ばせて是正する
// ───────────────────────────────────────────────────────────────

export interface LimitRule {
  id: string
  rule: string
  where: string
}

/** 場の制限の表（原典の行つき。HANDOFF-R3 §7-4 と同じ） */
export const LIMIT_RULES: LimitRule[] = [
  { id: 'sameName', rule: '同名キャラ制限: 同じカード名のキャラは自分のフィールドに1体まで', where: '15-2 oldrule.txt:597-598' },
  { id: 'component', rule: '構成要素キャラ制限: タッグとその構成要素キャラ・同じ構成要素を持つ別々のタッグはどちらか1体まで', where: '15-2 oldrule.txt:599-602' },
  { id: 'charCount', rule: 'キャラ数制限: リーダーを除いて5体まで', where: '15-2 oldrule.txt:603-604' },
  { id: 'equipTarget', rule: '装備対象: 装備対象と違う対象に装備されたアイテムはゴミ箱送り', where: '17-1 oldrule.txt:846-853' },
  { id: 'equipSameName', rule: '装備制限（同名制限）: 1つの装備対象に同じカード名のアイテムは1枚まで', where: '17-2 oldrule.txt:854-860' },
  { id: 'battleCards', rule: 'バトルカードの配置制限: 自分のフィールドに3枚まで', where: '19-1 oldrule.txt:980-986' },
]

function exempt(ctx: EngineCtx, state: BoardState, iid: string, limit: 'charCount' | 'sameName' | 'component'): boolean {
  // 例外は DSL の exemptLimit（常時効果。カードの特性 FAQ:1962）
  const c = state.cards[iid]
  const def = c ? ctx.defs[c.cardId] : undefined
  for (const ab of def?.abilities ?? []) {
    if (ab.kind !== 'static') continue
    for (const f of ab.effects) {
      if (f.ce !== 'exemptLimit' || f.limit !== limit) continue
      const env: Env = { self: iid, you: controllerOf(state, iid) ?? c!.owner, slots: {}, trigger: null, declId: null, declared: {} }
      const xs = 'zone' in f.who ? select(ctx, state, env, f.who) : resolveRef(state, env, f.who)
      if (xs.includes(iid)) return true
    }
  }
  return false
}

interface LimitViolation {
  seat: Seat
  rule: LimitRule
  options: string[]
}

/** 今の違反（AP の側から）。options＝ゴミ箱送りにする候補（制限を受けているものだけ FAQ:3299） */
export function limitViolations(ctx: EngineCtx, state: BoardState): LimitViolation[] {
  const out: LimitViolation[] = []
  const ap = activeSeat(state)
  const R = (id: string) => LIMIT_RULES.find((r) => r.id === id)!
  const nameOf = (c: CardInstance) => ctx.cards[c.cardId]?.name ?? c.cardId
  for (const seat of [ap, other(ap)]) {
    const chars = Object.values(state.cards).filter((c) => isCharOnField(c) && (controllerOf(state, c.iid) ?? c.owner) === seat)
    const trashable = (c: CardInstance) => c.zone !== 'leader'
    // 同名キャラ制限
    const byName = new Map<string, CardInstance[]>()
    for (const c of chars) if (!exempt(ctx, state, c.iid, 'sameName')) byName.set(nameOf(c), [...(byName.get(nameOf(c)) ?? []), c])
    for (const g of byName.values()) if (g.length > 1) out.push({ seat, rule: R('sameName'), options: g.filter(trashable).map((c) => c.iid) })
    // 構成要素キャラ制限（タッグの名前は構成要素の名前を「＆」でつないだもの）
    const tags = chars.filter((c) => ctx.cards[c.cardId]?.kind === 't' && !exempt(ctx, state, c.iid, 'component'))
    for (const t of tags) {
      const names = nameOf(t).split('＆')
      const clash = chars.filter((c) => c.iid !== t.iid && !exempt(ctx, state, c.iid, 'component') && (names.includes(nameOf(c)) || (ctx.cards[c.cardId]?.kind === 't' && nameOf(c).split('＆').some((n) => names.includes(n)))))
      if (clash.length) out.push({ seat, rule: R('component'), options: [t, ...clash].filter(trashable).map((c) => c.iid) })
    }
    // キャラ数制限（例外のキャラは数えず、選ばない FAQ:3329）
    const counted = chars.filter((c) => c.zone !== 'leader' && !exempt(ctx, state, c.iid, 'charCount'))
    if (counted.length > 5) out.push({ seat, rule: R('charCount'), options: counted.map((c) => c.iid) })
    // アイテム（使用権者＝装備しているキャラ／バトルカードの使用者）
    const items = Object.values(state.cards).filter((c) => c.attachedTo && staticSourceActive(state, c.iid) && (controllerOf(state, c.iid) ?? c.owner) === seat)
    const bad = items.filter((c) => equipProblem(ctx, state, c, c.attachedTo!))
    if (bad.length) out.push({ seat, rule: R('equipTarget'), options: bad.map((c) => c.iid) })
    const byHost = new Map<string, CardInstance[]>()
    for (const c of items) byHost.set(`${c.attachedTo}:${nameOf(c)}`, [...(byHost.get(`${c.attachedTo}:${nameOf(c)}`) ?? []), c])
    for (const g of byHost.values()) if (g.length > 1) out.push({ seat, rule: R('equipSameName'), options: g.map((c) => c.iid) })
    // バトルカード
    const bcs = Object.values(state.cards).filter((c) => c.zone === 'battle' && c.owner === seat)
    if (bcs.length > 3) out.push({ seat, rule: R('battleCards'), options: bcs.map((c) => c.iid) })
  }
  return out
}

/**
 * 是正の1手（無ければ null）: 1枚ずつ選んでゴミ箱送り（15-2・17-1・17-2・19-1「１体（１枚）づつ選択して」）。
 * 候補が1枚だけのときは聞かずに行う【決めたこと】。手順の選択を待っている間・ゲームが終わった後は行わない
 */
export function limitFix(ctx: EngineCtx, state: BoardState): BoardAction | null {
  if (state.result || state.procMeta.choice) return null
  const v = limitViolations(ctx, state)[0]
  if (!v || v.options.length === 0) return null
  const reason = `${v.rule.rule}（${v.rule.where}）`
  if (v.options.length === 1) return { type: 'procLimitTrash', iids: v.options, reason }
  return {
    type: 'procChoice',
    choice: {
      id: `limit:${state.procMeta.seq}:${v.rule.id}:${v.seat}`,
      by: v.seat,
      kind: 'select',
      purpose: 'limitTrash',
      prompt: `場の制限: ゴミ箱送りにする1枚を選ぶ — ${reason}`,
      options: v.options.map((iid) => ({ key: iid, label: ctx.cards[state.cards[iid]?.cardId ?? '']?.name ?? iid })),
      min: 1,
      max: 1,
      frameId: null,
    },
  }
}

// ───────────────────────────────────────────────────────────────
// 効果で層を足す（statMod・addContinuous の Op）
// ───────────────────────────────────────────────────────────────

/**
 * バトルに依存する PlayerRef（'battleUser'・'challenger'・'challenged'）は、層を毎回導き出すたびに（layerEnv・resolvePlayer で）
 * nearestBattle を探す形だと、バトルが終わった後は env.you（このカードの使用権者＝置いた側）にフォールバックしてしまい、
 * 挑んだ側と置いた側が違うときに誤った側に効いてしまう（統括16 の検証・HANDOFF-R4b.md §7）。
 * 層を作る時点（＝バトル進行中）で席を確定し、以後は resolvePlayer を経由せずその席のまま使う（{ seat }・R4b-1 続き）。
 */
function freezeBattleRef(state: BoardState, env: Env, p: (PlayerRef | 'any') | undefined): (PlayerRef | 'any') | undefined {
  if (typeof p !== 'string') return p
  if (p !== 'battleUser' && p !== 'challenger' && p !== 'challenged') return p
  return { seat: resolvePlayer(state, env, p) }
}

/** addContinuous の効果の中の ActionPattern.by を、層を作る時点で解決して固定する（freezeBattleRef 参照） */
function freezeBattleRefsIn(state: BoardState, env: Env, effect: Continuous): Continuous {
  if (effect.ce === 'prohibit') return { ...effect, action: { ...effect.action, by: freezeBattleRef(state, env, effect.action.by) } }
  if (effect.ce === 'costMod') return { ...effect, applies: { ...effect.applies, by: freezeBattleRef(state, env, effect.applies.by) } }
  return effect
}

/** addContinuous の Op の層（対象は足したときに決まる 12-1。期限は Duration から） */
export function continuousSeed(ctx: EngineCtx, state: BoardState, env: Env, effect: Continuous, duration: 'turn' | 'battle' | 'whileSource', label: string, origin: LayerBody['origin']): LayerSeed {
  const who = (effect as { who?: CardRef | Selector }).who
  const targets = who ? ('zone' in who ? select(ctx, state, env, who) : resolveRef(state, env, who)) : []
  return {
    source: env.self,
    ability: null,
    by: env.you,
    label,
    kind: effect.ce === 'statMod' ? effect.kind : null,
    until: duration,
    targets,
    host: null,
    body: { effect: freezeBattleRefsIn(state, env, effect), env: { self: env.self, you: env.you, slots: env.slots }, origin },
  }
}

/** 看護（clearMods）: そのカードに効果で足した修正の層（12-1）の id */
export function clearableMods(state: BoardState, iid: string, kind: '能力値修正' | '攻防修正'): string[] {
  return state.layers.list.filter((l) => l.ability === null && l.kind === kind && l.targets.includes(iid)).map((l) => l.id)
}


