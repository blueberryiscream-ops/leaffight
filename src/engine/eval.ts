/*
 * DSL の参照・選び方・条件・式を、盤面と環境（Env）から評価する — dsl.ts §1〜§2
 * 参照は「評価した時点」で解決する（dsl.ts §1 の注意）。
 */

import type { BoardState, CardInstance, Seat } from '../core/board'
import { activeSeat, findFrame, inBattle, nearestBattle, type ProcFrame } from '../core/proc'
import type { Ability, CardRef, Choice, Cond, Expr, Op, PlayerRef, Selector } from './dsl'
import { controllerOf, isCharOnField, other, type EngineCtx, type Env } from './ctx'
import { abilityAt } from './abilities'
import { battleMod, currentStat } from './layers'

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
      case 'challenger':
      case 'battleUser': // H-9c 仮の既定＝挑んだ側
        return nearestBattle(state)?.battle?.challenger ?? env.you
      case 'triggerActor':
        return triggerFrame(state, env)?.decl?.by ?? env.you
      case 'equipper': // 性格反転キノコの静的効果は you＝発生源（アイテム）の使用権者＝装備させたプレイヤー（layers.ts layerEnv）
        return env.you
      case 'challenged': {
        const b = nearestBattle(state)?.battle
        return b ? other(b.challenger) : other(env.you)
      }
      default:
        return env.you
    }
  }
  if ('seat' in p) return p.seat
  if ('opponentOf' in p) return other(resolvePlayer(state, env, p.opponentOf))
  if ('controllerOf' in p) return controllerOf(state, resolveRef(state, env, p.controllerOf)[0] ?? '') ?? env.you
  if ('slot' in p) return (env.slots[p.slot]?.[0] as Seat | undefined) ?? env.you
  return state.cards[resolveRef(state, env, p.ownerOf)[0] ?? '']?.owner ?? env.you
}

/** 参照 → カードの iid の列（該当なしは空） */
export function resolveRef(state: BoardState, env: Env, r: CardRef): string[] {
  switch (r.ref) {
    case 'self':
      return env.self ? [env.self] : []
    case 'it':
      return env.it ? [env.it] : []
    case 'deckTop': {
      // デッキの一番上（index が最小）の1枚。デッキ0枚なら空（R4c G5b・予知能力）
      const seat = resolvePlayer(state, env, r.side)
      const top = Object.values(state.cards).filter((c) => c.owner === seat && c.zone === 'deck').sort((a, b) => a.index - b.index)[0]
      return top ? [top.iid] : []
    }
    case 'slot':
      return (env.slots[r.slot] ?? []).filter((x) => x in state.cards)
    case 'equipped': {
      // 効果が失われたときの処理（whenLost）は、その層を足したときの装備先（env.host）を指す（R3）
      const host = env.host !== undefined ? env.host : env.self ? state.cards[env.self]?.attachedTo : null
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
        case 'selectedBattleCard':
          return f.battle?.battleCard ? [f.battle.battleCard] : []
        case 'summonedChar':
          // D17: 効果で「呼び出す」ときの《キャラクターカードが呼び出されるとき》の窓（このときキャラはまだ場に出ていない）
          // 宣言を経る呼び出し（規 705 [11]・R4c G5f-2 の威圧）は frame.decl の発生源がそのカード（まだ提示エリアにある）
          return f.summon ? [f.summon.iid] : f.kind === 'call' && f.decl?.sourceIid ? [f.decl.sourceIid] : []
        default:
          return []
      }
    }
    case 'battle': {
      const b = nearestBattle(state)?.battle
      if (!b) return []
      if (r.role === 'battleCard') return b.battleCard ? [b.battleCard] : []
      return b.participants[r.role === 'challengerParticipants' ? b.challenger : other(b.challenger)]
    }
    case 'participants': {
      const b = nearestBattle(state)?.battle
      return b ? b.participants[resolvePlayer(state, env, r.side)] : []
    }
    case 'leader': {
      const seat = resolvePlayer(state, env, r.side)
      const l = Object.values(state.cards).find((x) => x.zone === 'leader' && x.owner === seat)
      return l ? [l.iid] : []
    }
    case 'paidBy': {
      // 《手作り弁当》: 宣言の使用代償を払うために 7-2 で消耗させた（発生源の）キャラ。処理時に場にいなければ無し（NH-33⑤）。消耗させずに払ったなら無し（NH-33①）
      const d = env.declId ? state.proc.find((f) => f.decl?.id === env.declId)?.decl : undefined
      const src = d?.costGens.flat().find((s) => s.from === 'field')
      return src && isCharOnField(state.cards[src.iid]) ? [src.iid] : []
    }
    case 'opponentChar':
      return opponentChars(state, env, resolveRef(state, env, r.of)[0])
    case 'named':
      // 名前で指す参照は R2a の記述では使わない（名前の照合は nameIs 条件）。K7（コピー）と一緒に作る
      return []
    default:
      return []
  }
}

