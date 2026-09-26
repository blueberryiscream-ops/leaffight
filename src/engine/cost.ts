/*
 * 使用代償（原典 8・8-2-1・8-3・8-3-1 oldrule.txt:272-305）とコストの発生（7-1・7-2 oldrule.txt:208-264）
 *
 * - 使用代償の元表記（E0 で分けた Ability.cost の文字列・カードの cost＋attr）を DSL の Cost に読む（PHASE-R2a §2-3）
 * - 8-2-1 の割り当て（コストアイコン1つに属性アイコン1つ。できる限り割り当てる。余った属性は「その属性のキャラが待機状態でいる」）
 * - 支払いの計画（15-13-1[4]・16-1[4] の支払い方法の宣言）と、[9] の支払い（発生済みのコストとの突き合わせ）
 * R2a は印刷された使用代償だけ（修正 costMod は R3 の K6）。
 */

import type { BoardState, Seat } from '../core/board'
import type { CostSource, CostToken, ProcDecl } from '../core/proc'
import type { Attr, Cost, CostIcon, OtherCost } from './dsl'
import { controllerOf, isCharOnField, type CardInfo, type EngineCtx } from './ctx'
import { ACTION_KIND, applyCostMod, costModOf } from './layers'
import { resolveRef } from './eval'

const ICONS = 'WRGLT'
const ATTRS = '力早賢根感'

/** 使用代償の元表記を読む。読めない部分は unknown に返す（呼び出し側が manual に倒す） */
export function parseCostText(text: string): { cost: Cost; unknown: string[] } {
  const cost: Cost = { icons: [], attrs: [] }
  const other: OtherCost[] = []
  const unknown: string[] = []
  const toNum = (s: string) => Number(s.replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d))))
  // 1つの部分（+ で区切った1区画）を読む。「Ｒ気力－１」のように + の無いアイコン＋その他代償の連結は、
  // 先頭のアイコンだけの並びを剥がして残りを同じ規則で読み直す（R4a・カード名に関係ない一般の表記のゆれ）
  const parsePart = (part: string) => {
    if (!part) return
    if ([...part].every((ch) => ICONS.includes(ch) || ATTRS.includes(ch))) {
      for (const ch of part) {
        if (ICONS.includes(ch)) cost.icons.push(ch as CostIcon)
        else cost.attrs.push(ch as Attr)
      }
      return
    }
    // 「味方キャラ１体の気力－Ｎ」＝払うキャラを宣言時に選ぶ（宣言[3]の選択・slot 't' の約束。R4a）。
    // 末尾の（…）注記（対象の制限など）はカードごとの選択肢の記述（ability.choices の exclude・where）に持たせる。ここでは読み捨てる
    const mv = /^味方キャラ１体の気力[－\-−ー]([0-9０-９]+)(?:（[^）]*）)?$/.exec(part)
    if (mv) {
      other.push({ kiryoku: toNum(mv[1]), of: { ref: 'slot', slot: 't' } })
      return
    }
    const m = /^気力[－\-−ー]([0-9０-９]+)$/.exec(part)
    if (m) {
      other.push({ kiryoku: toNum(m[1]) })
      return
    }
    if (part === 'このキャラをゴミ箱送りにする' || part === 'このアイテムをゴミ箱送りにする') {
      other.push({ trash: { ref: 'self' } })
      return
    }
    if (part === 'このキャラをダウンさせる') {
      other.push({ down: { ref: 'self' } })
      return
    }
    const iconPrefix = /^[WRGLT]+/.exec(part)
    if (iconPrefix && iconPrefix[0].length < part.length) {
      for (const ch of iconPrefix[0]) cost.icons.push(ch as CostIcon)
      parsePart(part.slice(iconPrefix[0].length))
      return
    }
    unknown.push(part)
  }
  for (const raw of text.split(/[＋+]/)) parsePart(raw.trim())
  if (other.length) cost.other = other
  return { cost, unknown }
}

