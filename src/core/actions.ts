// 操作を1つのデータ型にまとめる。P2でネット越しに送る単位もこれになる想定
// （DESIGN.md §6「ゲストの操作は Action としてホストへ送信」）。
// ここでも乱数・時刻は持たない。呼び出し側が iid・並び順を決めて渡す。

import * as board from './board'
import type { BoardState, ModScope, Modifier, Orientation, Seat, ZoneId } from './board'
import * as priorityEngine from './priority'
import type { DeclaredAction, Mode, Priority } from './priority'

export type BoardAction =
  | { type: 'spawnCard'; iid: string; cardId: string; cardName: string; owner: Seat; zone: ZoneId }
  | { type: 'moveCard'; iid: string; toOwner?: Seat; toZone: ZoneId; toIndex?: number; cardName: string }
  | { type: 'setOrientation'; iid: string; orientation: Orientation; cardName: string }
  | { type: 'toggleOrientation'; iid: string; cardName: string }
  | { type: 'setKiryoku'; iid: string; value: number; cardName: string }
  | { type: 'adjustKiryoku'; iid: string; delta: number; max: number; cardName: string }
  | { type: 'setFaceUp'; iid: string; faceUp: boolean; cardName: string }
  | { type: 'flip'; iid: string; cardName: string }
  | { type: 'addModifier'; modifier: Modifier; cardName: string }
  | { type: 'removeModifier'; modId: string; cardName: string }
  | { type: 'clearModifiers'; iid: string; scope?: ModScope; cardName: string }
  | { type: 'attach'; itemIid: string; targetIid: string; itemName: string; targetName: string }
  | { type: 'detach'; itemIid: string; itemName: string }
  | { type: 'toTrash'; iid: string; cardName: string }
  | { type: 'removeCard'; iid: string; cardName: string }
  | { type: 'shuffleDeck'; owner: Seat; orderedIids: string[] }
  | { type: 'clearBoard' }
  | { type: 'declareAction'; action: DeclaredAction }
  | { type: 'passPriority'; by: Seat }
  | { type: 'resolveStep'; cancel?: boolean }
  | { type: 'setMode'; mode: Mode }

/**
 * 現在の窓で「今まさに解決される」DeclaredAction を取り出す（PHASE3a-3.md §2-4）。
 * resolvingSeat（priority.ts）と同じ判定だが、席ではなくaction本体を返す。
 * resolveStepが実際に適用される「前」のpriorityに対して呼ぶこと（適用後だと対象フレームが
 * 既にpop/進行済みで分からなくなる）。
 */
function resolvingAction(priority: Priority | null): DeclaredAction | null {
  if (!priority) return null
  const current = priority.frames[priority.frames.length - 1]
  if (!current) return null
  if (current.step === 'processActive') return current.active
  if (current.step === 'processNonActive') return current.nonActive
  return null
}

export function applyAction(state: BoardState, action: BoardAction): board.Result {
  switch (action.type) {
    case 'spawnCard':
      return board.spawnCard(state, action)
    case 'moveCard':
      return board.moveCard(state, action)
    case 'setOrientation':
      return board.setOrientation(state, action)
    case 'toggleOrientation':
      return board.toggleOrientation(state, action)
    case 'setKiryoku':
      return board.setKiryoku(state, action)
    case 'adjustKiryoku':
      return board.adjustKiryoku(state, action)
    case 'setFaceUp':
      return board.setFaceUp(state, action)
    case 'flip':
      return board.flip(state, action)
    case 'addModifier':
      return board.addModifier(state, action)
    case 'removeModifier':
      return board.removeModifier(state, action)
    case 'clearModifiers':
      return board.clearModifiers(state, action)
    case 'attach':
      return board.attach(state, action)
    case 'detach':
      return board.detach(state, action)
    case 'toTrash':
      return board.toTrash(state, action)
    case 'removeCard':
      return board.removeCard(state, action)
    case 'shuffleDeck':
      return board.shuffleDeck(state, action)
    case 'clearBoard':
      return board.clearBoard()
    case 'declareAction': {
      const { priority, log } = priorityEngine.declareAction(state.priority, action.action)
      // 🚨 engineに弾かれた宣言（不正な手番等）はlogが空文字で返る。このときstateを一切変えず
      // 返す（カードは動かさない）。逆順（先にカードを動かしてから受理判定）にすると、
      // 弾かれた宣言でもカードが手札から消えてしまう（PHASE3a-3.md §2-4）。
      if (!log) return { state, log: '' }

      let next: BoardState = { ...state, priority }
      const place = action.action.place
      if (place && action.action.sourceIid) {
        const moved = board.moveCard(next, {
          iid: action.action.sourceIid,
          toOwner: action.action.by,
          toZone: 'pending',
          cardName: action.action.label,
        })
        next = moved.state
      }
      return { state: next, log }
    }
    case 'passPriority': {
      const { priority, log } = priorityEngine.passPriority(state.priority, action.by)
      return { state: { ...state, priority }, log }
    }
    case 'resolveStep': {
      // 解決される対象は「適用前」のpriorityから取り出す（適用後は既にpop/進行済みで分からない）
      const resolved = resolvingAction(state.priority)
      const { priority, log } = priorityEngine.resolveStep(state.priority)
      if (!log) return { state, log: '' }

      let next: BoardState = { ...state, priority }
      if (resolved?.place && resolved.sourceIid) {
        const card = next.cards[resolved.sourceIid]
        if (card && card.zone === 'pending') {
          const moved = action.cancel
            ? board.moveCard(next, { iid: resolved.sourceIid, toOwner: resolved.by, toZone: 'hand', cardName: resolved.label })
            : board.moveCard(next, {
                iid: resolved.sourceIid,
                toOwner: resolved.place.toOwner ?? resolved.by,
                toZone: resolved.place.toZone,
                toIndex: resolved.place.toIndex,
                cardName: resolved.label,
              })
          next = moved.state
        }
      }
      // engineのlogは常に「〜を解決」形式。取り消し時は文言を差し替える（PHASE3a-3.md §2-4）
      const resolveLog = action.cancel ? log.replace('を解決', 'を取り消した（手札に戻した）') : log
      return { state: next, log: resolveLog }
    }
    case 'setMode': {
      const { priority, mode, log } = priorityEngine.setMode(state.priority, action.mode)
      let next: BoardState = { ...state, priority, mode }
      // 🚨 freeに切り替えるとpriorityがnullになり、pendingに残ったカードは行き場を失って
      // 盤面から消える（pendingはどこにも描画されないため）。free化のタイミングで
      // pendingのカードを全て持ち主の手札に戻す（PHASE3a-3.md §2-4「見落とし厳禁」）。
      if (action.mode === 'free') {
        for (const card of Object.values(state.cards)) {
          if (card.zone !== 'pending') continue
          const moved = board.moveCard(next, { iid: card.iid, toOwner: card.owner, toZone: 'hand', cardName: card.cardId })
          next = moved.state
        }
      }
      return { state: next, log }
    }
  }
}