/** 対戦キャラ: バトル参加キャラなら相手側の参加キャラ。参加していないキャラが身代わりでバトルの結果ダメージを受けたら、
 *  元の受け手の対戦キャラ（H-13 仮の既定）＝そのダメージの発生元の側の参加キャラ */
function opponentChars(state: BoardState, env: Env, iid: string | undefined): string[] {
  if (!iid) return []
  const bf = nearestBattle(state)
  const b = bf?.battle
  if (!b) return []
  for (const seat of ['A', 'B'] as Seat[]) if (b.participants[seat].includes(iid)) return b.participants[other(seat)]
  const f = env.trigger ? findFrame(state, env.trigger) : undefined
  const d = f?.damage
  if (d?.battle && d.recipient === iid && d.origRecipient) {
    for (const seat of ['A', 'B'] as Seat[]) if (b.participants[seat].includes(d.origRecipient)) return b.participants[other(seat)]
  }
  return []
}

/** 今の能力値・攻防修正は継続効果の層から導き出す（R3: engine/layers.ts。印刷値＋層を連番の順に＋手直しの層） */
export { currentStat }

/** 攻防修正の合計（atk・def）: 層＋手直しの層 */
export function battleModOf(ctx: EngineCtx, state: BoardState, iid: string, side: 'atk' | 'def'): number {
  return battleMod(ctx, state, iid, side)
}

function triggerFrame(state: BoardState, env: Env): ProcFrame | undefined {
  return env.trigger ? findFrame(state, env.trigger) : undefined
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
      return all.filter((c) => (c.zone === sel.zone || (sel.orZone !== undefined && c.zone === sel.orZone)) && seats.includes(c.owner) && c.attachedTo === null).sort(byIndex)
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
      if (sel.fromSlot && !(env.slots[sel.fromSlot] ?? []).includes(c.iid)) return false
      if (sel.where && !evalCond(ctx, state, { ...env, it: c.iid }, sel.where)) return false
      return true
    })
    .map((c) => c.iid)
}

/**
 * バトルカードの今の場所（屋内・屋外・水中・暗闇）。場所を読む所はここだけ（NH-27②: 《屋内競技場》《水中戦》《シーサイド》《ダークネス》の上書き＝G8b は、後でここだけ直す）。
 * 今は印刷の place を返す
 */
