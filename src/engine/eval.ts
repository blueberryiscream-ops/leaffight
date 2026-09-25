/*
 * DSL の参照・選び方・条件・式を、盤面と環境（Env）から評価する — dsl.ts §1〜§2
 * 参照は「評価した時点」で解決する（dsl.ts §1 の注意）。
 */

import type { BoardState, CardInstance, Seat } from '../core/board'
import { activeSeat, findFrame } from '../core/proc'
import type { CardRef, Cond, Expr, PlayerRef, Selector } from './dsl'
import { controllerOf, isCharOnField, other, type EngineCtx, type Env } from './ctx'

export function resolvePlayer(state: BoardState, env: Env, p: PlayerRef): Seat {
  if (typeof p === 'string') {
    switch (p) {
      case 'you':
        return env.you
      case 'opponent':
        return other(env.you)
      case 'active':
        return activeSeat(state)
      case 'nonActive':
        return other(activeSeat(state))
      default:
        return env.you // バトルの役（R2b）
    }
  }
  if ('controllerOf' in p) return controllerOf(state, resolveRef(state, env, p.controllerOf)[0] ?? '') ?? env.you
  return state.cards[resolveRef(state, env, p.ownerOf)[0] ?? '']?.owner ?? env.you
}

/** 参照 → カードの iid の列（該当なしは空） */
export function resolveRef(state: BoardState, env: Env, r: CardRef): string[] {
  switch (r.ref) {
    case 'self':
      return env.self ? [env.self] : []
    case 'it':
      return env.it ? [env.it] : []
    case 'slot':
      return (env.slots[r.slot] ?? []).filter((x) => x in state.cards)
    case 'equipped': {
      const host = env.self ? state.cards[env.self]?.attachedTo : null
      return host ? [host] : []
    }
    case 'event': {
      const f = env.trigger ? findFrame(state, env.trigger) : undefined
      if (!f) return []
      switch (r.role) {
        case 'damageRecipient':
          return f.damage ? [f.damage.recipient] : []
        case 'damageDealer':
          return f.damage?.dealerIid ? [f.damage.dealerIid] : []
        case 'downedChar':
          return f.down ? [f.down.iid] : []
        case 'declaredAction':
          return f.decl?.sourceIid ? [f.decl.sourceIid] : []
        default:
          return []
      }
    }
    case 'named':
      // 名前で指す参照は R2a の記述では使わない（名前の照合は nameIs 条件）。K7（コピー）と一緒に作る
      return []
    default:
      return []
  }
}

function zoneCards(state: BoardState, sel: Selector, seats: Seat[]): CardInstance[] {
  const all = Object.values(state.cards)
  const inSeat = (c: CardInstance) => seats.includes(controllerOf(state, c.iid) ?? c.owner)
  const byIndex = (a: CardInstance, b: CardInstance) => (a.zone === b.zone ? a.index - b.index : a.zone === 'leader' ? -1 : 1)
  switch (sel.zone) {
    case 'field':
      // キャラ（リーダー→キャラの並び）＋付いているアイテム
      return all.filter((c) => (c.attachedTo === null ? isCharOnField(c) : isCharOnField(state.cards[c.attachedTo])) && inSeat(c)).sort(byIndex)
    case 'fieldCard':
      return all.filter((c) => c.zone === 'field')
    case 'battleCards':
      return all.filter((c) => c.zone === 'battle' && seats.includes(c.owner)).sort(byIndex)
    default:
      return all.filter((c) => c.zone === sel.zone && seats.includes(c.owner) && c.attachedTo === null).sort(byIndex)
  }
}

/** 選び方 → 該当するカードの iid の列（場の並び: リーダー→キャラ） */
export function select(ctx: EngineCtx, state: BoardState, env: Env, sel: Selector): string[] {
  const seats: Seat[] = sel.side === 'both' ? ['A', 'B'] : [resolvePlayer(state, env, sel.side)]
  const excl = new Set((sel.exclude ?? []).flatMap((r) => resolveRef(state, env, r)))
  return zoneCards(state, sel, seats)
    .filter((c) => {
      const info = ctx.cards[c.cardId]
      if (!info) return false
      if (sel.class) {
        if (c.attachedTo !== null) return false
        if (sel.class === 'キャラ' && info.kind !== 'c' && info.kind !== 't') return false
        if (sel.class === 'キャラクター' && info.kind !== 'c') return false
        if (sel.class === 'タッグキャラクター' && info.kind !== 't') return false
      }
      if (sel.kind && !sel.kind.includes(info.kind)) return false
      if (sel.excludeLeader && c.zone === 'leader') return false
      if (excl.has(c.iid)) return false
      if (sel.where && !evalCond(ctx, state, { ...env, it: c.iid }, sel.where)) return false
      return true
    })
    .map((c) => c.iid)
}

