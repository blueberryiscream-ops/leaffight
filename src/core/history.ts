// Undo/Redo。状態は小さいのでスナップショットを丸ごと保持する
// （DESIGN.md §2.4「差分は不要＝P0通信設計と同じ単純さ優先」）。
// ログはスナップショットと対応させる（PHASE1.md §2.4）ので、Undo/Redo で消えたり復活したりする。

import { applyAction, type BoardAction } from './actions'
import { EMPTY_BOARD, type BoardState } from './board'

export interface LogEntry {
  id: string
  text: string
  /** エンジンが進めた段（R2u §2-4「ログに1行ずつ」）。カード名は入れず iid だけ（画面が公開かどうかを見て名前にする） */
  steps?: { text: string; iids: string[] }[]
}

interface Snapshot {
  /** そのアクションを実行する「前」の状態 */
  state: BoardState
  /** そのアクションのログ */
  log: LogEntry
}

export interface History {
  present: BoardState
  past: Snapshot[]
  future: Snapshot[]
}

export function emptyHistory(): History {
  return { present: EMPTY_BOARD, past: [], future: [] }
}

/** 現在までに適用されたログ（表示用。古い順） */
export function visibleLog(history: History): LogEntry[] {
  return history.past.map((s) => s.log)
}

/** アクションを適用する。ログが空文字（対象が既に存在しない等）なら状態も履歴も変えない */
export function dispatch(history: History, action: BoardAction, logId: string): History {
  const { state, log } = applyAction(history.present, action)
  if (!log) return history
  return {
    present: state,
    past: [...history.past, { state: history.present, log: { id: logId, text: log } }],
    future: [],
  }
}

export function undo(history: History): History {
  if (history.past.length === 0) return history
  const last = history.past[history.past.length - 1]
  return {
    present: last.state,
    past: history.past.slice(0, -1),
    future: [{ state: history.present, log: last.log }, ...history.future],
  }
}

export function redo(history: History): History {
  if (history.future.length === 0) return history
  const next = history.future[0]
  return {
    present: next.state,
    past: [...history.past, { state: history.present, log: next.log }],
    future: history.future.slice(1),
  }
}
