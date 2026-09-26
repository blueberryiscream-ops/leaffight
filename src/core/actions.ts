// 操作を1つのデータ型にまとめる。P2でネット越しに送る単位もこれになる想定
// （DESIGN.md §6「ゲストの操作は Action としてホストへ送信」）。
// ここでも乱数・時刻は持たない。呼び出し側が iid・並び順を決めて渡す。

import * as board from './board'
import type { BoardState, Mode, ModScope, Modifier, Orientation, Seat, ZoneId } from './board'
import { applyProc, type ProcAction, type ProcTrace } from './proc'

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
  | {
      type: 'startWithDeck'
      owner: Seat
      deckName: string
      leader: { iid: string; cardId: string; kiryoku: number | null }
      deck: { iid: string; cardId: string }[]
      draw: number
    }
  | { type: 'mulligan'; owner: Seat; orderedIids: string[]; revealedNames: string[]; draw: number }
  | { type: 'revealLeader'; owner: Seat; cardName: string }
  /** エンジン／手動の切り替え（R2u §2-3）。手動の間はエンジンを動かさない。手順（proc）はそのまま残る */
  | { type: 'setMode'; mode: Mode }
  // R2a: 原典の処理手順（core/proc.ts）。ゲストの操作もエンジンの自動処理もこの列になる（PHASE-R2a §2-1）
  | ProcAction

/**
 * applyAction: 全アクションの入口。盤面の手操作（board.ts）と原典の処理手順（proc.ts）。
 * R2u-2: 旧 priority（優先権の窓）・battle（旧バトルの状態機械）と、その後処理 battleFlow は消した（proc に置き換わった）
 */
export function applyAction(state: BoardState, action: BoardAction): board.Result & { trace?: ProcTrace[] } {
  return applyActionCore(state, action)
}

function applyActionCore(state: BoardState, action: BoardAction): board.Result & { trace?: ProcTrace[] } {
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
    case 'startWithDeck':
      return board.startWithDeck(state, action)
    case 'mulligan':
      return board.mulligan(state, action)
    case 'revealLeader':
      return board.revealLeader(state, action)
    case 'setMode': {
      if (state.mode === action.mode) return { state, log: '' }
      // 🚨 提示エリア（pending）のカードは動かさない（手順が参照している。手動の間も ProcPanel に出る）
      return { state: { ...state, mode: action.mode }, log: action.mode === 'engine' ? 'エンジンに切り替えた' : '手動に切り替えた（エンジンを止めた）' }
    }
    default:
      return applyProc(state, action)
  }
}
