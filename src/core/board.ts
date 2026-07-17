// 盤面の状態とその操作。純TypeScript（DESIGN.md §3 / PHASE1.md §1）。
// すべての操作は「現在の状態 + 引数」から「次の状態 + ログ」を返す純関数。
// 乱数・時刻はここでは生成しない。呼び出し側（ui/）が生成して引数で渡す
// （P2でホストの操作をそのまま再生できるようにするため。PHASE1.md §6地雷）。

import type { Attr } from './types'

// 絶対座席（PHASE2.5.md §2.1）。'自分/相手' のような視点依存の語は core/ に一切持ち込まない。
// 「どちらが自分か」はクライアント側だけが知る情報（ui/board/useBoard.ts の localSeat）。
export type Seat = 'A' | 'B'

export type ZoneId = 'deck' | 'hand' | 'trash' | 'leader' | 'char' | 'battle' | 'field'

export type Orientation = 'ready' | 'rested'

export interface CardInstance {
  iid: string
  cardId: string
  owner: Seat
  zone: ZoneId
  index: number
  orientation: Orientation
  faceUp: boolean
  /** 気力（キャラ/リーダー/タッグのみ使う）。バトル/アイテム等は null のまま */
  kiryoku: number | null
  /** アイテム等がキャラに付いている場合、対象キャラの iid（DESIGN.md §4.14） */
  attachedTo: string | null
}

/** 修正の切れ方の目印。自動消滅はしない（DESIGN.md §4.16）。人間が見て判断・削除する */
export type ModScope = 'このバトル' | 'ターン終了時' | '発生元依存' | 'その他'

export interface Modifier {
  id: string
  targetIid: string
  sourceLabel: string
  stat?: Attr
  delta?: number
  note?: string
  scope: ModScope
}

export interface BoardState {
  cards: Record<string, CardInstance>
  modifiers: Record<string, Modifier>
}

export const EMPTY_BOARD: BoardState = { cards: {}, modifiers: {} }

/**
 * フィールド系ゾーンの固定スロット数（座席ごと）。DESIGN.md §4.13。ルール強制ではなくUIの置き場。
 * 🚨 `field` はここに含めない。両陣営で共有1枚であり「座席ごと」の容量という考え方自体が誤り
 * （PHASE2.6.md §3。P1〜P2.5では座席ごとに1スロットあり、フィールドカード2枚同時という
 * ルール上ありえない盤面を作れてしまっていた＝統括が承認していた簡略化の誤り）。
 */
export const SLOT_CAPACITY: Partial<Record<ZoneId, number>> = {
  leader: 1,
  char: 5,
  battle: 3,
}

/** フィールドは盤面全体で1枚（座席を問わない共有スロット）。DESIGN.md §4.13訂正 */
export const FIELD_CAPACITY = 1

export function isSlotted(zone: ZoneId): boolean {
  return zone in SLOT_CAPACITY || zone === 'field'
}

export function cardsInZone(state: BoardState, owner: Seat, zone: ZoneId): CardInstance[] {
  return Object.values(state.cards)
    .filter((c) => c.owner === owner && c.zone === zone)
    .sort((a, b) => a.index - b.index)
}

/** フィールドの現在の1枚（無ければundefined）。座席を問わない共有スロットなのでownerでは絞らない */
export function fieldCard(state: BoardState): CardInstance | undefined {
  return Object.values(state.cards).find((c) => c.zone === 'field')
}

export function modifiersFor(state: BoardState, iid: string): Modifier[] {
  return Object.values(state.modifiers).filter((m) => m.targetIid === iid)
}

/** 表示能力値 = 素の値 + 有効な Modifier の合計（DESIGN.md §4.16） */
export function effectiveStat(state: BoardState, iid: string, base: number, stat: Attr): number {
  const delta = modifiersFor(state, iid)
    .filter((m) => m.stat === stat)
    .reduce((sum, m) => sum + (m.delta ?? 0), 0)
  return base + delta
}

function cloneBoard(state: BoardState): BoardState {
  return { cards: { ...state.cards }, modifiers: { ...state.modifiers } }
}

/** ゾーン内の index を 0..n-1 の連番に詰め直す（DESIGN.md §2.2「正規化して1箇所で管理」） */
function normalizeZone(state: BoardState, owner: Seat, zone: ZoneId): BoardState {
  const next = cloneBoard(state)
  const list = cardsInZone(next, owner, zone)
  list.forEach((c, i) => {
    if (c.index !== i) next.cards[c.iid] = { ...c, index: i }
  })
  return next
}