/** イベント・アイテムなどカード本体の使用代償（cost＝コストアイコン・attr＝属性アイコン） */
export function cardCost(info: CardInfo): Cost {
  // キャラ・タッグの attr はそのキャラ自身の属性で、呼び出しの使用代償ではない（DESIGN §4.8「キャラ/タッグ札の「属性」はコストではない」
  // ユーザー校正 2026-07-18）。i/e/f/b の attr はコスト側の属性アイコン（8-2-1）。R2u で直した
  if (info.kind === 'c' || info.kind === 't') return parseCostText(info.cost).cost
  return parseCostText(`${info.cost}${info.attr}`).cost
}

/** キャラの属性（コストが帯びる属性 7-1-2） */
export function attrsOf(info: CardInfo | undefined): Attr[] {
  return [...(info?.attr ?? '')].filter((ch) => ATTRS.includes(ch)) as Attr[]
}

/** 8-2-1: コストアイコンへの属性アイコンの割り当ての候補（できる限り割り当てる。どれを割り当てるかは選べる） */
export function assignments(cost: Cost): { req: { icon: CostIcon; attr: Attr | null }[]; readyAttrs: Attr[] }[] {
  const n = Math.min(cost.icons.length, cost.attrs.length)
  const out: { req: { icon: CostIcon; attr: Attr | null }[]; readyAttrs: Attr[] }[] = []
  const seen = new Set<string>()
  // 属性の並べ方をすべて試す（属性アイコンは多くて3つ）
  const perms = (xs: Attr[]): Attr[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])))
  for (const p of perms(cost.attrs)) {
    const req = cost.icons.map((icon, i) => ({ icon, attr: i < n ? p[i] : null }))
    const readyAttrs = p.slice(n)
    const key = JSON.stringify([req, [...readyAttrs].sort()])
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ req, readyAttrs })
  }
  return out
}

/** そのコスト（トークン）が、必要なコストアイコンとして払えるか（7-1-1 の上位互換 R/L/T→G→W） */
function iconOk(token: CostIcon, need: CostIcon): boolean {
  if (need === 'W') return true
  if (need === 'G') return token !== 'W'
  return token === need
}

/** 必要なコストの並びに、使えるトークンを割り当てる（見つからなければ null） */
export function matchTokens(req: { icon: CostIcon; attr: Attr | null }[], tokens: { id: string; icon: CostIcon; attrs: string[] }[]): string[] | null {
  const strict = (r: { icon: CostIcon; attr: Attr | null }) => (r.icon === 'W' ? 2 : r.icon === 'G' ? 1 : 0) * 2 + (r.attr ? 0 : 1)
  const order = [...req].sort((a, b) => strict(a) - strict(b))
  // 安いトークン（W・無属性）から使う
  const value = (t: { icon: CostIcon; attrs: string[] }) => (t.icon === 'W' ? 0 : t.icon === 'G' ? 1 : 2) * 10 + t.attrs.length
  const pool = [...tokens].sort((a, b) => value(a) - value(b))
  const used = new Set<string>()
  const pick = (i: number): boolean => {
    if (i >= order.length) return true
    const r = order[i]
    for (const t of pool) {
      if (used.has(t.id) || !iconOk(t.icon, r.icon) || (r.attr && !t.attrs.includes(r.attr))) continue
      used.add(t.id)
      if (pick(i + 1)) return true
      used.delete(t.id)
    }
    return false
  }
  return pick(0) ? [...used] : null
}

/** 能力・カードの使用代償（印刷値） */
export function costOfAbility(ctx: EngineCtx, cardId: string, abilityName: string | null): { cost: Cost; unknown: string[] } {
  const info = ctx.cards[cardId]
  if (!info) return { cost: { icons: [], attrs: [] }, unknown: [] }
  if (abilityName === null) return { cost: cardCost(info), unknown: [] }
  const a = info.abilities.find((x) => x.header === abilityName)
  return parseCostText(a?.cost ?? '')
}

