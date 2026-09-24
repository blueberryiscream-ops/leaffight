import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import { isValidBattleShape } from '../../core/battle'
import { fillBoardDefaults, type BoardState, type Seat } from '../../core/board'
import { emptyHistory, dispatch as dispatchHistory, redo as redoHistory, undo as undoHistory, visibleLog, type History, type LogEntry } from '../../core/history'
import { readBoardState, writeBoardState } from '../../data/db'
import { normalizeModifiers } from './normalize'
import { PeerJsTransport } from '../../net/PeerJsTransport'
import { applyGuestAction, applyRemoteState, bumpForBroadcast, helloReply, initialHostMeta, type HostMeta, type NetMessage } from '../../net/session'

let logSeq = 0
const nextLogId = () => `log_${++logSeq}_${Date.now()}`

export type ConnMode = 'solo' | 'host' | 'guest'
export type ConnStatus = 'idle' | 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error'

export const otherSeat = (s: Seat): Seat => (s === 'A' ? 'B' : 'A')

/**
 * 旧盤面の priority は形が違う（P3a-1r以前: `stack`ベースのflatモデル。
 * 新モデルは `frames` ベース）。読込時に `frames` を持たない priority は null に正規化する。
 * これをしないと StackPanel が旧shapeを新shapeとして読んで真っ暗クラッシュする
 * （PHASE3a-1r.md §6。P3a-1導入直後に一度実際に踏んだ事故の再発防止）。
 */
function normalizePriority(board: BoardState): BoardState {
  const p = board.priority as unknown
  if (p !== null && (typeof p !== 'object' || !('frames' in p))) {
    return { ...board, priority: null }
  }
  return board
}

/**
 * 旧盤面の battle は `at` を持たない（P3d-1の形。PHASE3d-2a導入前）。読込時に `at` を
 * 持たない battle は null に正規化する（normalizePriority と同じ流儀・PHASE3d-2a.md §6）。
 * P3d-1にはUIが無かったので実データには存在しないはずだが、念のため。
 */
export function normalizeBattle(board: BoardState): BoardState {
  if (board.battle !== null && !isValidBattleShape(board.battle)) {
    return { ...board, battle: null }
  }
  return board
}

/**
 * 盤面の状態を管理する。IndexedDBに自動保存しリロードで復元する（P1）のに加えて、
 * P2からはPeerJS経由のホスト権威プロトコルに接続できる（DESIGN.md §6 / PHASE2.md §3）。
 *
 * - solo: これまでどおり。dispatch はローカルのHistoryに直接適用
 * - host: dispatch はローカルに適用 + version を進めて全員に配信。ゲストのactionもここで受けて同様に適用
 * - guest: dispatch は権威状態に触らず、actionをホストへ送るだけ。受信した state で描画を丸ごと置き換える
 *   （楽観的更新はしない。PHASE2.md §3「なぜゲストは全状態を受け取るのか」）
 */
