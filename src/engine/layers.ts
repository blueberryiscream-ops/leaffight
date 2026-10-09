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
import { COPY_BASE, GRANT_BASE, abilityAt, findAbilityOn } from './abilities'
import type { Ability, ActionPattern, Attr, CardDef, CardRef, Continuous, Cost, CostIcon, Op, PlayerRef, Selector } from './dsl'
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
  mod?: { stat: string; delta: number; set?: true; immune?: ('イベント' | '特殊能力' | 'アイテム')[] }
  /** 継続効果 */
  effect?: Continuous
  /** 効果で足した継続効果の評価の環境（常時効果は毎回 self＝発生源・you＝その使用者） */
  env?: EnvLite
  /** 常時効果: 能力の effects の番号 */
  ei?: number
  /** 足した行動の種類（《能力禁止》FAQ:606 は特殊能力の効果を失わせる） */
  origin?: 'ability' | 'event' | 'static' | 'force'
  /** 常時効果の層を足した（装備した）時点の性別（衣装 costume の setSex を除いた性別。costumeWas が読む。NH-36①・R4c G6a-1） */
  sx0?: string
  /** stayRested: 消耗状態になって固定されたカード */
  locked?: string[]
}

const bodyOf = (l: Layer) => l.body as LayerBody

/** 効果で足した修正の層（statMod の Op・12-1）。期限: バトル終了時まで・攻防修正→ battle、それ以外→ turn */
export function modSeed(iid: string, stat: string, delta: number, kind: '能力値修正' | '攻防修正', until: 'turn' | 'battle', by: Seat, source: string | null, label: string, origin: LayerBody['origin'], set = false, immune?: ('イベント' | '特殊能力' | 'アイテム')[]): LayerSeed {
  // set＝その能力値を delta に置き換える層（《お手本》のコピー FAQ:2601。currentStats が連番の順に重ねる。R4c G2b-1b）
  return { source, ability: null, by, label, kind, until, targets: [iid], host: null, body: { mod: set ? { stat, delta, set: true, ...(immune ? { immune } : {}) } : { stat, delta }, origin } }
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
  /** 特殊能力を失わせている層の連番（loseAbilities の最大 seq。shieldParticipants は Infinity）。これより後に得た能力は有効（《狸の置物》FAQ:528。R4c G6a-3） */
  lostSeq: Map<string, number>
  /** イベントが効果を失う参加キャラ（shieldParticipants from イベント） */
  lostEv: Set<string>
  /** 能力値修正・攻防修正を発生源を問わず失う参加キャラ（shieldParticipants mods。鶴来屋温泉三本勝負） */
  modLost: Set<string>
  /** 装備しているアイテムが効果を失うキャラ（itemsLoseEffects。《忘れ物》R4c G6b-1） */
  itemsLost: Set<string>
  /** 効かなくなっている常時効果の層の id（失われたキャラの能力・効果を失ったアイテム。shieldParticipants 分は除く。戻ったら seq を取り直す NH-37⑯） */
  held: Set<string>
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
    return { self, you, slots: {}, trigger: null, declId: null, declared: {}, host: l.host, ...(b.sx0 !== undefined ? { sx0: b.sx0 } : {}) }
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
  const d0: Derived = { ctx, effs: all, lost: new Set(), lostSeq: new Map(), lostEv: new Set(), modLost: new Set(), itemsLost: new Set(), held: new Set(), srcA: new Map(), srcE: new Map() }
  cache.set(state, d0)
  const lost = new Set<string>()
  const lostSeq = new Map<string, number>()
  const lostEv = new Set<string>()
  const modLost = new Set<string>()
  const srcA = new Map<string, Eff>()
  const srcE = new Map<string, Eff>()
  const itemsLost = new Set<string>()
  // 「効果を失う」効果どうしは先に発揮した方が勝つ（FAQ:2196・NH-37⑯）: 連番の順に見て、その時点で自分が失われている層は働かない
  const winners = new Set<string>()
  const suppressedNow = (e: Eff): boolean => {
    const s = e.layer.source
    const sc = s ? state.cards[s] : undefined
    if (e.layer.ability === null || !s || !sc) return false
    if (isCharSource(ctx, state, s)) return isCharOnField(sc) && lost.has(s)
    return !!sc.attachedTo && itemsLost.has(sc.attachedTo)
  }
  for (const e of all) {
    if (e.effect.ce === 'itemsLoseEffects') {
      if (suppressedNow(e)) continue
      winners.add(e.layer.id)
      for (const x of targetsOf(ctx, state, e)) itemsLost.add(x)
    } else if (e.effect.ce === 'loseAbilities') {
      if (suppressedNow(e)) continue
      winners.add(e.layer.id)
      for (const x of targetsOf(ctx, state, e)) { lost.add(x); lostSeq.set(x, Math.max(lostSeq.get(x) ?? -1, e.layer.seq)) }
    } else if (e.effect.ce === 'shieldParticipants') {
      const f = e.effect
      if (f.when && !evalCond(ctx, state, e.env, f.when)) continue
      for (const x of targetsOf(ctx, state, e)) {
        if (f.from.includes('特殊能力')) { lost.add(x); lostSeq.set(x, Infinity); srcA.set(x, e) }
        if (f.from.includes('イベント')) { lostEv.add(x); srcE.set(x, e) }
        if (f.mods) modLost.add(x)
      }
    }
  }
  const offLayer = (e: Eff): boolean => {
    const s = e.layer.source
    if (e.layer.ability === null || !s || winners.has(e.layer.id)) return false
    const sc = state.cards[s]
    if (lost.has(s) && isCharOnField(sc)) return true
    return !!sc?.attachedTo && itemsLost.has(sc.attachedTo)
  }
  const effs = all.filter((e) => !offLayer(e))
  const held = new Set(all.filter((e) => offLayer(e) && !(e.layer.source && lostSeq.get(e.layer.source) === Infinity)).map((e) => e.layer.id))
  const d: Derived = { ctx, effs, lost, lostSeq, lostEv, modLost, itemsLost, held, srcA, srcE }
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
  // [水中バトルペナルティ] 等を受けない（ignorePenalty。同じ能力の中の修正は丸ごと及ばない。R4c G2b-2b）
  if (e.layer.ability !== null && e.effect.ce !== 'ignorePenalty' && penaltyIgnored(ctx, state, e, iid)) return false
  return true
}

