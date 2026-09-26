// ホスト権威プロトコル本体（DESIGN.md §6 / PHASE2.md §3）。
// Transport（生の管）の上に、seq/version/ackの形を乗せる。
// UIを持ち込まない・core/ は使ってよい（net→core は正、core→net は禁止）。
// エンジンの要求（EngineReq）もこの上に乗る（R2u）。

import { applyAction, type BoardAction } from '../core/actions'
import type { BoardState } from '../core/board'
import { dispatch as dispatchHistory, type History, type LogEntry } from '../core/history'
import type { Seat } from '../core/board'
import type { DeclareReq } from '../engine/drive'

/**
 * エンジンモードの要求（PHASE-R2u §3-1）。ゲストはこれをホストに送るだけ。ホスト（と一人のとき）が
 * src/ui/engine/host.ts の applyEngineReq で適用し、結果の state を配る（DESIGN §6: ホストが正）。
 */
export type EngineReq =
  | { kind: 'declare'; req: DeclareReq }
  /** auto: 鳴き無しボタンの自動見送り（ログで畳む。統括11 の検証の気づき3） */
  | { kind: 'pass'; by: Seat; auto?: boolean }
  | { kind: 'choose'; by: Seat; id: string; pick: string[] }
  /**
   * フェイズの終了（10-2-2 oldrule.txt:367-369）: AP は answer 無しで「フェイズ終了を宣言」（フェイズの窓での見送りと同じ）。
   * NAP は answer で「認める」（＝見送り）／「認めない」（宣言は無効・フェイズは続く）
   */
  | { kind: 'phase'; by: Seat; answer?: 'accept' | 'deny' }
  /** 手動からエンジンに戻す（mode を engine にして、今の proc から drive で続ける）。どちらの席も出せる */
  | { kind: 'engineOn'; by: Seat }
  /** 20-4[23] 攻撃能力値・防御能力値の人の入力（エンジンが出せないとき。drive の askValues で止まっている） */
  | { kind: 'values'; by: Seat; values: Record<Seat, { atk: number; def: number }> }
  /** 開始準備の後にターンを置く（先攻の1ターン目・エントリー）。R2u-1 の暫定: 誰でも出せる */
  | { kind: 'start'; by: Seat; first: Seat }
  /** 手順を捨てる（詰まったとき用・確認つき §2-3）。どちらの席も出せる */
  | { kind: 'abandon'; by: Seat }

/** 段ごとの表示（§2-4）に使う、公開してよい1段（カードの iid と文。非公開のカード名は入れない） */
export interface PublicStep {
  text: string
  iids: string[]
}

export type NetMessage =
  | { kind: 'hello'; role: 'host' | 'guest'; name: string }
  // log: ホストの表示用ログ（古い順）。ゲストは past を持たないので、これが無いとゲストにログが一切出ない
  // （10-1-1[1] マリガンの手札公開が相手に届かない）。古い相手からは来ないことがあるので省略可
  | { kind: 'sync'; version: number; state: BoardState; log?: LogEntry[] }
  | { kind: 'action'; seq: number; action: BoardAction }
  | { kind: 'state'; version: number; lastSeq: number | null; state: BoardState; log?: LogEntry[]; steps?: PublicStep[] }
  // R2u: ゲスト→ホストのエンジンの要求。ホストは合法でない・その席の番でない要求を捨て、engineReject をそのゲストにだけ返す
  | { kind: 'engineReq'; seq: number; req: EngineReq }
  | { kind: 'engineReject'; seq: number; reason: string; missingDef?: boolean }

/** ホストが持つ、履歴とは別の配信用の付随情報 */
export interface HostMeta {
  version: number
  lastSeq: number | null
}

export const initialHostMeta: HostMeta = { version: 0, lastSeq: null }

/** ホストがローカル操作（自分の操作/Undo/Redo/盤面クリア）を適用した「後」に呼ぶ。version を進めて配信メッセージを作る */
export function bumpForBroadcast(meta: HostMeta, state: BoardState, lastSeq: number | null, log: LogEntry[]): { meta: HostMeta; message: NetMessage } {
  const version = meta.version + 1
  const nextMeta = { version, lastSeq }
  return { meta: nextMeta, message: { kind: 'state', version, lastSeq, state, log } }
}

/** ゲストの hello に返す、現在の全状態 */
export function helloReply(meta: HostMeta, state: BoardState, log: LogEntry[]): NetMessage {
  return { kind: 'sync', version: meta.version, state, log }
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
