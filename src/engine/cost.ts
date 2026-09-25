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

const ICONS = 'WRGLT'
const ATTRS = '力早賢根感'

/** 使用代償の元表記を読む。読めない部分は unknown に返す（呼び出し側が manual に倒す） */
export function parseCostText(text: string): { cost: Cost; unknown: string[] } {
  const cost: Cost = { icons: [], attrs: [] }
  const other: OtherCost[] = []
  const unknown: string[] = []
  const toNum = (s: string) => Number(s.replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d))))
  for (const raw of text.split(/[＋+]/)) {
    const part = raw.trim()
    if (!part) continue
    if ([...part].every((ch) => ICONS.includes(ch) || ATTRS.includes(ch))) {
      for (const ch of part) {
        if (ICONS.includes(ch)) cost.icons.push(ch as CostIcon)
        else cost.attrs.push(ch as Attr)
      }
      continue
    }
    const m = /^気力[－\-−ー]([0-9０-９]+)$/.exec(part)
    if (m) {
      other.push({ kiryoku: toNum(m[1]) })
      continue
    }
    if (part === 'このキャラをゴミ箱送りにする' || part === 'このアイテムをゴミ箱送りにする') {
      other.push({ trash: { ref: 'self' } })
      continue
    }
    if (part === 'このキャラをダウンさせる') {
      other.push({ down: { ref: 'self' } })
      continue
    }
    unknown.push(part)
  }
  if (other.length) cost.other = other
  return { cost, unknown }
}

/** イベント・アイテムなどカード本体の使用代償（cost＝コストアイコン・attr＝属性アイコン） */
export function cardCost(info: CardInfo): Cost {
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
 * 15-13-1[4]・16-1[4] 支払い方法の宣言。
 * - payWith（発生源の iid）があれば、それでコストを発生させて払う（宣言前に発生させておいたコストは使わない FAQ:2959）
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
): { costGens: CostSource[][]; usePool: boolean; warn: string[] } {
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
  if (payWith) {
    const srcs = payWith.map(toSource).filter((x): x is CostSource => x !== null)
    return { costGens: srcs.length ? [srcs] : [], usePool: false, warn }
  }
  if (cost.icons.length === 0) return { costGens: [], usePool: true, warn }
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
    return { costGens: gens.length ? [gens] : [], usePool: true, warn }
  }
  warn.push('使用代償を払う方法が見つからない（[9] で支払えず中断する）')
  return { costGens: [], usePool: true, warn }
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
  const tokens = state.costs[by]
    .filter((t: CostToken) => usePool || t.frameId === frameId)
    .map((t) => ({ id: t.id, icon: t.frameId === frameId ? t.icon : ('W' as CostIcon), attrs: t.attrs }))
  const fail = (reason: string) => ({ ok: false, reason, consume: [], kiryoku: [], trash: [], down: [] })
  let consume: string[] | null = null
  for (const asg of assignments(cost)) {
    const m = matchTokens(asg.req, tokens)
    if (!m) continue
    // 余った属性アイコン: その属性を持つキャラが自分のフィールドに待機状態でいる
    const readyOk = asg.readyAttrs.every((a) =>
      Object.values(state.cards).some((c) => isCharOnField(c) && c.owner === by && c.orientation === 'ready' && attrsOf(ctx.cards[c.cardId]).includes(a)),
    )
    if (!readyOk) continue
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
      // 8-3-1: 気力を減らすキャラは1以上の気力でなければならない。0未満になってもよい（FAQ:3263）
      const c = self ? state.cards[self] : undefined
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