function penaltyIgnored(ctx: EngineCtx, state: BoardState, e: Eff, iid: string): boolean {
  for (const g of derived(ctx, state).effs) if (g.effect.ce === 'ignorePenalty' && g.effect.name === e.layer.label && effectOn(ctx, state, g, iid)) return true
  return false
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

// ───────────────────────────────────────────────────────────────
// 今の性別・キャラタイプ・属性（規 15-7〜15-9「キャラの現在の〜」。R4c G6a-1・NH-36③）
// 場のキャラは印刷の値に層を連番（seq）の順に当てる（後から発揮された効果が勝つ 12-2）。手札・デッキ・ゴミ箱は印刷の値（FAQ:1468・2625）
// ───────────────────────────────────────────────────────────────

/** キャラの今の性別（'男性'・'女性'・'両方'・''＝無し）。excludeCostume＝衣装（costume）の置き換えを除いた性別（NH-36①） */
export function sexOf(ctx: EngineCtx, state: BoardState, iid: string, opts?: { excludeCostume?: boolean }): string {
  const c = state.cards[iid]
  let s: string = (c ? ctx.cards[c.cardId]?.sex : undefined) ?? ''
  if (!c || !isCharOnField(c)) return s
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce !== 'setSex' || (opts?.excludeCostume && f.costume)) continue
    if (effectOn(ctx, state, e, iid)) s = f.sex
  }
  return s
}

/** キャラの今のキャラタイプ（元のタイプは残り、足したタイプが増える 15-9。同名は1つ FAQ:3365） */
export function charTypesOf(ctx: EngineCtx, state: BoardState, iid: string): string[] {
  const c = state.cards[iid]
  const out = [...((c ? ctx.cards[c.cardId]?.charTypes : undefined) ?? [])]
  if (!c || !isCharOnField(c)) return out
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce === 'addCharType' && !out.includes(f.type) && effectOn(ctx, state, e, iid)) out.push(f.type)
  }
  return out
}

/** キャラの今の属性（複数持てる。置き換えは後から発揮された効果が勝つ 15-7・12-2） */
export function attrsNow(ctx: EngineCtx, state: BoardState, iid: string): Attr[] {
  const c = state.cards[iid]
  let out = [...((c ? ctx.cards[c.cardId]?.attr : undefined) ?? '')].filter((ch) => ATTRS.includes(ch as Attr)) as Attr[]
  if (!c || !isCharOnField(c)) return out
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce === 'setAttrs' && effectOn(ctx, state, e, iid)) out = [...f.attrs]
  }
  return out
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
  // 「あらゆるイベント・特殊能力の影響を受けない」印つきの set（スーパー御堂。NH-29・NH-27⑦）: 能力値 = set の値 + アイテム・フィールド・バトルカードの修正（層の前後を問わず）。
  // 発生源がイベント／特殊能力（キャラ・タッグ）の修正・入れ替えはその能力値に当たらない
  const imm = new Map<string, Set<string>>()
  for (const l of [...state.layers.list].sort((a, b) => a.seq - b.seq)) {
    const m = bodyOf(l).mod
    if (m?.set && m.immune && l.kind === '能力値修正' && l.targets.includes(iid) && m.stat in v && !d.modLost.has(iid)) {
      // 先に掛かった「影響を受けない」が、後から来る（その種類の）印つきの set も止める（FAQ:2495-2496・NH-37⑨）
      const sk = ctx.cards[l.source ? state.cards[l.source]?.cardId ?? '' : '']?.kind ?? ''
      if (imm.get(m.stat)?.has(sk)) continue
      v[m.stat] = m.delta
      imm.set(m.stat, new Set(m.immune.flatMap((x) => (x === 'イベント' ? ['e'] : x === 'アイテム' ? ['i'] : ['c', 't']))))
    }
  }
  const blocked = (stat: string, src: string | null) => !!imm.get(stat)?.has(ctx.cards[src ? state.cards[src]?.cardId ?? '' : '']?.kind ?? '')
  const items: { seq: number; run: () => void }[] = []
  for (const l of state.layers.list) {
    const m = bodyOf(l).mod
    if (m && l.kind === '能力値修正' && l.targets.includes(iid) && m.stat in v && !d.modLost.has(iid)) items.push({ seq: l.seq, run: () => { if (imm.has(m.stat) && (m.immune || blocked(m.stat, l.source))) return; if (m.set) v[m.stat] = m.delta; else v[m.stat] += m.delta } }) // set＝置き換え: この層より前の修正は上書き・後の層は足される（swapStats と同じ考え方 H-6。FAQ:2601）
  }
  for (const e of d.effs) {
    const f = e.effect
    if (f.ce === 'statMod' && f.kind === '能力値修正') {
      if (d.modLost.has(iid)) continue
      items.push({ seq: e.layer.seq, run: () => !(imm.has(f.stat) && blocked(f.stat, e.layer.source)) && effectOn(ctx, state, e, iid) && (f.mode === 'set' ? (v[f.stat] = evalExpr(ctx, state, e.env, f.delta)) : (v[f.stat] += evalExpr(ctx, state, e.env, f.delta))) })
    } else if (f.ce === 'statByAttr') {
      // 《レベルアップ／ダウン》: 今の属性と同じ能力値を delta（R4c G6a-2）。属性が1つならそれ・複数なら指定した1つ・無ければ修正しない
      if (d.modLost.has(iid)) continue
      items.push({ seq: e.layer.seq, run: () => { if (!effectOn(ctx, state, e, iid)) return; const a = levelStatAttr(ctx, state, e, iid); if (a) v[a] += f.delta } })
    } else if (f.ce === 'statSwap') {
      if (d.modLost.has(iid)) continue // 入れ替えも能力値修正（FAQ:455・1656。バトルの後は戻る FAQ:3816）
      items.push({ seq: e.layer.seq, run: () => { const keep = { ...v }; if (effectOn(ctx, state, e, iid) && swapStats(ctx, state, e, iid, v)) for (const st of imm.keys()) if (blocked(st, e.layer.source)) v[st] = keep[st] } })
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
    const answer = itemIid ? state.procMeta.answers[`swap:${itemIid}:${c?.cardId ?? ''}`] : undefined
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
    for (const iid of targetsOf(ctx, state, e)) {
      if (!effectOn(ctx, state, e, iid)) continue
      const c = state.cards[iid]
      // 答えの鍵に装備先のカードも入れる: タッグ化・二重人格で元の値の出所が変われば指定し直す（FAQ:445・NH-37⑩）
      const key = `swap:${itemIid}:${c?.cardId ?? ''}`
      if (state.procMeta.answers[key]) continue
      const printed = c ? ctx.cards[c.cardId]?.stats : null
      if (!printed) continue
      const { hi, lo } = tiedHiLo(printed)
      if (hi.length <= 1 && lo.length <= 1) continue
      if (hi[0] === lo[0]) continue
      const opts: { key: string; label: string }[] = []
      for (const a of hi) for (const b of lo) if (a !== b) opts.push({ key: `${a}:${b}`, label: `${a}と${b}を入れ替える` })
      // 「装備させたプレイヤー」＝アイテムの持ち主。層の you は装備先の使用者（controllerOf）なので、相手のキャラに付けたとき取り違える（G6a-2 のレベルダウンと同じ。NH-37⑩）
      const chooser = e.effect.tieBreak.chooser === 'equipper' ? state.cards[itemIid]?.owner ?? resolvePlayer(state, layerEnv(state, e.layer), 'you') : resolvePlayer(state, layerEnv(state, e.layer), e.effect.tieBreak.chooser)
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
  // 常時効果（ce statMod の攻防修正）。《エリート》「[攻]＋２できる」（R4c G2a・FAQ:1281）
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce === 'statMod' && f.kind === '攻防修正' && f.stat === side && effectOn(ctx, state, e, iid)) n += evalExpr(ctx, state, e.env, f.delta)
  }
  for (const m of manualMods(state, iid)) if (m.kind === '攻防修正' && m.battleStat === side && m.delta !== undefined) n += m.delta
  return n
}

