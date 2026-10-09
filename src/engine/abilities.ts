/*
 * カードの記述から能力を探す・《〜とき》に合うかを確かめる — DESIGN §5.4 K1（engine 側）
 */

import type { BoardState } from '../core/board'
import { stepNames, activeSeat, findFrame, type ProcFrame } from '../core/proc'
import type { Seat } from '../core/board'
import type { Ability, Trigger } from './dsl'
import { controllerOf, isCharOnField, type EngineCtx, type Env } from './ctx'
import { evalCond, resolveRef } from './eval'
import { abilitiesLost, copiedAbilities, grantedAbilities, itemEffectsLostFor } from './layers'

export type Activated = Extract<Ability, { kind: 'activated' }>
export type Play = Extract<Ability, { kind: 'play' }>
export type Conditional = Extract<Ability, { kind: 'conditional' }>

/** 得た能力（ce grantAbility。《釘バット》NH-31⑤）の番号の始まり。index = GRANT_BASE + 静的能力の番号*100 + その中の効果の番号。cardId は「得させるカード」（アイテム）の id */
export const GRANT_BASE = 1000
/** コピーした能力（模写。ce copiedAbility）の番号の始まり。index = COPY_BASE + コピー元の能力の番号（常時・誘発のコピーの層・誘発の再確認に使う。起動型は元の cardId・番号のまま宣言する） */
export const COPY_BASE = 5000

/** カード id と番号から能力を引く（得た能力の番号も引ける） */
export function abilityAt(ctx: EngineCtx, cardId: string, idx: number): Ability | undefined {
  const def = ctx.defs[cardId]
  if (!def) return undefined
  if (idx < GRANT_BASE) return def.abilities[idx]
  const a = def.abilities[Math.floor((idx - GRANT_BASE) / 100)]
  const f = a?.kind === 'static' ? a.effects[(idx - GRANT_BASE) % 100] : undefined
  return f?.ce === 'grantAbility' ? f.ability : undefined
}

/** そのカードの記述が「得させる」能力の一覧（番号つき） */
export function grantedOfDef(ctx: EngineCtx, cardId: string): { ab: Activated; index: number }[] {
  const out: { ab: Activated; index: number }[] = []
  ctx.defs[cardId]?.abilities.forEach((a, ai) => {
    if (a.kind === 'static') a.effects.forEach((f, ei) => { if (f.ce === 'grantAbility') out.push({ ab: f.ability, index: GRANT_BASE + ai * 100 + ei }) })
  })
  return out
}

/** キャラの特殊能力を名前で探す: そのキャラ自身の記述 → 今そのキャラが得ている能力（装備している間だけ）。cardId は能力の記述があるカード */
export function findAbilityOn(ctx: EngineCtx, state: BoardState, card: { iid: string; cardId: string }, name: string | null | undefined, option?: string): { ab: Ability; index: number; cardId: string } | null {
  const own = findAbility(ctx, card.cardId, name, option)
  if (own) return { ...own, cardId: card.cardId }
  if (name) {
    const g = grantedAbilities(ctx, state, card.iid).find((x) => x.ab.name === name)
    if (g) return { ab: g.ab, index: g.index, cardId: g.cardId }
  }
  return null
}

/** 能力（または本体のプレイ）を名前で探す。play は name（選択肢）で、無ければ最初のもの */
export function findAbility(ctx: EngineCtx, cardId: string, name: string | null | undefined, option?: string): { ab: Ability; index: number } | null {
  const def = ctx.defs[cardId]
  if (!def) return null
  const list = def.abilities.map((ab, index) => ({ ab, index }))
  if (name) return list.find(({ ab }) => (ab.kind === 'activated' || ab.kind === 'manual' || ab.kind === 'conditional' || ab.kind === 'static') && ab.name === name) ?? grantedOfDef(ctx, cardId).find((g) => g.ab.name === name) ?? null
  const plays = list.filter(({ ab }) => ab.kind === 'play')
  if (option) return plays.find(({ ab }) => (ab as Play).name === option) ?? null
  return plays[0] ?? list.find(({ ab }) => ab.kind === 'manual') ?? null
}

/** そのフレームの今の段で、この《〜とき》が来ているか（行為者・当事者・条件も見る） */
export function triggerMatches(ctx: EngineCtx, state: BoardState, env: Env, trig: Trigger, frame: ProcFrame): boolean {
  const names = stepNames(frame)
  if (!names.includes(trig.timing) && !trig.alsoTimings?.some((t) => names.includes(t))) return false
  const e: Env = { ...env, trigger: frame.id }
  if (trig.actor && trig.actor !== 'any') {
    // summon（D17・R4a-2）は decl を持たない軽い手順なので、行為者は frame.by（呼び出す側）で見る
    const actor = frame.decl?.by ?? frame.damage?.dealerSeat ?? (frame.kind === 'summon' ? frame.by : null) ?? null
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

/** 常時効果の発生元がフィールドにあるか（12-2）: キャラ・付いているアイテム・フィールドカード・バトルカード（19-1。
 *  R4b で足した: 鬼ごっこ系「バトル種目としてこのバトルを選択したとき」等はバトルカードの conditional。「自分が選ばれた
 *  種目のときだけ」はカード側の trigger.when（{same:[self,{ref:'battle',role:'battleCard'}]}）で絞る） */
export function sourceActive(state: BoardState, iid: string): boolean {
  const c = state.cards[iid]
  if (!c) return false
  if (c.zone === 'field' || c.zone === 'battle') return true
  // 20-9・12-2: そのバトルの種目として使われているバトルカードは、使用済みでゴミ箱に送られていても発生源（《ナイトライター》の [28]。R4b-3b-1）
  if (c.zone === 'trash' && state.proc.some((f) => f.kind === 'battle' && f.status !== 'done' && f.battle?.battleCard === iid)) return true
  // 付いているアイテム: キャラに・バトルカードに（《能力禁止》R3）
  if (c.attachedTo) {
    const h = state.cards[c.attachedTo]
    return h?.zone === 'battle' || isCharOnField(h)
  }
  return isCharOnField(c)
}

/** キャラの特殊能力が今あるか（【特殊能力を失う】の層 R3）。アイテム・フィールドの効果は特殊能力でない */
function abilitiesOn(ctx: EngineCtx, state: BoardState, iid: string): boolean {
  const c = state.cards[iid]
  if (c?.attachedTo) return !itemEffectsLostFor(ctx, state, iid)
  return !c || !isCharOnField(c) || !abilitiesLost(ctx, state, iid)
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
    if (!def || !abilitiesOn(ctx, state, c.iid)) continue
    ;[...def.abilities.map((ab, index) => ({ ab, index })), ...copiedAbilities(ctx, state, c.iid).map((k) => ({ ab: k.ab as Ability, index: COPY_BASE + k.index }))].forEach(({ ab, index }) => {
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
  if (!frame || !c || !sourceActive(state, iid) || !abilitiesOn(ctx, state, iid)) return false
  if (frame.kind === 'down' && frame.down?.canceled) return false
  const ab = index >= COPY_BASE ? copiedAbilities(ctx, state, iid).find((k) => COPY_BASE + k.index === index)?.ab : ctx.defs[c.cardId]?.abilities[index]
  if (!ab || ab.kind !== 'conditional') return false
  const you = seat ?? controllerOf(state, iid) ?? c.owner
  return triggerMatches(ctx, state, { self: iid, you, slots: {}, trigger: triggerId, declId: null, declared: {} }, ab.trigger, frame)
}