/**
 * K6（D3・D4）: 払うとき（15-13-1[9]・16-1[9]・17-3 の同じ段）の状態で、印刷値の使用代償へ costMod をまとめて適用したもの。
 * declareOne の支払い方法の宣言・payNow の支払いの両方が、この一か所を通る（統括「使用代償の構造の算出を一か所に」PHASE §3-7）
 */
export function effectiveCost(ctx: EngineCtx, state: BoardState, actionKind: ProcDecl['kind'], by: Seat, sourceIid: string | null, targets: string[], cost: Cost): Cost {
  const mod = costModOf(ctx, state, ACTION_KIND[actionKind], by, sourceIid, targets, cost)
  return applyCostMod(cost, mod)
}

/**
 * 15-13-1[4]・16-1[4] 支払い方法の宣言。
 * - payWith（発生源の iid）か payPool（使う発生済みのコストの id）があれば、**指定されたものだけ**で払う
 *   （payWith でコストを発生させ、payPool の発生済みのコストと合わせる。指定していない発生済みのコストは使わない FAQ:2959
 *   「宣言時に指定した使用代償の支払い方法以外で支払うことはできません」。R2u で payPool を足した）
 * - 無ければ: 発生済みのコストで払えるものは払い、足りない分はコストを発生させる（R は能力を使うキャラ自身・
 *   L はリーダー・T はタッグ・G/W は待機状態の味方キャラを先頭から）。【決めたこと】自動の支払い方法（HANDOFF-R2a）
 */
export function planPayment(
  ctx: EngineCtx,
  state: BoardState,
  by: Seat,
  sourceIid: string | null,
  cost: Cost,
  payWith: string[] | null,
  payPool: string[] | null = null,
): { ok: boolean; costGens: CostSource[][]; usePool: boolean; poolIds: string[]; warn: string[] } {
  const warn: string[] = []
  const toSource = (iid: string): CostSource | null => {
    const c = state.cards[iid]
    const info = c ? ctx.cards[c.cardId] : undefined
    if (!c || !info) return null
    if (c.zone === 'hand') return { iid, from: 'hand', icon: 'W', attrs: [] } // 7-1-2: 手札からは無属性の W
    if (!isCharOnField(c)) return null
    const icon: CostIcon = iid === sourceIid ? 'R' : c.zone === 'leader' ? 'L' : info.kind === 't' ? 'T' : 'G'
    return { iid, from: 'field', icon, attrs: attrsOf(info) }
  }
  if (payWith?.length || payPool?.length) {
    const srcs = (payWith ?? []).map(toSource).filter((x): x is CostSource => x !== null)
    const have = new Set(state.costs[by].map((t) => t.id))
    const poolIds = (payPool ?? []).filter((id) => have.has(id))
    return { ok: true, costGens: srcs.length ? [srcs] : [], usePool: false, poolIds, warn }
  }
  if (cost.icons.length === 0) return { ok: true, costGens: [], usePool: true, poolIds: [], warn }
  const pool = state.costs[by].map((t) => ({ id: t.id, icon: 'W' as CostIcon, attrs: t.attrs })) // 他のアクションで発生したコストはその他のコスト（7-3）
  for (const asg of assignments(cost)) {
    // 発生済みのコストで払えない分を、コストを発生させて払う（いちばん厳しい要求から）
    const gens: CostSource[] = []
    let remaining = [...asg.req]
    let failed = false
    while (!matchTokens(remaining, pool)) {
      const r = remaining.find((x) => x.icon !== 'W' && x.icon !== 'G') ?? remaining.find((x) => x.attr) ?? remaining[0]
      const cand = candidatesFor(ctx, state, by, sourceIid, r.icon, r.attr, gens)
      if (!cand) {
        failed = true
        break
      }
      gens.push(cand)
      remaining = remaining.filter((x) => x !== r)
    }
    if (failed) continue
    if (gens.some((g) => g.icon !== 'R')) warn.push(`コストを発生させるキャラを自動で選んだ: ${gens.map((g) => g.iid).join('・')}`)
    return { ok: true, costGens: gens.length ? [gens] : [], usePool: true, poolIds: [], warn }
  }
  return { ok: false, costGens: [], usePool: true, poolIds: [], warn }
}