// ---------------------------------------------------------------------------
// 個々の操作（純関数）。それぞれ { state, log } を返す。
// ---------------------------------------------------------------------------

export interface Result {
  state: BoardState
  log: string
}

export function spawnCard(
  state: BoardState,
  args: { iid: string; cardId: string; cardName: string; owner: Seat; zone: ZoneId },
): Result {
  const { iid, cardId, cardName, owner, zone } = args
  // フィールドは共有1枚なので、座席を問わず既存の有無だけで index を決める
  const index = zone === 'field' ? (fieldCard(state) ? 1 : 0) : cardsInZone(state, owner, zone).length
  const instance: CardInstance = {
    iid,
    cardId,
    owner,
    zone,
    index,
    // 実物同様、場に出た瞬間は消耗状態（召喚酔い。DESIGN.md §4.5）。手札等は待機扱いでよい
    orientation: zone === 'char' || zone === 'battle' || zone === 'leader' ? 'rested' : 'ready',
    faceUp: zone !== 'deck',
    kiryoku: null,
    attachedTo: null,
  }
  const next = cloneBoard(state)
  next.cards[iid] = instance
  return { state: next, log: `${cardName} を ${ZONE_LABEL[zone]} に置いた` }
}

/**
 * デッキへ入るときは裏、デッキから出るときは表にする（PHASE2.8.md §3「デッキから引いたカードが
 * 裏のままなのは使い勝手が悪い」）。それ以外の移動では今の表裏を維持する（手動の裏返しは別途可能）。
 */
function resolveFaceUp(fromZone: ZoneId, toZone: ZoneId, current: boolean): boolean {
  if (toZone === 'deck') return false
  if (fromZone === 'deck') return true
  return current
}

/** 占有スロットに移動するときは、既存の占有カードと入れ替える（実物マットの入れ替えと同じ挙動） */
export function moveCard(
  state: BoardState,
  args: { iid: string; toOwner?: Seat; toZone: ZoneId; toIndex?: number; cardName: string },
): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const toOwner = args.toOwner ?? card.owner
  const fromZone = card.zone
  const fromOwner = card.owner
  const fromIndex = card.index
  const faceUp = resolveFaceUp(fromZone, args.toZone, card.faceUp)

  let next = cloneBoard(state)

  if (args.toZone === 'field') {
    // 共有1枚（座席を問わない）。既存の1枚があれば、移動元カードの元の場所へ追い出す
    // （P1のmoveCardの既存の入れ替え挙動そのまま。PHASE2.6.md §3「自動化はP4」）
    const occupant = fieldCard(next)
    const actualOccupant = occupant && occupant.iid !== card.iid ? occupant : undefined
    next.cards[card.iid] = { ...card, owner: toOwner, zone: 'field', index: 0, faceUp }
    if (actualOccupant) {
      next.cards[actualOccupant.iid] = {
        ...actualOccupant,
        owner: fromOwner,
        zone: fromZone,
        index: fromIndex,
        faceUp: resolveFaceUp(args.toZone, fromZone, actualOccupant.faceUp),
      }
    }
  } else if (isSlotted(args.toZone) && args.toIndex !== undefined) {
    const occupant = Object.values(next.cards).find(
      (c) => c.owner === toOwner && c.zone === args.toZone && c.index === args.toIndex && c.iid !== card.iid,
    )
    next.cards[card.iid] = { ...card, owner: toOwner, zone: args.toZone, index: args.toIndex, faceUp }
    if (occupant) {
      next.cards[occupant.iid] = {
        ...occupant,
        owner: fromOwner,
        zone: fromZone,
        index: fromIndex,
        faceUp: resolveFaceUp(args.toZone, fromZone, occupant.faceUp),
      }
    }
  } else {
    const toIndex = args.toIndex ?? cardsInZone(next, toOwner, args.toZone).length
    next.cards[card.iid] = { ...card, owner: toOwner, zone: args.toZone, index: toIndex, faceUp }
    next = normalizeZone(next, toOwner, args.toZone)
    if (fromOwner !== toOwner || fromZone !== args.toZone) {
      next = normalizeZone(next, fromOwner, fromZone)
    }
  }

  return { state: next, log: `${args.cardName} を ${ZONE_LABEL[fromZone]} から ${ZONE_LABEL[args.toZone]} へ移動した` }
}

export function setOrientation(
  state: BoardState,
  args: { iid: string; orientation: Orientation; cardName: string },
): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, orientation: args.orientation }
  return {
    state: next,
    log: `${args.cardName} を ${args.orientation === 'rested' ? '消耗' : '待機'} にした`,
  }
}