export function battlePlaceOf(ctx: EngineCtx, state: BoardState, battleIid: string): string | undefined {
  return ctx.cards[state.cards[battleIid]?.cardId ?? '']?.place
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
  if ('picked' in c) return (env.slots[c.picked]?.length ?? 0) > 0
  if ('mustUnused' in c) {
    const xs = resolveRef(state, env, c.mustUnused)
    const p = state.procMeta.presented ?? {}
    const mk = state.procMeta.mustMarks ?? {}
    return xs.length > 0 && xs.every((x) => state.cards[x]?.zone === 'hand' && (p[x] ?? 0) <= (mk[x] ?? 0))
  }
  if ('oathMatch' in c) {
    const xs = resolveRef(state, env, c.oathMatch[0])
    const oath = env.slots[c.oathMatch[1]]?.[0]
    const kinds: Record<string, string[]> = { キャラクター: ['c'], バトル: ['b'], イベント: ['e'], その他: ['i', 'f', 't'] }
    const ok = oath ? kinds[oath] : undefined
    return !!ok && xs.length > 0 && xs.every((x) => ok.includes(ctx.cards[state.cards[x]?.cardId ?? '']?.kind ?? ''))
  }
  if ('equipsNamed' in c) {
    const xs = resolveRef(state, env, c.equipsNamed[0])
    return xs.length > 0 && xs.every((x) => Object.values(state.cards).some((a) => a.attachedTo === x && (ctx.cards[a.cardId]?.name ?? '').startsWith(c.equipsNamed[1])))
  }
  if ('nameIs' in c) {
    const xs = resolveRef(state, env, c.nameIs[0])
    return xs.length > 0 && xs.every((x) => ctx.cards[state.cards[x]?.cardId ?? '']?.name === c.nameIs[1])
  }
  if ('targets' in c) {
    const f = env.trigger ? findFrame(state, env.trigger) : undefined
    const xs = resolveRef(state, env, c.targets)
    return !!f?.decl && xs.length > 0 && xs.every((x) => f.decl!.targets.includes(x))
  }
  // ── バトル（R2b）
  if ('inBattle' in c) return inBattle(state)
  if ('battleAt' in c) {
    const b = nearestBattle(state)
    return !!b && c.battleAt.includes(b.step)
  }
  if ('isParticipant' in c) {
    const b = nearestBattle(state)?.battle
    const xs = resolveRef(state, env, c.isParticipant)
    if (!b || xs.length === 0) return false
    const seats: Seat[] = c.side === 'challenger' ? [b.challenger] : c.side === 'challenged' ? [other(b.challenger)] : ['A', 'B']
    return xs.every((x) => seats.some((st) => b.participants[st].includes(x)))
  }
  if ('joined' in c) {
    // 20-4[8]＝挑んだ側・[13]＝挑まれた側の参加キャラが「バトルに参加したとき」
    const f = triggerFrame(state, env)
    const b = f?.battle
    if (!f || !b || (f.step !== 8 && f.step !== 13)) return false
    const seat = f.step === 8 ? b.challenger : other(b.challenger)
    const xs = resolveRef(state, env, c.joined)
    return xs.length > 0 && xs.every((x) => b.participants[seat].includes(x))
  }
  if ('battleResult' in c) {
    const f = triggerFrame(state, env)
    return !!(f?.damage?.battle || f?.down?.byBattle)
  }
  if ('activeIs' in c) return activeSeat(state) === resolvePlayer(state, env, c.activeIs)
  if ('battlePlace' in c) {
    const xs = resolveRef(state, env, c.battlePlace[0])
    return xs.length > 0 && xs.every((x) => battlePlaceOf(ctx, state, x) === c.battlePlace[1])
  }
  if ('joinedReady' in c) {
    const b = nearestBattle(state)?.battle
    const xs = resolveRef(state, env, c.joinedReady)
    return !!b && xs.length > 0 && xs.every((x) => b.joinedReady.includes(x))
  }
  if ('attachedTo' in c) {
    const items = resolveRef(state, env, c.attachedTo[0])
    const host = resolveRef(state, env, c.attachedTo[1])[0]
    return !!host && items.length > 0 && items.every((x) => state.cards[x]?.attachedTo === host)
  }
  if ('hasAttr' in c) {
    // 属性が複数でも含めば当たる（FAQ:1709「力属性がその中に含まれていれば「力属性のキャラ」」）
    const xs = resolveRef(state, env, c.hasAttr[0])
    return xs.length > 0 && xs.every((x) => (ctx.cards[state.cards[x]?.cardId ?? '']?.attr ?? '').includes(c.hasAttr[1]))
  }
  if ('isKind' in c) {
    const xs = resolveRef(state, env, c.isKind[0])
    return xs.length > 0 && xs.every((x) => ctx.cards[state.cards[x]?.cardId ?? '']?.kind === c.isKind[1])
  }
  if ('charType' in c) {
    const xs = resolveRef(state, env, c.charType[0])
    return xs.length > 0 && xs.every((x) => (ctx.cards[state.cards[x]?.cardId ?? '']?.charTypes ?? []).includes(c.charType[1]))
  }
  if ('hasAbility' in c) {
    // 見出しの完全一致（FAQ:3762「アイドル声優」は「アイドル」に該当しない）。印刷された能力で見る（特殊能力を失う層は見ない）
    const xs = resolveRef(state, env, c.hasAbility[0])
    return xs.length > 0 && xs.every((x) => (ctx.cards[state.cards[x]?.cardId ?? '']?.abilities ?? []).some((h) => h.header === c.hasAbility[1]))
  }
  if ('downed' in c) {
    // ダウン処理が（cancelDown で）打ち消されずに終わったかの近似＝今ゴミ箱にあるか（D22 の読み合わせと同じ理由）
    const xs = resolveRef(state, env, c.downed)
    return xs.length > 0 && xs.every((x) => state.cards[x]?.zone === 'trash')
  }
  if ('battleNamed' in c) {
    // 種目が決まった [18]〜[28]（20-5）。バトルカードの名前で見る（FAQ:4042）。種目が変われば（バトルチェンジ）今の種目で読み直す（FAQ:1028）
    const bf = nearestBattle(state)
    const bc = bf?.battle?.battleCard
    return !!bf && !!bc && bf.step >= 18 && bf.step <= 28 && ctx.cards[state.cards[bc]?.cardId ?? '']?.name === c.battleNamed
  }
  if ('battleAtkHas' in c) {
    // バトルカードの印刷の攻撃属性に属性が含まれる（種目が決まった [18]〜[28]。《チャンピオン》。《インファイト》で選んだ能力値は含まない FAQ:3136）
    const bf = nearestBattle(state)
    const bc = bf?.battle?.battleCard
    return !!bf && !!bc && bf.step >= 18 && bf.step <= 28 && (ctx.cards[state.cards[bc]?.cardId ?? '']?.battleAtk ?? '').includes(c.battleAtkHas)
  }
  if ('sexIs' in c) {
    const xs = resolveRef(state, env, c.sexIs[0])
    return xs.length > 0 && xs.every((x) => { const s = ctx.cards[state.cards[x]?.cardId ?? '']?.sex; return s === c.sexIs[1] || s === '両方' })
  }
  if ('oppositeSex' in c) {
    // NH-24: 「両方」は誰とでも異性（無しを除く）。無しはどれとも異性でない
    const sx = (x: string) => ctx.cards[state.cards[x]?.cardId ?? '']?.sex ?? ''
    const xs = resolveRef(state, env, c.oppositeSex[0])
    const ys = resolveRef(state, env, c.oppositeSex[1])
    return xs.length > 0 && ys.length > 0 && xs.every((x) => ys.every((y) => { const a = sx(x), b = sx(y); return a !== '' && b !== '' && (a === '両方' || b === '両方' || a !== b) }))
  }
  if ('nameStarts' in c) {
    const xs = resolveRef(state, env, c.nameStarts[0])
    return xs.length > 0 && xs.every((x) => (ctx.cards[state.cards[x]?.cardId ?? '']?.name ?? '').startsWith(c.nameStarts[1]))
  }
  if ('some' in c) {
    return resolveRef(state, env, c.some).some((x) => evalCond(ctx, state, { ...env, it: x }, c.cond))
  }
  if ('sameName' in c) {
    const a = resolveRef(state, env, c.sameName[0])[0]
    const b = resolveRef(state, env, c.sameName[1])[0]
    if (!a || !b) return false
    const na = ctx.cards[state.cards[a]?.cardId ?? '']?.name
    const nb = ctx.cards[state.cards[b]?.cardId ?? '']?.name
    return !!na && na === nb
  }
  if ('declaredHasOp' in c) {
    const f = triggerFrame(state, env)
    const d = f?.decl
    const cardId = d?.eng.cardId as string | undefined
    const idx = d?.eng.index as number | undefined
    const ab = cardId !== undefined && idx !== undefined ? abilityAt(ctx, cardId, idx) : undefined
    if (!ab) return false
    return hasOpDeep(opsOf(ab), c.declaredHasOp)
  }
  if ('declaredHasAnyOp' in c) {
    const f = triggerFrame(state, env)
    const d = f?.decl
    const cardId = d?.eng.cardId as string | undefined
    const idx = d?.eng.index as number | undefined
    const ab = cardId !== undefined && idx !== undefined ? abilityAt(ctx, cardId, idx) : undefined
    if (!ab) return false
    return c.declaredHasAnyOp.some((name) => hasOpDeep(opsOf(ab), name))
  }
  if ('declaredLooks' in c) {
    const f = triggerFrame(state, env)
    const d = f?.decl
    const cardId = d?.eng.cardId as string | undefined
    const idx = d?.eng.index as number | undefined
    const ab = cardId !== undefined && idx !== undefined ? abilityAt(ctx, cardId, idx) : undefined
    if (!ab) return false
    return looksAtHidden(opsOf(ab), (ab as { choices?: Choice[] }).choices ?? [])
  }
  if ('declaredReducesKiryoku' in c) {
    const f = triggerFrame(state, env)
    const d = f?.decl
    const cardId = d?.eng.cardId as string | undefined
    const idx = d?.eng.index as number | undefined
    const ab = cardId !== undefined && idx !== undefined ? abilityAt(ctx, cardId, idx) : undefined
    if (!ab || !d) return false
    const targets = resolveRef(state, env, c.declaredReducesKiryoku)
    if (targets.length === 0) return false
    // 宣言した行動の側から見る（self＝宣言したカード・you＝宣言したプレイヤー・slots＝宣言時に決めた対象）
    const denv: Env = { self: d.sourceIid, you: d.by, slots: (d.eng.slots as Record<string, string[]>) ?? {}, trigger: env.trigger, declId: d.id, declared: (d.eng.declared as Env['declared']) ?? {}, ...(d.eng.host ? { host: d.eng.host as string } : {}) }
    return reducesKiryokuOf(ctx, state, denv, opsOf(ab), targets)
  }
  // pureAttrs は R4 以降
  return false
}

