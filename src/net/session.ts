// ホスト権威プロトコル本体（DESIGN.md §6 / PHASE2.md §3）。
// Transport（生の管）の上に、seq/version/ackの形を乗せる。
// UIを持ち込まない・core/ は使ってよい（net→core は正、core→net は禁止）。
// P3の優先権システム(declare/respond/pass/resolve)はこの上に乗る想定（DESIGN.md §5.1）。

import { applyAction, type BoardAction } from '../core/actions'
import type { BoardState } from '../core/board'
import { dispatch as dispatchHistory, type History } from '../core/history'

export type NetMessage =
  | { kind: 'hello'; role: 'host' | 'guest'; name: string }
  | { kind: 'sync'; version: number; state: BoardState }
  | { kind: 'action'; seq: number; action: BoardAction }
  | { kind: 'state'; version: number; lastSeq: number | null; state: BoardState }

/** ホストが持つ、履歴とは別の配信用の付随情報 */
export interface HostMeta {
  version: number
  lastSeq: number | null
}

export const initialHostMeta: HostMeta = { version: 0, lastSeq: null }

/** ホストがローカル操作（自分の操作/Undo/Redo/盤面クリア）を適用した「後」に呼ぶ。version を進めて配信メッセージを作る */
export function bumpForBroadcast(meta: HostMeta, state: BoardState, lastSeq: number | null): { meta: HostMeta; message: NetMessage } {
  const version = meta.version + 1
  const nextMeta = { version, lastSeq }
  return { meta: nextMeta, message: { kind: 'state', version, lastSeq, state } }
}

/** ゲストの hello に返す、現在の全状態 */
export function helloReply(meta: HostMeta, state: BoardState): NetMessage {
  return { kind: 'sync', version: meta.version, state }
}

/** ホストがゲストの action を適用する。history が変わらなければ何もしない（対象が既に無い等） */
export function applyGuestAction(history: History, action: BoardAction, logId: string): History {
  return dispatchHistory(history, action, logId)
}

/** ゲストが sync/state を受けたときの新しい History。ゲストは past/future を持たない（Undo/Redo はホストのみ） */
export function applyRemoteState(msg: NetMessage): History | null {
  if (msg.kind === 'sync' || msg.kind === 'state') {
    return { present: msg.state, past: [], future: [] }
  }
  return null
}

// applyAction は現状 dispatchHistory 経由でのみ使うが、
// 将来P3でスタック解決など単発のaction適用が要る場面のために re-export しておく
export { applyAction }
