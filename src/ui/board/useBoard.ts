import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import { EMPTY_BOARD, type Seat } from '../../core/board'
import { emptyHistory, dispatch as dispatchHistory, redo as redoHistory, undo as undoHistory, visibleLog, type History } from '../../core/history'
import { readBoardState, writeBoardState } from '../../data/db'
import { PeerJsTransport } from '../../net/PeerJsTransport'
import { applyGuestAction, applyRemoteState, bumpForBroadcast, helloReply, initialHostMeta, type HostMeta, type NetMessage } from '../../net/session'

let logSeq = 0
const nextLogId = () => `log_${++logSeq}_${Date.now()}`

export type ConnMode = 'solo' | 'host' | 'guest'
export type ConnStatus = 'idle' | 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error'

export const otherSeat = (s: Seat): Seat => (s === 'A' ? 'B' : 'A')

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
        // EMPTY_BOARD のデフォルト（priority:null, mode:'assist'）で補完してから復元する。
        // これをしないと StackPanel が undefined な priority を読んでクラッシュする。
        setHistory((h) => ({ ...h, present: { ...EMPTY_BOARD, ...saved } }))
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
          const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, hostMetaRef.current.lastSeq)
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
        const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, hostMetaRef.current.lastSeq)
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
        const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, hostMetaRef.current.lastSeq)
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
            t.send(helloReply(hostMetaRef.current, prev.present))
            return prev
          })
          setConnStatus('connected')
          return
        }
        if (msg.kind === 'action') {
          setHistory((prev) => {
            const next = applyGuestAction(prev, msg.action, nextLogId())
            if (next.present !== prev.present) {
              const { meta, message } = bumpForBroadcast(hostMetaRef.current, next.present, msg.seq)
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
    log: visibleLog(history),
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