/** その能力・イベントの効果の Op の列（choices を持たない conditional もそのまま） */
function opsOf(ab: Ability): Op[] {
  return ab.kind === 'activated' || ab.kind === 'play' || ab.kind === 'conditional' ? ab.effect : []
}

/** ops（forEach・if・simul・offer の中も）に、targets のどれかの気力を直接減らす op（kiryoku・recover でない・負の delta）があるか（《命の香炉》R4c G11b-3） */
function reducesKiryokuOf(ctx: EngineCtx, state: BoardState, env: Env, ops: Op[], targets: string[]): boolean {
  return ops.some((o) => {
    if (o.op === 'kiryoku') return !o.recover && evalExpr(ctx, state, env, o.delta) < 0 && resolveRef(state, env, o.who).some((x) => targets.includes(x))
    if (o.op === 'forEach') return select(ctx, state, env, o.in).some((x) => reducesKiryokuOf(ctx, state, { ...env, slots: { ...env.slots, [o.as]: [x] } }, o.do, targets))
    if (o.op === 'simul') return reducesKiryokuOf(ctx, state, env, o.do, targets)
    if (o.op === 'if') return reducesKiryokuOf(ctx, state, env, evalCond(ctx, state, env, o.cond) ? o.then : (o.else ?? []), targets)
    if (o.op === 'offer') return reducesKiryokuOf(ctx, state, env, [...o.pay, ...o.ifPaid, ...o.ifDeclined], targets)
    return false
  })
}

