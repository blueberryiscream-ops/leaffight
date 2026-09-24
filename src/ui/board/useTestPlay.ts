/// <reference types="vite/client" />
import { useEffect, useRef } from 'react'
import type { ConnMode, ConnStatus } from './useBoard'

// テストプレイ用の自動接続（ひとりで2窓を開いて遊ぶとき用・デスクトップのショートカットから起動）。
// URL に ?testplay=host / ?testplay=guest が付いているときだけ動く。開発サーバー（npm run dev）限定。
// ホストは自動で部屋を作り、ルームコードを同じブラウザ内の BroadcastChannel で流す。
// ゲストはそれを受け取って自動で参加する（コードの手入力が要らない）。対戦相手が別PCの本番の接続には関わらない。

export type TestPlayRole = 'host' | 'guest'

export function testPlayRole(): TestPlayRole | null {
  if (!import.meta.env.DEV) return null
  const v = new URLSearchParams(window.location.search).get('testplay')
  return v === 'host' || v === 'guest' ? v : null
}

type Msg = { kind: 'ask' } | { kind: 'code'; code: string }

export function useTestPlay({
  mode,
  connStatus,
  roomCode,
  onHost,
  onJoin,
}: {
  mode: ConnMode
  connStatus: ConnStatus
  roomCode: string | null
  onHost: () => void
  onJoin: (code: string) => void
}) {
  const role = testPlayRole()
  const started = useRef(false)
  const joinedCode = useRef<string | null>(null)
  const latest = useRef({ mode, connStatus, roomCode, onHost, onJoin })
  latest.current = { mode, connStatus, roomCode, onHost, onJoin }

  // ホスト: 起動したら1回だけ部屋を作る
  useEffect(() => {
    if (role !== 'host' || started.current) return
    if (mode === 'solo' && connStatus === 'idle') {
      started.current = true
      onHost()
    }
  }, [role, mode, connStatus, onHost])

  // ルームコードの受け渡し
  useEffect(() => {
    if (!role || typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel('lf-testplay')
    const send = (m: Msg) => ch.postMessage(m)

    ch.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data
      const cur = latest.current
      if (role === 'host' && m.kind === 'ask' && cur.mode === 'host' && cur.roomCode) {
        send({ kind: 'code', code: cur.roomCode })
      }
      // ゲストは、ソロのとき（未接続）か、ホストが開き直して部屋のコードが変わったときに参加し直す
      if (role === 'guest' && m.kind === 'code' && m.code !== joinedCode.current && cur.connStatus !== 'connecting') {
        if (cur.mode === 'solo' || cur.connStatus === 'disconnected') {
          joinedCode.current = m.code
          cur.onJoin(m.code)
        }
      }
    }

    // ゲストはコードが来るまで1秒ごとに尋ねる。ホストは部屋ができたら一度流す
    const timer =
      role === 'guest'
        ? window.setInterval(() => {
            const cur = latest.current
            if (cur.mode === 'solo' || cur.connStatus === 'disconnected') send({ kind: 'ask' })
          }, 1000)
        : undefined
    if (role === 'host' && latest.current.roomCode) send({ kind: 'code', code: latest.current.roomCode })

    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      ch.close()
    }
  }, [role, roomCode])
}