/** 余った属性アイコン（8-2-1）: その属性を持つキャラが自分のフィールドに待機状態でいるか（exclude＝支払いで消耗させるキャラ） */
function readyAttrsOk(ctx: EngineCtx, state: BoardState, by: Seat, attrs: Attr[], exclude: string[] = []): boolean {
  return attrs.every((a) =>
    Object.values(state.cards).some((c) => isCharOnField(c) && c.owner === by && c.orientation === 'ready' && !exclude.includes(c.iid) && attrsOf(ctx.cards[c.cardId]).includes(a)),
  )
}

/**
 * 支払いの指定（payWith＋payPool）で使用代償のコストと属性が足りるか（画面の「宣言」を押せるか。R2u §2-1「足りたら宣言」）。
 * payWith のキャラは消耗する前提で、余った属性の待機状態のキャラから除く。その他の代償（気力－N 等）は [9] で確かめる
 */
export function paymentCovers(ctx: EngineCtx, state: BoardState, by: Seat, sourceIid: string | null, cost: Cost, payWith: string[], payPool: string[]): boolean {
  const plan = planPayment(ctx, state, by, sourceIid, cost, payWith, payPool)
  const tokens = [
    ...plan.costGens.flat().map((s, i) => ({ id: `new${i}`, icon: s.icon, attrs: s.attrs })),
    ...state.costs[by].filter((t) => plan.poolIds.includes(t.id)).map((t) => ({ id: t.id, icon: 'W' as CostIcon, attrs: t.attrs })),
  ]
  const resting = plan.costGens.flat().filter((s) => s.from === 'field').map((s) => s.iid)
  return assignments(cost).some((asg) => matchTokens(asg.req, tokens) !== null && readyAttrsOk(ctx, state, by, asg.readyAttrs, resting))
}

/**
 * 支払いの例外（R2u §2-1）: 発生済みのコストだけで払えて、使う発生済みのコストの組み合わせが1通り（属性の並びで数える）なら
 * その id の列。そうでなければ null（プレイヤーに選ばせる）
 */
export function poolOnlyPayment(ctx: EngineCtx, state: BoardState, by: Seat, cost: Cost): string[] | null {
  const pool = state.costs[by]
  const n = cost.icons.length
  if (n === 0 || pool.length < n || pool.length > 12) return null
  const found = new Map<string, string[]>()
  const pick = (start: number, chosen: CostToken[]) => {
    if (chosen.length === n) {
      const tokens = chosen.map((t) => ({ id: t.id, icon: 'W' as CostIcon, attrs: t.attrs }))
      if (assignments(cost).some((asg) => matchTokens(asg.req, tokens) !== null && readyAttrsOk(ctx, state, by, asg.readyAttrs))) {
        const key = JSON.stringify(chosen.map((t) => [...t.attrs].sort().join('')).sort())
        if (!found.has(key)) found.set(key, chosen.map((t) => t.id))
      }
      return
    }
    for (let i = start; i < pool.length; i++) pick(i + 1, [...chosen, pool[i]])
  }
  pick(0, [])
  return found.size === 1 ? [...found.values()][0] : null
}