/**
 * 「手札やデッキを調べる効果」（規 1200・R4c G5f-2 F12）＝デッキや手札など非公開情報のカードを見る効果。
 * 当たる: lookTop／lookHand／pickRandom（相手の手札を引いて見る）／choose の候補がデッキ・相手の手札（chooser が相手でないもの＝探す）。
 * 当たらない: ドロー・ゴミ箱から選ぶ（公開）・自分の手札から選ぶ・相手が自分の手札から選んで捨てる（画策・徴収）・見ずに捨てる（予知能力）
 */
function selLooks(pick: Choice['pick'], chooser: PlayerRef): boolean {
  if (!('cards' in pick)) return false
  const s = pick.cards
  if (s.zone === 'deck') return true
  return s.zone === 'hand' && s.side === 'opponent' && chooser !== 'opponent'
}
function looksAtHidden(ops: Op[], choices: Choice[]): boolean {
  if (choices.some((ch) => selLooks(ch.pick, ch.chooser))) return true
  return ops.some((o) => {
    if (o.op === 'lookTop' || o.op === 'lookHand') return true
    if (o.op === 'pickRandom') return o.from.zone === 'deck' || (o.from.zone === 'hand' && o.from.side === 'opponent')
    if (o.op === 'choose') return selLooks(o.choice.pick, o.choice.chooser)
    if (o.op === 'forEach' || o.op === 'simul') return looksAtHidden(o.do, [])
    if (o.op === 'if') return looksAtHidden(o.then, []) || (o.else ? looksAtHidden(o.else, []) : false)
    if (o.op === 'offer') return looksAtHidden(o.pay, []) || looksAtHidden(o.ifPaid, []) || looksAtHidden(o.ifDeclined, [])
    return false
  })
}

