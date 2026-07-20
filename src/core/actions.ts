// 操作を1つのデータ型にまとめる。P2でネット越しに送る単位もこれになる想定
// （DESIGN.md §6「ゲストの操作は Action としてホストへ送信」）。
// ここでも乱数・時刻は持たない。呼び出し側が iid・並び順を決めて渡す。

import * as board from './board'
import type { BoardState, ModScope, Modifier, Orientation, Seat, ZoneId } from './board'
import * as priorityEngine from './priority'
import type { Mode, StackItem } from './priority'

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
  | { type: 'declareAction'; item: StackItem }
  | { type: 'passPriority'; by: Seat }
  | { type: 'setMode'; mode: Mode }

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
      const { priority, log } = priorityEngine.declareAction(state.priority, action.item)
      return { state: { ...state, priority }, log }
    }
    case 'passPriority': {
      const { priority, log } = priorityEngine.passPriority(state.priority, action.by)
      return { state: { ...state, priority }, log }
    }
    case 'setMode': {
      const { priority, mode, log } = priorityEngine.setMode(state.priority, action.mode)
      return { state: { ...state, priority, mode }, log }
    }
  }
}