export function toggleOrientation(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  return setOrientation(state, {
    iid: args.iid,
    orientation: card.orientation === 'ready' ? 'rested' : 'ready',
    cardName: args.cardName,
  })
}

export function setKiryoku(state: BoardState, args: { iid: string; value: number; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, kiryoku: args.value }
  return { state: next, log: `${args.cardName} の気力を ${args.value} にした` }
}

export function adjustKiryoku(
  state: BoardState,
  args: { iid: string; delta: number; max: number; cardName: string },
): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const before = card.kiryoku ?? args.max
  // 気力は上限を超えない（DESIGN.md §4.6）。下限は決め打ちしない（マイナス表示も実戦であり得る）
  const after = Math.min(before + args.delta, args.max)
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, kiryoku: after }
  return { state: next, log: `${args.cardName} の気力 ${before}→${after}` }
}

export function setFaceUp(state: BoardState, args: { iid: string; faceUp: boolean; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, faceUp: args.faceUp }
  return { state: next, log: `${args.cardName} を ${args.faceUp ? '表' : '裏'} にした` }
}

export function flip(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  return setFaceUp(state, { iid: args.iid, faceUp: !card.faceUp, cardName: args.cardName })
}

export function addModifier(state: BoardState, args: { modifier: Modifier; cardName: string }): Result {
  const next = cloneBoard(state)
  next.modifiers[args.modifier.id] = args.modifier
  const statPart = args.modifier.stat
    ? `${args.modifier.stat}${(args.modifier.delta ?? 0) >= 0 ? '+' : ''}${args.modifier.delta ?? 0}`
    : (args.modifier.note ?? '')
  return { state: next, log: `${args.cardName} に修正「${args.modifier.sourceLabel} ${statPart}」を追加した` }
}

export function removeModifier(state: BoardState, args: { modId: string; cardName: string }): Result {
  const mod = state.modifiers[args.modId]
  if (!mod) return { state, log: '' }
  const next = cloneBoard(state)
  delete next.modifiers[args.modId]
  return { state: next, log: `${args.cardName} の修正「${mod.sourceLabel}」を消した` }
}

export function clearModifiers(state: BoardState, args: { iid: string; scope?: ModScope; cardName: string }): Result {
  const next = cloneBoard(state)
  let count = 0
  for (const [id, mod] of Object.entries(state.modifiers)) {
    if (mod.targetIid !== args.iid) continue
    if (args.scope && mod.scope !== args.scope) continue
    delete next.modifiers[id]
    count++
  }
  return { state: next, log: `${args.cardName} の修正を ${count} 件クリアした` }
}

export function attach(state: BoardState, args: { itemIid: string; targetIid: string; itemName: string; targetName: string }): Result {
  const item = state.cards[args.itemIid]
  if (!item) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[item.iid] = { ...item, attachedTo: args.targetIid }
  return { state: next, log: `${args.itemName} を ${args.targetName} に付けた` }
}

export function detach(state: BoardState, args: { itemIid: string; itemName: string }): Result {
  const item = state.cards[args.itemIid]
  if (!item) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[item.iid] = { ...item, attachedTo: null }
  return { state: next, log: `${args.itemName} を取り外した` }
}

export function toTrash(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  return moveCard(state, { iid: args.iid, toZone: 'trash', cardName: args.cardName })
}

export function removeCard(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  delete next.cards[card.iid]
  for (const [id, mod] of Object.entries(next.modifiers)) {
    if (mod.targetIid === card.iid) delete next.modifiers[id]
  }
  return { state: next, log: `${args.cardName} を盤外に出した` }
}

/** シャッフル。乱数は呼び出し側が消費し、結果の並び（iid配列）だけを渡す（core純粋性のため） */
export function shuffleDeck(state: BoardState, args: { owner: Seat; orderedIids: string[] }): Result {
  let next = cloneBoard(state)
  args.orderedIids.forEach((iid, i) => {
    const card = next.cards[iid]
    if (card) next.cards[iid] = { ...card, index: i }
  })
  next = normalizeZone(next, args.owner, 'deck')
  // ログは座席名(A/B)で書く。「自分/相手」は視点依存でcoreに置けない（PHASE2.5.md §2.1）
  return { state: next, log: `${args.owner} のデッキをシャッフルした` }
}

export function clearBoard(): Result {
  return { state: EMPTY_BOARD, log: '盤面をクリアした' }
}

export const ZONE_LABEL: Record<ZoneId, string> = {
  deck: 'デッキ',
  hand: '手札',
  trash: 'ゴミ箱',
  leader: 'リーダー',
  char: 'キャラ',
  battle: 'バトル',
  field: 'フィールド',
}