function candidatesFor(ctx: EngineCtx, state: BoardState, by: Seat, sourceIid: string | null, icon: CostIcon, attr: Attr | null, taken: CostSource[]): CostSource | null {
  const ok = (iid: string) => {
    const c = state.cards[iid]
    const info = c ? ctx.cards[c.cardId] : undefined
    return !!c && isCharOnField(c) && c.orientation === 'ready' && controllerOf(state, iid) === by && !taken.some((t) => t.iid === iid) && (!attr || attrsOf(info).includes(attr))
  }
  const mk = (iid: string, i: CostIcon): CostSource => ({ iid, from: 'field', icon: i, attrs: attrsOf(ctx.cards[state.cards[iid].cardId]) })
  if (icon === 'R') return sourceIid && ok(sourceIid) ? mk(sourceIid, 'R') : null
  const chars = Object.values(state.cards).filter((c) => isCharOnField(c) && c.owner === by).sort((a, b) => (a.zone === b.zone ? a.index - b.index : a.zone === 'leader' ? -1 : 1))
  if (icon === 'L') {
    const l = chars.find((c) => c.zone === 'leader')
    return l && ok(l.iid) ? mk(l.iid, 'L') : null
  }
  if (icon === 'T') {
    const t = chars.find((c) => ctx.cards[c.cardId]?.kind === 't' && ok(c.iid))
    return t ? mk(t.iid, 'T') : null
  }
  const c = chars.find((x) => x.iid !== sourceIid && ok(x.iid)) ?? chars.find((x) => ok(x.iid))
  return c ? mk(c.iid, c.iid === sourceIid ? 'R' : 'G') : null
}

/**
 * [9] 使用代償の支払い。コスト（発生済みのトークン）＋余った属性（待機状態のキャラ）＋その他（気力－N・ゴミ箱送り・ダウン）。
 * 払えなければ ok=false（[10] で中断）。
 */
export function payNow(
  ctx: EngineCtx,
  state: BoardState,
  frameId: string,
  decl: ProcDecl,
  cost: Cost,
): { ok: boolean; reason?: string; consume: string[]; kiryoku: { iid: string; delta: number }[]; trash: string[]; down: string[] } {
  const by = decl.by
  const usePool = decl.eng.usePool !== false
  // payPool（R2u）: 宣言で指定した発生済みのコストだけを使う
  const poolIds = (decl.eng.poolIds as string[] | undefined) ?? []
  const tokens = state.costs[by]
    .filter((t: CostToken) => usePool || t.frameId === frameId || poolIds.includes(t.id))
    .map((t) => ({ id: t.id, icon: t.frameId === frameId ? t.icon : ('W' as CostIcon), attrs: t.attrs }))
  const fail = (reason: string) => ({ ok: false, reason, consume: [], kiryoku: [], trash: [], down: [] })
  let consume: string[] | null = null
  for (const asg of assignments(cost)) {
    const m = matchTokens(asg.req, tokens)
    if (!m) continue
    // 余った属性アイコン: その属性を持つキャラが自分のフィールドに待機状態でいる
    if (!readyAttrsOk(ctx, state, by, asg.readyAttrs)) continue
    consume = m
    break
  }
  if (consume === null) return fail('コストを支払えない')
  const self = decl.sourceIid
  const kiryoku: { iid: string; delta: number }[] = []
  const trash: string[] = []
  const down: string[] = []
  for (const o of cost.other ?? []) {
    if ('kiryoku' in o) {
      // 8-3-1: 気力を減らすキャラは1以上の気力でなければならない。0未満になってもよい（FAQ:3263）。
      // of（「味方キャラ１体の気力－１」等）＝宣言[3]で選んだ対象（decl.eng.slots。既定は能力を持つキャラ自身 8-3）
      const slots = (decl.eng.slots as Record<string, string[]> | undefined) ?? {}
      const targetIid = o.of ? resolveRef(state, { self, you: by, slots, trigger: null, declId: null, declared: {} }, o.of)[0] : self
      const c = targetIid ? state.cards[targetIid] : undefined
      if (!c || !isCharOnField(c) || (c.kiryoku ?? 0) < 1) return fail('気力が1以上でない（8-3-1）')
      kiryoku.push({ iid: c.iid, delta: -o.kiryoku })
    } else if ('trash' in o) {
      if (!self || !isCharOnField(state.cards[self])) return fail('ゴミ箱送りにするキャラがいない')
      trash.push(self)
    } else if ('down' in o) {
      if (!self || !isCharOnField(state.cards[self])) return fail('ダウンさせるキャラがいない')
      down.push(self)
    } else return fail('読めない使用代償（気力－任意）')
  }
  return { ok: true, consume, kiryoku, trash, down }
}
