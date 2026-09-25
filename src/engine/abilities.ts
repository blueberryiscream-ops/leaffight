/*
 * カードの記述から能力を探す・《〜とき》に合うかを確かめる — DESIGN §5.4 K1（engine 側）
 */

import type { BoardState } from '../core/board'
import { STEP_TIMINGS, activeSeat, findFrame, type ProcFrame } from '../core/proc'
import type { Seat } from '../core/board'
import type { Ability, Trigger } from './dsl'
import { controllerOf, isCharOnField, type EngineCtx, type Env } from './ctx'
import { evalCond, resolveRef } from './eval'

export type Activated = Extract<Ability, { kind: 'activated' }>
export type Play = Extract<Ability, { kind: 'play' }>
export type Conditional = Extract<Ability, { kind: 'conditional' }>

/** 能力（または本体のプレイ）を名前で探す。play は name（選択肢）で、無ければ最初のもの */
export function findAbility(ctx: EngineCtx, cardId: string, name: string | null | undefined, option?: string): { ab: Ability; index: number } | null {
  const def = ctx.defs[cardId]
  if (!def) return null
  const list = def.abilities.map((ab, index) => ({ ab, index }))
  if (name) return list.find(({ ab }) => (ab.kind === 'activated' || ab.kind === 'manual' || ab.kind === 'conditional' || ab.kind === 'static') && ab.name === name) ?? null
  const plays = list.filter(({ ab }) => ab.kind === 'play')
  if (option) return plays.find(({ ab }) => (ab as Play).name === option) ?? null
  return plays[0] ?? list.find(({ ab }) => ab.kind === 'manual') ?? null
}

/** そのフレームの今の段で、この《〜とき》が来ているか（行為者・当事者・条件も見る） */
export function triggerMatches(ctx: EngineCtx, state: BoardState, env: Env, trig: Trigger, frame: ProcFrame): boolean {
  const names = STEP_TIMINGS[frame.kind][frame.step]?.names ?? []
  if (!names.includes(trig.timing)) return false
  const e: Env = { ...env, trigger: frame.id }
  if (trig.actor && trig.actor !== 'any') {
    const actor = frame.decl?.by ?? frame.damage?.dealerSeat ?? null
    if (actor === null) return false
    if (trig.actor === 'opponent' ? actor === env.you : actor !== env.you) return false
  }
  if (trig.subject) {
    const subj = resolveRef(state, e, { ref: 'event', role: trig.subject.role })
    if (subj.length === 0) return false
    if (!subj.every((it) => evalCond(ctx, state, { ...e, it }, trig.subject!.where))) return false
  }
  if (trig.when && !evalCond(ctx, state, e, trig.when)) return false
  return true
}

/** 常時効果の発生元がフィールドにあるか（12-2）: キャラ・付いているアイテム・フィールドカード */
export function sourceActive(state: BoardState, iid: string): boolean {
  const c = state.cards[iid]
  if (!c) return false
  if (c.zone === 'field') return true
  if (c.attachedTo) return isCharOnField(state.cards[c.attachedTo])
  return isCharOnField(c)
}

export interface CondHit {
  iid: string
  index: number
  ab: Conditional
  env: Env
  key: string
}

/** そのフレームの今の段に来ている、処理条件がある常時効果（12-2-1）。当事者の並び（リーダー→キャラ→付いたアイテム→フィールド） */
export function conditionalHits(ctx: EngineCtx, state: BoardState, frame: ProcFrame): CondHit[] {
  const out: CondHit[] = []
  const cards = Object.values(state.cards)
    .filter((c) => sourceActive(state, c.iid))
    .sort((a, b) => (a.owner === b.owner ? zoneRank(a.zone, a.attachedTo) - zoneRank(b.zone, b.attachedTo) || a.index - b.index : a.owner < b.owner ? -1 : 1))
  for (const c of cards) {
    const def = ctx.defs[c.cardId]
    if (!def) continue
    def.abilities.forEach((ab, index) => {
      if (ab.kind !== 'conditional') return
      // フィールドカードの「お互いの」効果（eachPlayer）は AP→NAP の順にそれぞれのプレイヤーのものとして処理する（18-1・FAQ:4105）
      const ap = activeSeat(state)
      const seats: (Seat | null)[] = ab.eachPlayer ? [ap, ap === 'A' ? 'B' : 'A'] : [null]
      for (const seat of seats) {
        const you = seat ?? controllerOf(state, c.iid) ?? c.owner
        const env: Env = { self: c.iid, you, slots: {}, trigger: frame.id, declId: null, declared: {} }
        if (!triggerMatches(ctx, state, env, ab.trigger, frame)) continue
        out.push({ iid: c.iid, index, ab, env, key: seat ? `${c.iid}#${index}@${seat}` : `${c.iid}#${index}` })
      }
    })
  }
  return out
}

function zoneRank(zone: string, attachedTo: string | null): number {
  if (attachedTo) return 2
  return zone === 'leader' ? 0 : zone === 'char' ? 1 : 3
}

/** K10: 条件を満たさなくなった効果を読み飛ばす。項目の処理を始めるときに《〜とき》をもう一度確かめる */
export function stillMatches(ctx: EngineCtx, state: BoardState, iid: string, index: number, triggerId: string, seat?: Seat): boolean {
  const frame = findFrame(state, triggerId)
  const c = state.cards[iid]
  if (!frame || !c || !sourceActive(state, iid)) return false
  if (frame.kind === 'down' && frame.down?.canceled) return false
  const ab = ctx.defs[c.cardId]?.abilities[index]
  if (!ab || ab.kind !== 'conditional') return false
  const you = seat ?? controllerOf(state, iid) ?? c.owner
  return triggerMatches(ctx, state, { self: iid, you, slots: {}, trigger: triggerId, declId: null, declared: {} }, ab.trigger, frame)
}