/** Op の列に、name の op が（forEach・if・simul・offer の中も含めて）含まれるか（D23「ドローする効果をもつ」の判定） */
function hasOpDeep(ops: Op[], name: string): boolean {
  return ops.some((o) => {
    if (o.op === name) return true
    if (o.op === 'forEach' || o.op === 'simul') return hasOpDeep(o.do, name)
    if (o.op === 'if') return hasOpDeep(o.then, name) || (o.else ? hasOpDeep(o.else, name) : false)
    if (o.op === 'offer') return hasOpDeep(o.pay, name) || hasOpDeep(o.ifPaid, name) || hasOpDeep(o.ifDeclined, name)
    return false
  })
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
  if ('chosen' in e) return Number(env.slots[e.chosen]?.[0] ?? '0')
  if ('callCost' in e) {
    const c = state.cards[resolveRef(state, env, e.callCost)[0] ?? '']
    return c ? [...(ctx.cards[c.cardId]?.cost ?? '')].filter((ch) => 'WRGLT'.includes(ch)).length : 0
  }
  if ('stat' in e) {
    // 能力値（継続効果の層から導き出す R3）。base＝元の能力値
    const c = state.cards[resolveRef(state, env, e.of)[0] ?? '']
    const stat = typeof e.stat === 'string' ? e.stat : env.slots[e.stat.slot]?.[0]
    if (!c || !stat) return 0
    return e.basis === 'base' ? ctx.cards[c.cardId]?.stats?.[stat] ?? 0 : currentStat(ctx, state, c.iid, stat)
  }
  if ('battleDamage' in e) {
    const b = nearestBattle(state)?.battle
    const x = resolveRef(state, env, e.battleDamage)[0]
    if (!b || !b.damage || !x) return 0
    // K9: 複数参加では同じ受け手に複数件のダメージがありうる（FAQ:3878-3879）。合計を返す
    return b.damage.filter((d) => d.recipient === x).reduce((s, d) => s + Math.max(0, d.value), 0)
  }
  return 0
}