export function evalCond(ctx: EngineCtx, state: BoardState, env: Env, c: Cond): boolean {
  if ('all' in c) return c.all.every((x) => evalCond(ctx, state, env, x))
  if ('any' in c) return c.any.some((x) => evalCond(ctx, state, env, x))
  if ('not' in c) return !evalCond(ctx, state, env, c.not)
  if ('ready' in c) {
    const xs = resolveRef(state, env, c.ready)
    return xs.length > 0 && xs.every((x) => state.cards[x]?.orientation === 'ready')
  }
  if ('same' in c) {
    const a = resolveRef(state, env, c.same[0])
    const b = resolveRef(state, env, c.same[1])
    return a.length === 1 && b.length === 1 && a[0] === b[0]
  }
  if ('friendly' in c) {
    const a = resolveRef(state, env, c.friendly[0])[0]
    const b = resolveRef(state, env, c.friendly[1])[0]
    return !!a && !!b && controllerOf(state, a) === controllerOf(state, b)
  }
  if ('isLeader' in c) {
    const xs = resolveRef(state, env, c.isLeader)
    return xs.length > 0 && xs.every((x) => state.cards[x]?.zone === 'leader')
  }
  if ('cmp' in c) {
    const a = evalExpr(ctx, state, env, c.cmp[0])
    const b = evalExpr(ctx, state, env, c.cmp[2])
    switch (c.cmp[1]) {
      case '<':
        return a < b
      case '<=':
        return a <= b
      case '==':
        return a === b
      case '>=':
        return a >= b
      case '>':
        return a > b
    }
  }
  if ('exists' in c) return select(ctx, state, env, c.exists).length > 0
  if ('nameIs' in c) {
    const xs = resolveRef(state, env, c.nameIs[0])
    return xs.length > 0 && xs.every((x) => ctx.cards[state.cards[x]?.cardId ?? '']?.name === c.nameIs[1])
  }
  if ('targets' in c) {
    const f = env.trigger ? findFrame(state, env.trigger) : undefined
    const xs = resolveRef(state, env, c.targets)
    return !!f?.decl && xs.length > 0 && xs.every((x) => f.decl!.targets.includes(x))
  }
  // バトルの条件（inBattle・battleAt・isParticipant）と pureAttrs は R2b 以降。R2a ではバトル中でない
  return false
}

export function evalExpr(ctx: EngineCtx, state: BoardState, env: Env, e: Expr): number {
  if (typeof e === 'number') return e
  if ('kiryoku' in e) return state.cards[resolveRef(state, env, e.kiryoku)[0] ?? '']?.kiryoku ?? 0
  if ('count' in e) return select(ctx, state, env, e.count).length
  if ('eventAmount' in e) {
    const f = env.trigger ? findFrame(state, env.trigger) : undefined
    return f?.damage?.value ?? 0
  }
  if ('add' in e) return e.add.reduce((s: number, x) => s + evalExpr(ctx, state, env, x), 0)
  if ('sub' in e) return evalExpr(ctx, state, env, e.sub[0]) - evalExpr(ctx, state, env, e.sub[1])
  if ('callCost' in e) {
    const c = state.cards[resolveRef(state, env, e.callCost)[0] ?? '']
    return c ? [...(ctx.cards[c.cardId]?.cost ?? '')].filter((ch) => 'WRGLT'.includes(ch)).length : 0
  }
  if ('stat' in e) {
    // 能力値（R2a は印刷値だけ。修正の層は R3 の K3）
    const c = state.cards[resolveRef(state, env, e.of)[0] ?? '']
    const stat = typeof e.stat === 'string' ? e.stat : env.slots[e.stat.slot]?.[0]
    if (!c || !stat) return 0
    return ctx.cards[c.cardId]?.stats?.[stat] ?? 0
  }
  return 0
}