/** 《腹ぺこ》: 気力を回復させる効果（kiryoku recover:true）の影響を受けないキャラか（NH-31②）。受けないなら効果の名前 */
export function recoverIgnored(ctx: EngineCtx, state: BoardState, iid: string): string | null {
  for (const e of derived(ctx, state).effs) if (e.effect.ce === 'ignoreRecover' && effectOn(ctx, state, e, iid)) return e.layer.label
  return null
}

/** 《アンチ・ドロー》（R4c G5f-1）: 場にある間、カードの効果のドロー（draw／drawBoth）は行わない。どちらのプレイヤーのものにも及ぶ */
export function drawCancelled(ctx: EngineCtx, state: BoardState): string | null {
  for (const e of derived(ctx, state).effs) if (e.effect.ce === 'noDraw') return e.layer.label
  return null
}

/** W の発生を変える常時効果（R4c G3b-1・NH-33⑥）: 'none'＝《エンプティ》／'extra'＝《ブースト》／null＝なし。両方のプレイヤーに効く。18-2 で同時には場に無い */
export function wGenMode(ctx: EngineCtx, state: BoardState): 'none' | 'extra' | null {
  let m: 'none' | 'extra' | null = null
  for (const e of derived(ctx, state).effs) {
    if (e.effect.ce === 'noW') return 'none'
    if (e.effect.ce === 'extraW') m = 'extra'
  }
  return m
}

/** 発生するコストを直す（W の発生を1か所に集める。効果の generateCost と 7-2[7] の両方が通る）。エンプティ＝W を消す／ブースト＝W ごとに属性無しの W を足す。W 以外はそのまま */
export function adjustGenerated<T extends { icon: string; attrs: string[] }>(ctx: EngineCtx, state: BoardState, tokens: T[]): T[] {
  const m = wGenMode(ctx, state)
  if (!m) return tokens
  return tokens.flatMap((t) => (t.icon !== 'W' ? [t] : m === 'none' ? [] : [t, { ...t, attrs: [] }]))
}

/** 7-2 の発生源（field）になったキャラ iid に掛かる常時効果（R4c G3b-2）: extra＝財布・メイド服の枚数／mirror＝集魔の鏡／drain＝背後霊 */
export function costGenFx(ctx: EngineCtx, state: BoardState, iid: string): { extra: number; mirror: boolean; drain: boolean } {
  const r = { extra: 0, mirror: false, drain: false }
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce === 'extraWOnGen' && effectOn(ctx, state, e, iid)) r.extra++
    else if (f.ce === 'genAsG' && effectOn(ctx, state, e, iid)) r.mirror = true
    else if (f.ce === 'restDrain' && effectOn(ctx, state, e, iid)) r.drain = true
  }
  return r
}