export function useBoard() {
  const [history, setHistory] = useState<History>(emptyHistory)
  // ゲストが受け取ったホストのログ（ゲストは past を持たないので visibleLog が常に空になる）
  const [remoteLog, setRemoteLog] = useState<LogEntry[]>([])
  const loaded = useRef(false)

  const [mode, setMode] = useState<ConnMode>('solo')
  const [connStatus, setConnStatus] = useState<ConnStatus>('idle')
  const [connError, setConnError] = useState<string | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)

  // 「自分がどちらの座席か」はこのクライアントだけが知る情報。BoardStateには絶対に入れない
  // （配信で上書きされて壊れる＝PHASE2.5.md §2.2の最大の地雷）。ホスト=A・ゲスト=B固定。
  // ソロ時はA既定で、ひとり回しの見え方確認用にA⇄B切替できる（PHASE2.5.md §2.3、任意機能）。
  const [localSeat, setLocalSeatState] = useState<Seat>('A')
  const modeRef = useRef<ConnMode>('solo')
  modeRef.current = mode

  const setLocalSeat = useCallback((seat: Seat) => {
    // 接続中は座席が役割で固定される。切替はソロ時のみ許可
    if (modeRef.current !== 'solo') return
    setLocalSeatState(seat)
  }, [])

  const transportRef = useRef<PeerJsTransport | null>(null)
  const hostMetaRef = useRef<HostMeta>(initialHostMeta)
  const guestSeqRef = useRef(0)

  useEffect(() => {
    void (async () => {
      const saved = await readBoardState()
      if (saved) {
        // 旧バージョンで保存された盤面には priority / mode が無い（P3a-1以前）。
        // EMPTY_BOARD のデフォルト（priority:null, mode:'assist', setup:{A:null,B:null} 等）で
        // 補完してから復元する（fillBoardDefaults）。これをしないと StackPanel が undefined な
        // priority を読んでクラッシュする。さらに priority があっても旧shape（frames無し）の
        // ことがあるので正規化する（上記コメント参照）。
        setHistory((h) => ({
          ...h,
          present: normalizeModifiers(normalizeBattle(normalizePriority(fillBoardDefaults(saved)))),
        }))
      }
      loaded.current = true
    })()
  }, [])

  useEffect(() => {
    // 読み込み完了前に空状態を書き戻してしまわないようにする
    if (!loaded.current) return
    void writeBoardState(history.present)
  }, [history.present])

  useEffect(() => {
    return () => {
      transportRef.current?.destroy()
    }
  }, [])

  const dispatch = useCallback(
    (action: BoardAction) => {
      if (mode === 'guest') {
        if (!transportRef.current) return
        guestSeqRef.current += 1
        transportRef.current.send({ kind: 'action', seq: guestSeqRef.current, action } satisfies NetMessage)
        return
      }
      setHistory((prev) => {
        const next = dispatchHistory(prev, action, nextLogId())
        if (mode === 'host' && next.present !== prev.present && transportRef.current) {
          const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, hostMetaRef.current.lastSeq, visibleLog(next))
          hostMetaRef.current = meta
          transportRef.current.send(message)
        }
        return next
      })
    },
    [mode],
  )

  // Undo/Redo は接続中はホストのみ（PHASE2.md §4）。ゲストは history.past が常に空なので
  // canUndo/canRedo は自然に false になるが、ボタン自体もui側で隠す
  const undo = useCallback(() => {
    if (mode === 'guest') return
    setHistory((prev) => {
      const next = undoHistory(prev)
      if (mode === 'host' && next.present !== prev.present && transportRef.current) {
        const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, hostMetaRef.current.lastSeq, visibleLog(next))
        hostMetaRef.current = meta
        transportRef.current.send(message)
      }
      return next
    })
  }, [mode])

  const redo = useCallback(() => {
    if (mode === 'guest') return
    setHistory((prev) => {
      const next = redoHistory(prev)
      if (mode === 'host' && next.present !== prev.present && transportRef.current) {
        const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, hostMetaRef.current.lastSeq, visibleLog(next))
        hostMetaRef.current = meta
        transportRef.current.send(message)
      }
      return next
    })
  }, [mode])

  // 盤面クリアは普通の BoardAction として扱う。ホストなら即配信、ゲストならホストへ送って承認を待つ
  // （フリーモードなので誰が押しても通る＝P3で優先権を足すまでの割り切り）
  const resetBoard = useCallback(() => {
    dispatch({ type: 'clearBoard' })
  }, [dispatch])

  const wireTransport = useCallback((t: PeerJsTransport, role: ConnMode) => {
    t.onMessage((raw) => {
      const msg = raw as NetMessage
      if (role === 'host') {
        if (msg.kind === 'hello') {
          setHistory((prev) => {
            t.send(helloReply(hostMetaRef.current, prev.present, visibleLog(prev)))
            return prev
          })
          setConnStatus('connected')
          return
        }
        if (msg.kind === 'action') {
          setHistory((prev) => {
            const next = applyGuestAction(prev, msg.action, nextLogId())
            if (next.present !== prev.present) {
              const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, msg.seq, visibleLog(next))
              hostMetaRef.current = meta
              t.send(message)
            } else {
              hostMetaRef.current = { ...hostMetaRef.current, lastSeq: msg.seq }
            }
            return next
          })
        }
        return
      }
      // guest
      const next = applyRemoteState(msg)
      if (next) {
        setHistory(next)
        if (msg.kind === 'sync' || msg.kind === 'state') setRemoteLog(msg.log ?? [])
        setConnStatus('connected')
      }
    })
    t.onDisconnect(() => {
      if (role === 'host') {
        // ホスト自身のPeerはまだ生きている。ゲストが減っただけなので「待機」に戻す
        setConnStatus((s) => (s === 'idle' ? s : t.hasPeer() ? 'connected' : 'waiting'))
      } else {
        setConnStatus((s) => (s === 'idle' ? s : 'disconnected'))
      }
    })
  }, [])

  const connectHost = useCallback(async () => {
    setConnError(null)
    setConnStatus('connecting')
    const t = new PeerJsTransport()
    try {
      const code = await t.host()
      transportRef.current = t
      hostMetaRef.current = initialHostMeta
      wireTransport(t, 'host')
      setRoomCode(code)
      setMode('host')
      setLocalSeatState('A') // ホスト＝A固定（PHASE2.5.md §2.2）
      setConnStatus('waiting')
    } catch (e) {
      t.destroy()
      setConnError(e instanceof Error ? e.message : String(e))
      setConnStatus('error')
    }
  }, [wireTransport])

  const connectGuest = useCallback(
    async (code: string) => {
      setConnError(null)
      setConnStatus('connecting')
      const t = new PeerJsTransport()
      try {
        await t.join(code)
        transportRef.current = t
        guestSeqRef.current = 0
        wireTransport(t, 'guest')
        setRoomCode(code)
        setMode('guest')
        setLocalSeatState('B') // ゲスト＝B固定（PHASE2.5.md §2.2。役割から自明に導出）
        setConnStatus('connected')
        t.send({ kind: 'hello', role: 'guest', name: 'ゲスト' } satisfies NetMessage)
      } catch (e) {
        t.destroy()
        setConnError(e instanceof Error ? e.message : String(e))
        setConnStatus('error')
      }
    },
    [wireTransport],
  )

  const disconnect = useCallback(() => {
    transportRef.current?.destroy()
    transportRef.current = null
    setMode('solo')
    setConnStatus('idle')
    setRoomCode(null)
    setConnError(null)
    setLocalSeatState('A') // ソロに戻る＝既定のAへ（PHASE2.5.md §2.2）
  }, [])

  return {
    board: history.present,
    log: mode === 'guest' ? remoteLog : visibleLog(history),
    canUndo: mode !== 'guest' && history.past.length > 0,
    canRedo: mode !== 'guest' && history.future.length > 0,
    dispatch,
    undo,
    redo,
    resetBoard,
    mode,
    connStatus,
    connError,
    roomCode,
    connectHost,
    connectGuest,
    disconnect,
    localSeat,
    setLocalSeat,
  }
}

export function newIid(): string {
  return crypto.randomUUID()
}