/** 7-2[7]《コストを発生する場合》（R4c G3b-2）: 発生源を直す。順＝財布・メイド服の W を足す → adjustGenerated（ブースト・エンプティ）→ 鏡（選んだ属性の G にする。ブーストの増分は変えない）。drain＝気力－1 するキャラ（背後霊） */
export function editCostGen<T extends { iid: string; from: string; icon: string; attrs: string[] }>(ctx: EngineCtx, state: BoardState, frameId: string, sources: T[]): { sources: T[]; drain: string[] } {
  const drain: string[] = []
  const out: T[] = []
  for (const s of sources) {
    const fx = s.from === 'field' ? costGenFx(ctx, state, s.iid) : null
    const group = fx ? [{ ...s, own: true }, ...Array.from({ length: fx.extra }, () => ({ ...s, icon: 'W', attrs: [] as string[], own: true }))] : [{ ...s, own: false }]
    if (fx?.drain) drain.push(s.iid)
    const pick = fx?.mirror ? state.procMeta.answers[`mirror:${frameId}:${s.iid}`]?.[0] : undefined
    for (const t of group) {
      // adjustGenerated は [元, 増分] を返す（エンプティなら空）。増分は発生源のコストではない＝鏡で変えない
      adjustGenerated(ctx, state, [t]).forEach((u, i) => {
        const { own, ...rest } = u as typeof u & { own: boolean }
        out.push(own && i === 0 && pick && pick !== '使わない' ? ({ ...rest, icon: 'G', attrs: [pick] } as unknown as T) : (rest as unknown as T))
      })
    }
  }
  return { sources: out, drain }
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

export interface Granted {
  ab: Extract<Ability, { kind: 'activated' }>
  /** 得させているカード（アイテム）の id・iid と、そこでの能力の番号（abilities.ts GRANT_BASE） */
  cardId: string
  itemIid: string
  index: number
}

/** そのキャラが今得ている特殊能力（ce grantAbility。装備している間だけ・特殊能力を失っていなければ）。《釘バット》NH-31⑤ */
export function grantedAbilities(ctx: EngineCtx, state: BoardState, iid: string): Granted[] {
  const d = derived(ctx, state)
  // 特殊能力を失わせている層より後に得た能力は有効（FAQ:528）。失わせている層より前に得た能力は失われる
  const lostAt = d.lost.has(iid) ? d.lostSeq.get(iid) ?? Infinity : -1
  const out: Granted[] = []
  for (const e of d.effs) {
    if (e.effect.ce !== 'grantAbility' || e.layer.ability === null || !e.layer.source || e.layer.seq < lostAt || !effectOn(ctx, state, e, iid)) continue
    const item = state.cards[e.layer.source]
    if (item) out.push({ ab: e.effect.ability, cardId: item.cardId, itemIid: item.iid, index: GRANT_BASE + e.layer.ability * 100 + (bodyOf(e.layer).ei ?? 0) })
  }
  // 模写でコピーした起動型（元の cardId・番号のまま。使用回数はコピーしたキャラの分として別に数える FAQ:2179）
  for (const k of copiedAbilities(ctx, state, iid)) if (k.ab.kind === 'activated') out.push({ ab: k.ab, cardId: k.cardId, itemIid: k.layerSource, index: k.index })
  return out
}

/** そのキャラが今コピーしている能力（模写。ce copiedAbility の層。特殊能力を失わせている層より前にコピーした能力は失われる FAQ:528 の考え。NH-37⑦: コピー元が場を離れても残る） */
export function copiedAbilities(ctx: EngineCtx, state: BoardState, iid: string): { ab: Ability; cardId: string; index: number; layerSource: string }[] {
  const d = derived(ctx, state)
  const lostAt = d.lost.has(iid) ? d.lostSeq.get(iid) ?? Infinity : -1
  const out: { ab: Ability; cardId: string; index: number; layerSource: string }[] = []
  for (const l of state.layers.list) {
    const f = bodyOf(l).effect
    if (!f || f.ce !== 'copiedAbility' || !l.targets.includes(iid) || l.seq < lostAt) continue
    const ab = abilityAt(ctx, f.cardId, f.index)
    if (ab) out.push({ ab, cardId: f.cardId, index: f.index, layerSource: l.source ?? iid })
  }
  return out
}

/** 模写で選べる能力の名前: そのキャラが今持っている名前つきの特殊能力（印刷・得た能力。失っている能力は選べない rule:1177。使えない状態の能力は選べる FAQ:570） */
export function copyableAbilityNames(ctx: EngineCtx, state: BoardState, iid: string): string[] {
  const c = state.cards[iid]
  if (!c || !isCharOnField(c) || derived(ctx, state).lost.has(iid)) return []
  const names: string[] = []
  for (const ab of ctx.defs[c.cardId]?.abilities ?? []) if ((ab.kind === 'activated' || ab.kind === 'static' || ab.kind === 'conditional') && ab.name) names.push(ab.name)
  for (const g of grantedAbilities(ctx, state, iid)) if (g.ab.name) names.push(g.ab.name)
  return [...new Set(names)]
}

/** 模写の処理: コピーする能力の層（ターン終了時まで）。新たな能力をコピーした時は前のコピーは失われる（remove） */
export function copyLayer(ctx: EngineCtx, state: BoardState, env: Env, srcIid: string, name: string, label: string): { add: LayerSeed; remove: string[] } | null {
  const card = state.cards[srcIid]
  if (!card || !env.self || !copyableAbilityNames(ctx, state, srcIid).includes(name)) return null
  const found = findAbilityOn(ctx, state, card, name)
  if (!found) return null
  const effect: Continuous = { ce: 'copiedAbility', who: { ref: 'self' }, cardId: found.cardId, index: found.index }
  const remove = state.layers.list.filter((l) => bodyOf(l).effect?.ce === 'copiedAbility' && l.targets.includes(env.self!)).map((l) => l.id)
  return { add: continuousSeed(ctx, state, env, effect, 'turn', label, 'ability'), remove }
}

/** そのアイテムが、効果を失っているキャラに装備されているか（《忘れ物》） */
export function itemEffectsLostFor(ctx: EngineCtx, state: BoardState, itemIid: string): boolean {
  const c = state.cards[itemIid]
  return !!c?.attachedTo && ctx.cards[c.cardId]?.kind === 'i' && derived(ctx, state).itemsLost.has(c.attachedTo)
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

/** 宣言の種類（禁止・対象にならない・使用代償の増減が見る）。アクションアイテム（decl.kind は 'event' と同じ手順）は 'その他'（17-7・FAQ:1080・3428。統括24） */
export function declActionKind(decl: ProcDecl): ActionPattern['kinds'][number] {
  return (decl.eng as { actionItem?: boolean } | undefined)?.actionItem ? 'その他' : ACTION_KIND[decl.kind]
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
  const ab = abilityAt(ctx, cardId, idx)
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
  const ab = abilityAt(ctx, cardId, idx)
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
export function violations(ctx: EngineCtx, state: BoardState, decl: ProcDecl, printedCost?: Cost): Violation[] {
  const out: Violation[] = []
  const kind = declActionKind(decl)
  const d = derived(ctx, state)
  const name = (iid: string) => ctx.cards[state.cards[iid]?.cardId ?? '']?.name ?? iid
  for (const e of d.effs) {
    const f = e.effect
    if (f.ce !== 'prohibit' || !f.action.kinds.includes(kind)) continue
    if (f.when && !evalCond(ctx, state, e.env, f.when)) continue
    // R4c G4b 《計画阻止》FAQ:1231: costIsZero＝印刷された使用代償にコストアイコンが無い（支払いの増減は見ない）。印刷値が分からない宣言は当てはまらない
    if (f.action.costIsZero && (!printedCost || printedCost.icons.length !== 0)) continue
    if (!patternHits(ctx, state, e, f.action, decl)) continue
    out.push({ kind: 'prohibit', text: `「${e.layer.label}」により${kind}を使えない`, source: e.layer.label, sourceIid: e.layer.source })
  }
  // 特殊能力を失っているキャラは、自分の特殊能力を宣言できない（《狸の置物》FAQ:522。参加キャラ自身の能力は使える FAQ:3735＝shieldParticipants は除く）。得た能力（GRANT_BASE 以上）は grantedAbilities が見る
  if (decl.kind === 'ability' && decl.sourceIid && isCharSource(ctx, state, decl.sourceIid) && isCharOnField(state.cards[decl.sourceIid]) && d.lost.has(decl.sourceIid) && !d.srcA.has(decl.sourceIid) && ((decl.eng.index as number | undefined) ?? 0) < GRANT_BASE) {
    out.push({ kind: 'lostAbility', text: `${name(decl.sourceIid)}は特殊能力を失っているので、その特殊能力を使用できない`, source: '特殊能力を失う', sourceIid: null })
  }
  // 効果を失っているアイテム（《忘れ物》）の起動型の特殊能力・アクションアイテムは使えない（R4c G6b-1）
  if ((decl.kind === 'ability' || (decl.kind === 'event' && (decl.eng as { actionItem?: boolean }).actionItem)) && decl.sourceIid && itemEffectsLostFor(ctx, state, decl.sourceIid)) {
    out.push({ kind: 'lostAbility', text: `${name(decl.sourceIid)}は効果を失っているので、使用できない`, source: '効果を失う', sourceIid: null })
  }
  const allTargets = new Set([...decl.targets, ...implicitTargetsOf(ctx, state, decl)])
  for (const t of allTargets) {
    const u = untargetableBy(ctx, state, t, kind)
    if (u) out.push({ kind: 'untargetable', text: `${name(t)}は「${u.layer.label}」により${kind}の対象にならない（空打ち 11-3）`, source: u.layer.label, sourceIid: u.layer.source })
  }
  // FAQ:1168・228: 支払い方法（payWith）で提示したコスト発生の発生源（場のキャラ）も「コスト発生」の対象として扱う
  for (const g of decl.costGens ?? []) {
    for (const s of g) {
      if (s.from !== 'field' || allTargets.has(s.iid)) continue
      const u = untargetableBy(ctx, state, s.iid, 'コスト発生')
      if (u) out.push({ kind: 'untargetable', text: `${name(s.iid)}は「${u.layer.label}」によりコスト発生の対象にならない（空打ち 11-3）`, source: u.layer.label, sourceIid: u.layer.source })
    }
  }
  // 参加キャラに対して効果を発揮する特殊能力・イベントは使えない（FAQ:3735 の線引き。効果が参加キャラに及ばなければ使える＝3070・1013・3224）。
  // 及ぶ＝対象に選ぶ／選ばずに決まる（R4b0 の暗黙の対象 implicitTargetsOf）／forEach・selector で及ぶ
  if (decl.kind === 'ability' || decl.kind === 'event') {
    const sh = decl.kind === 'ability' ? d.lost : d.lostEv
    if (sh.size) {
      for (const t of [...allTargets, ...forEachReach(ctx, state, decl)]) {
        const e = (decl.kind === 'ability' ? d.srcA : d.srcE).get(t)
        // srcA/srcE は shieldParticipants の対象だけ。ただの loseAbilities（《電波での復活》）で能力を失ったキャラは、
        // 自分の能力が働かないだけで、他の能力の効果は受ける（FAQ:544 タックルで手札に戻る。統括19）
        if (!e || !sh.has(t)) continue
        out.push({ kind: 'lostAbility', text: `${name(t)}はバトル参加キャラ（「${e?.layer.label ?? '特殊能力を失う'}」）なので、効果が及ぶ${kind}は使用できない`, source: e?.layer.label ?? '特殊能力を失う', sourceIid: e?.layer.source ?? null })
        break
      }
    }
  }
  // 「コストを発生することができない」（《ビンボー》《一文無し》FAQ:2754・223）: 単独のコスト発生（7-2）も、宣言の支払いで消耗させる発生源も断る。
  // 統括20: R4a-2 の型だけで判定が無かった（雛山理緒が tested のまま素通りしていた）
  const gens = [...(decl.sources ?? []), ...(decl.costGens ?? []).flat()].filter((s) => s.from === 'field').map((s) => s.iid)
  if (gens.length) {
    for (const e of d.effs) {
      if (e.effect.ce !== 'cannotGenerateCost') continue
      const hit = targetsOf(ctx, state, e).find((x) => gens.includes(x))
      if (hit) out.push({ kind: 'prohibit', text: `${name(hit)}は「${e.layer.label}」によりコストを発生できない`, source: e.layer.label, sourceIid: e.layer.source })
    }
  }
  // 「新たにアイテムを装備できなくなる」（《両手いっぱい》）: 装備の宣言の装備先として断る
  if (decl.kind === 'equip' && decl.equipTo) {
    for (const e of d.effs) {
      if (e.effect.ce !== 'cannotEquip' || !targetsOf(ctx, state, e).includes(decl.equipTo)) continue
      out.push({ kind: 'prohibit', text: `${name(decl.equipTo)}は「${e.layer.label}」によりアイテムを装備できない`, source: e.layer.label, sourceIid: e.layer.source })
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

/** 「コストを発生することができない」（cannotGenerateCost）の効果が掛かっているキャラ。属性だけを出すこと（8-2-1 の余りの属性アイコン）もできない（FAQ:2754。R4c G3c） */
export function cannotGenerateIids(ctx: EngineCtx, state: BoardState): Set<string> {
  const out = new Set<string>()
  for (const e of derived(ctx, state).effs) if (e.effect.ce === 'cannotGenerateCost') for (const x of targetsOf(ctx, state, e)) out.add(x)
  return out
}

/** 当てはまる costMod を全部（層の順）集めて足し合わせる。宣言前（declareOne）は decl がまだ無いので軽い形で渡す。
 *  printedCost: applies.costIsZero（《ライジング・コスト》）の判定に使う印刷値の使用代償 */
export function costModOf(ctx: EngineCtx, state: BoardState, kind: ActionPattern['kinds'][number], by: Seat, sourceIid: string | null, targets: string[] = [], printedCost?: Cost, auto = false): { icons: Partial<Record<CostIcon, number>>; kiryoku: number } {
  const icons: Partial<Record<CostIcon, number>> = {}
  let kiryoku = 0
  const pseudo = { by, sourceIid, targets } as ProcDecl
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce !== 'costMod' || !f.applies.kinds.includes(kind)) continue
    if (f.applies.costIsZero && (printedCost?.icons.length ?? 0) !== 0) continue
    if (f.applies.notAuto && auto) continue
    if (f.applies.printedCostMin !== undefined && (printedCost?.icons.length ?? 0) < f.applies.printedCostMin) continue
    if (!patternHits(ctx, state, e, f.applies, pseudo)) continue
    for (const [icon, delta] of Object.entries(f.icons ?? {})) icons[icon as CostIcon] = (icons[icon as CostIcon] ?? 0) + (delta ?? 0)
    kiryoku += f.kiryoku ?? 0
  }
  return { icons, kiryoku }
}

/** R4c G4b（NH-34⑧ 《バーゲン・セール》）: 当てはまる costSet があれば、使用代償の基礎のコストアイコン（後から発揮した効果が後 12-2 なので最後のもの）。無ければ null */
export function costSetOf(ctx: EngineCtx, state: BoardState, kind: ActionPattern['kinds'][number], by: Seat, sourceIid: string | null, targets: string[] = []): CostIcon[] | null {
  let icons: CostIcon[] | null = null
  const pseudo = { by, sourceIid, targets } as ProcDecl
  for (const e of derived(ctx, state).effs) {
    const f = e.effect
    if (f.ce !== 'costSet' || !f.applies.kinds.includes(kind)) continue
    if (!patternHits(ctx, state, e, f.applies, pseudo)) continue
    icons = f.icons
  }
  return icons
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
  // NH-34⑥・FAQ:417・4092・3394: 下限＝使用代償がまったく無い状態にならない。印刷値に要素（コストアイコン・気力－N などの other）が1つ以上あったのに、増減の結果が0個になるときは、
  // 減らす分を減らして1個残す（[W]−W→[W]・[RW]−W→[R]・[WW]−WWW→[W]）。印刷値が元から0個なら0のまま。増減は全部まとめて適用した後の最終値に掛ける（NH-16）
  const elems = (ics: CostIcon[], oth: Cost['other']) => ics.length + (oth ?? []).filter((o) => !('kiryoku' in o) || typeof o.kiryoku !== 'number' || o.kiryoku > 0).length
  if (elems(cost.icons, cost.other) > 0 && elems(icons, other) === 0) {
    const reduced = (Object.keys(counts) as CostIcon[]).find((ic) => (counts[ic] ?? 0) < cost.icons.filter((x) => x === ic).length)
    if (reduced) icons.push(reduced)
    else if (other) {
      const k = other.findIndex((o) => 'kiryoku' in o && typeof o.kiryoku === 'number')
      if (k >= 0) other[k] = { ...(other[k] as object), kiryoku: 1 } as (typeof other)[number]
    }
  }
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
    // 性別の装備対象（《衣装・純白のドレス》は女性キャラのみ。「両方」は装備できる FAQ:2622・NH-24。R4c G2b-2a）。性別無し・別の性別は断る
    if (eq.sex) { const sx = sexOf(ctx, state, hostIid); if (sx !== eq.sex && sx !== '両方') return `${eq.sex}キャラしか装備できない` }
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
  const want = new Map<string, { iid: string; index: number; ei: number; host: string | null; effect: Continuous; label: string; costume?: boolean }>()
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
        want.set(`${c.iid}#${index}#${ei}`, { iid: c.iid, index, ei, host: c.attachedTo, effect, label: ab.name ?? def.name, costume: ab.effects.some((x) => x.ce === 'setSex' && x.costume) })
      })
    })
  }
  // 模写でコピーした常時効果（ce copiedAbility）: コピーした時点から、コピーしたキャラの常時効果として働く（13-2・FAQ:2662）。exemptLimit は印刷の記述だけを見る＝コピーしても何も起きない（FAQ:2172）
  for (const l of list) {
    const f = bodyOf(l).effect
    if (l.ability !== null || !f || f.ce !== 'copiedAbility') continue
    const mei = l.targets[0]
    const ab = abilityAt(ctx, f.cardId, f.index)
    if (!mei || !isCharOnField(state.cards[mei]) || !ab || ab.kind !== 'static') continue
    ab.effects.forEach((effect, ei) => {
      if (effect.ce === 'manual' || effect.ce === 'exemptLimit') return
      want.set(`${mei}#${COPY_BASE + f.index}#${ei}`, { iid: mei, index: COPY_BASE + f.index, ei, host: null, effect, label: ab.name ?? '模写' })
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
    add.push({ source: w.iid, ability: w.index, by: controllerOf(state, w.iid) ?? state.cards[w.iid].owner, label: w.label, kind: w.effect.ce === 'statMod' ? w.effect.kind : null, until: 'whileSource', targets: [], host: w.host, body: { effect: w.effect, ei: w.ei, origin: 'static', ...(w.costume && w.host ? { sx0: sexOf(ctx, state, w.host, { excludeCostume: true }) } : {}) } })
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
  const barNow = { challenge: [] as string[], any: [] as string[], receiveRested: [] as string[] }
  for (const e of d.effs) {
    if (e.effect.ce !== 'barFromBattle') continue
    for (const x of targetsOf(ctx, state, e)) if (isCharOnField(state.cards[x]) && !barNow[e.effect.role].includes(x)) barNow[e.effect.role].push(x)
  }
  // 守る者（receiveWhenRested）: 消耗状態でも受けるキャラの候補に足すキャラ
  for (const e of d.effs) {
    if (e.effect.ce !== 'receiveWhenRested') continue
    for (const x of targetsOf(ctx, state, e)) if (isCharOnField(state.cards[x]) && !barNow.receiveRested.includes(x)) barNow.receiveRested.push(x)
  }
  // 《衣装・バニースーツ》receiverPriority: 挑むキャラ → 受けることのできる相手側の指定の性別のキャラ（今の性別。「両方」を含む。リーダーを含む）。core の 20-4[11] の候補を絞る（R4c G6a-3・FAQ:187）
  const receivePrefer: Record<string, string[]> = {}
  for (const e of d.effs) {
    if (e.effect.ce !== 'receiverPriority') continue
    const want = e.effect.sex
    for (const x of targetsOf(ctx, state, e)) {
      if (!isCharOnField(state.cards[x])) continue
      const seat = controllerOf(state, x) ?? state.cards[x].owner
      const ys = Object.values(state.cards).filter((y) => isCharOnField(y) && (controllerOf(state, y.iid) ?? y.owner) !== seat && [want, '両方'].includes(sexOf(ctx, state, y.iid))).map((y) => y.iid)
      receivePrefer[x] = [...new Set([...(receivePrefer[x] ?? []), ...ys])].sort()
    }
  }
  const noEntryReady: string[] = []
  for (const e of d.effs) {
    if (e.effect.ce !== 'noEntryReady') continue
    for (const x of targetsOf(ctx, state, e)) if (isCharOnField(state.cards[x]) && !noEntryReady.includes(x)) noEntryReady.push(x)
  }
  noEntryReady.sort()
  // 挑むときの[W]（challengeCost）: 効果ごと・対象ごとに icons の数を足す（ロゥは1効果＝タイプをいくつ持っても1つ）。core が候補の絞りと支払いに使う
  const ccMap: Record<string, number> = {}
  for (const e of d.effs) {
    if (e.effect.ce !== 'challengeCost') continue
    for (const x of targetsOf(ctx, state, e)) if (isCharOnField(state.cards[x])) ccMap[x] = (ccMap[x] ?? 0) + e.effect.icons.length
  }
  const challengeCost: Record<string, number> = Object.fromEntries(Object.entries(ccMap).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
  barNow.receiveRested.sort()
  barNow.challenge.sort()
  barNow.any.sort()
  const barChanged = JSON.stringify(receivePrefer) !== JSON.stringify(state.layers.receivePrefer ?? {}) || JSON.stringify(challengeCost) !== JSON.stringify(state.layers.challengeCost ?? {}) || noEntryReady.join(',') !== [...state.layers.noEntryReady].sort().join(',') || barNow.challenge.join(',') !== [...state.layers.barChallenge].sort().join(',') || barNow.any.join(',') !== [...state.layers.barAny].sort().join(',') || barNow.receiveRested.join(',') !== [...state.layers.receiveRested].sort().join(',')
  const reuseNow = { reusable: [] as string[], oncePerChar: [] as string[] }
  for (const c of Object.values(state.cards)) {
    const bd = c.zone === 'battle' ? ctx.defs[c.cardId]?.battle : undefined
    if (bd?.reusable) reuseNow.reusable.push(c.iid)
    if (bd?.oncePerCharPerTurn) reuseNow.oncePerChar.push(c.iid)
  }
  const reuseChanged = reuseNow.reusable.join(',') !== state.layers.reusable.join(',') || reuseNow.oncePerChar.join(',') !== state.layers.oncePerChar.join(',')
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
  // 効かなくなっていた層が再び効き始めたら、その層の seq を今の一番後ろに取り直す（NH-37⑯・FAQ:2199）
  const prevHeld = state.layers.held ?? []
  const alive = new Set(list.filter((l) => !remove.includes(l.id)).map((l) => l.id))
  const heldNow = [...d.held].filter((id) => alive.has(id)).sort()
  const heldChanged = heldNow.join(',') !== [...prevHeld].sort().join(',')
  const regainedLayers = list.filter((l) => alive.has(l.id) && prevHeld.includes(l.id) && !d.held.has(l.id)).sort((p, q) => p.seq - q.seq)
  // 《忘れ物》の効果が戻ったとき、衣装は最後に装備した1枚を残してゴミ箱送り（FAQ:1642）
  const costumeTrash: string[] = []
  for (const h of new Set(regainedLayers.filter((l) => l.host && ctx.cards[state.cards[l.source ?? '']?.cardId ?? '']?.kind === 'i').map((l) => l.host!))) {
    const cs = Object.values(state.cards).filter((x) => x.attachedTo === h && ctx.defs[x.cardId]?.abilities.some((a) => a.kind === 'conditional' && a.name === '衣装の置き換え'))
    if (cs.length < 2) continue
    const at = (iid: string) => Math.min(Infinity, ...list.filter((l) => l.source === iid && l.ability !== null).map((l) => l.seq))
    cs.sort((p, q) => at(p.iid) - at(q.iid))
    costumeTrash.push(...cs.slice(0, -1).map((x) => x.iid))
  }
  // ── 二重人格（R4c G6b-3・NH-37）: copyOf の層が効いている間 cardId＝上のカード。層が無くなれば元に戻し、上のカードはゴミ箱へ
  const ps = personaSync(ctx, state, list.filter((l) => !remove.includes(l.id)))
  for (const id of ps.dropLayers) if (!remove.includes(id)) remove.push(id)
  const acts: BoardAction[] = []
  const hasBound = Object.keys(bound).length > 0
  if (heldChanged || regainedLayers.length || add.length || remove.length || update.length || hasBound || unusableChanged || reuseChanged || barChanged || clamp.length || orient.length) {
    acts.push({
      type: 'procLayers',
      ...(add.length ? { add } : {}),
      ...(remove.length ? { remove } : {}),
      ...(update.length ? { update } : {}),
      ...(hasBound ? { bound } : {}),
      ...(unusableChanged ? { unusable: unusableList } : {}),
      ...(reuseChanged ? { reuse: reuseNow } : {}),
      ...(barChanged ? { bar: { ...barNow, noEntryReady, challengeCost, receivePrefer } } : {}),
      ...(clamp.length ? { clamp } : {}),
      ...(orient.length ? { orient } : {}),
      ...(heldChanged ? { held: heldNow } : {}),
      ...(regainedLayers.length ? { reseq: regainedLayers.map((l) => l.id) } : {}),
    })
  }
  acts.push(...ps.acts)
  if (costumeTrash.length) acts.push({ type: 'procLimitTrash', iids: costumeTrash, reason: '効果が戻った衣装は最後に装備した1枚だけ残る（FAQ:1642）' })
  // whenLost の Op は、どの宣言にも属さない効果として積む（その場で処理する）
  for (const x of lostOps) acts.push(lostEffect(x.ops, x.env, x.label, x.by))
  return acts
}

/**
 * 二重人格（copyOf の層）の同期。キャラの実体（iid）はそのまま、cardId を上のカードに差し替える（FAQ:731・1554）。
 *  - 同じキャラに複数の層があれば、一番新しい層の上のカードが有効（後の方が上）。新しい方が先に失われたら前のコピーに戻る
 *  - cardId が変わったら、そのキャラの常時の能力の層（ability !== null・source が iid）は全部外して作り直す（NH-37⑫・FAQ:2649）。使って発揮した効果（ability === null）は残す（FAQ:1551）
 *  - 気力＝新しい上限−ダメージ（ダメージ＝古い上限−気力）。0以下ならダウン（core の changeKiryoku）
 *  - 場の外に出たキャラは元の cardId に戻す。層が無い・キャラが場にいない上のカードはゴミ箱へ（エクストリームで途中で失われたとき NH-37⑥・ターン終了時）
 */
function personaSync(ctx: EngineCtx, state: BoardState, layers: Layer[]): { acts: BoardAction[]; dropLayers: string[] } {
  const acts: BoardAction[] = []
  const dropLayers: string[] = []
  const wantTop = new Map<string, { top: string; cardId: string }>()
  const keep = new Set<string>()
  const cos = layers.filter((l) => l.ability === null && bodyOf(l).effect?.ce === 'copyOf').sort((p, q) => q.seq - p.seq)
  for (const l of cos) {
    const f = bodyOf(l).effect as Extract<Continuous, { ce: 'copyOf' }>
    const who = l.targets[0]
    const top = resolveRef(state, layerEnv(state, l), f.top)[0]
    const w = who ? state.cards[who] : undefined
    const t = top ? state.cards[top] : undefined
    if (!who || !w || !isCharOnField(w) || !t || t.zone !== 'aside' || t.personaOf !== who) continue
    keep.add(top)
    if (!wantTop.has(who)) wantTop.set(who, { top, cardId: t.cardId })
  }
  for (const c of Object.values(state.cards)) {
    if (!c.baseCardId && !wantTop.has(c.iid)) continue
    const target = wantTop.get(c.iid)?.cardId ?? c.baseCardId ?? c.cardId
    if (c.cardId === target) continue
    let kiryoku: number | null = null
    if (isCharOnField(c) && c.kiryoku !== null) {
      const oldMax = maxKiryokuOf(ctx, state, c.iid)
      const newMax = maxKiryokuOf(ctx, { ...state, cards: { ...state.cards, [c.iid]: { ...c, cardId: target } } }, c.iid)
      if (oldMax !== null && newMax !== null) kiryoku = newMax - (oldMax - c.kiryoku)
    }
    acts.push({ type: 'procPersona', iid: c.iid, cardId: target, kiryoku })
    for (const l of layers) if (l.ability !== null && l.source === c.iid) dropLayers.push(l.id)
  }
  for (const c of Object.values(state.cards)) if (c.personaOf && !keep.has(c.iid)) acts.push({ type: 'procPersonaCard', iid: c.iid, on: null })
  return { acts, dropLayers }
}

function rank(c: CardInstance): number {
  if (c.attachedTo) return 2
  return c.zone === 'leader' ? 0 : c.zone === 'char' ? 1 : 3
}

/** 特殊能力を失っているキャラ（《能力禁止》が効いているバトルの参加キャラ＝層の loseAbilities の対象） */
function abilityLostChars(ctx: EngineCtx, state: BoardState): Set<string> {
  return new Set(derived(ctx, state).srcA.keys())
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

export function exempt(ctx: EngineCtx, state: BoardState, iid: string, limit: 'charCount' | 'sameName' | 'component'): boolean {
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
  // 装備しているアイテムが与える例外（《狸の置物》「同名キャラ・構成要素キャラの制限に含まれない」FAQ:531・525。対象は装備先のキャラ。R4c G6a-3）
  for (const it of Object.values(state.cards)) {
    if (it.attachedTo !== iid || !staticSourceActive(state, it.iid) || equipProblem(ctx, state, it, iid) || derived(ctx, state).itemsLost.has(iid)) continue
    for (const ab of ctx.defs[it.cardId]?.abilities ?? []) {
      if (ab.kind !== 'static') continue
      for (const f of ab.effects) {
        if (f.ce !== 'exemptLimit' || f.limit !== limit) continue
        const env: Env = { self: it.iid, you: controllerOf(state, iid) ?? c!.owner, slots: {}, trigger: null, declId: null, declared: {}, host: iid }
        const xs = 'zone' in f.who ? select(ctx, state, env, f.who) : resolveRef(state, env, f.who)
        if (xs.includes(iid)) return true
      }
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
  return state.layers.list.filter((l) => l.ability === null && l.kind === kind && l.targets.includes(iid) && !bodyOf(l).mod?.immune).map((l) => l.id) // 「影響を受けない」印つきの set は消えない（スーパー御堂×看護 FAQ:2498）
}

/** 《レベルアップ／ダウン》の答えの鍵: アイテム×そのときの属性の組（属性が変わるたびに指定し直す FAQ:176） */
const levelKey = (itemIid: string, attrs: Attr[]) => `lvl:${itemIid}:${ATTRS.filter((a) => attrs.includes(a)).join('')}`

/** statByAttr が修正する能力値（今の属性が1つならそれ・複数なら指定済みの1つ・指定前と属性なしは null） */
function levelStatAttr(ctx: EngineCtx, state: BoardState, e: Eff, iid: string): Attr | null {
  const attrs = attrsNow(ctx, state, iid)
  if (attrs.length === 0) return null
  if (attrs.length === 1) return attrs[0]
  const itemIid = e.layer.source
  const pick = itemIid ? state.procMeta.answers[levelKey(itemIid, attrs)]?.[0] : undefined
  return pick && attrs.includes(pick as Attr) ? (pick as Attr) : null
}

/**
 * 《レベルアップ／ダウン》の指定（FAQ:173・176）: 今の属性が複数あって、その組への指定がまだなら、装備させたプレイヤーに1つ指定させる。
 * 属性が変わるたびに（組が変わるたびに）指定し直す。答えは procMeta.answers['lvl:<アイテムiid>:<属性の組>']（同じ組に戻ったときは前の指定のまま）
 */
export function levelChoiceFix(ctx: EngineCtx, state: BoardState): BoardAction | null {
  if (state.result || state.procMeta.choice) return null
  for (const e of derived(ctx, state).effs) {
    if (e.effect.ce !== 'statByAttr') continue
    const itemIid = e.layer.source
    if (!itemIid) continue
    for (const iid of targetsOf(ctx, state, e)) {
      if (!effectOn(ctx, state, e, iid)) continue
      const attrs = attrsNow(ctx, state, iid)
      if (attrs.length <= 1) continue
      const key = levelKey(itemIid, attrs)
      if (state.procMeta.answers[key]) continue
      // 「装備させたプレイヤー」＝アイテムの持ち主（手札から装備させた人）。層の you は装備先の使用者（controllerOf）なので、相手のキャラに付けたレベルダウンで相手が選んでいた（統括30・text-i_レベルダウン-3）
      const chooser = state.cards[itemIid]?.owner ?? resolvePlayer(state, layerEnv(state, e.layer), 'you')
      return {
        type: 'procChoice',
        choice: { id: key, by: chooser, kind: 'select', prompt: `「${e.layer.label}」: キャラの属性から能力値を1つ指定する（FAQ:173・属性が変わったらその時点で指定し直す FAQ:176）`, options: attrs.map((a) => ({ key: a, label: a })), min: 1, max: 1, frameId: null },
      }
    }
  }
  return null
}


