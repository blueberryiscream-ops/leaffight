import { useState } from 'react'
import type { ConnMode, ConnStatus } from './useBoard'
import { useTestPlay } from './useTestPlay'

const STATUS_LABEL: Record<ConnStatus, string> = {
  idle: '未接続',
  connecting: '接続中…',
  waiting: 'ゲスト待ち',
  connected: '接続済み',
  disconnected: '切断',
  error: 'エラー',
}

const STATUS_COLOR: Record<ConnStatus, string> = {
  idle: 'text-ink-muted',
  connecting: 'text-warn',
  waiting: 'text-warn',
  connected: 'text-ok',
  disconnected: 'text-danger',
  error: 'text-danger',
}

// 接続UI（PHASE2.md §4「最小でよい」）。ホストで開始／コードで参加／状態表示。

export function ConnectionPanel({
  mode,
  connStatus,
  connError,
  roomCode,
  onHost,
  onJoin,
  onDisconnect,
}: {
  mode: ConnMode
  connStatus: ConnStatus
  connError: string | null
  roomCode: string | null
  onHost: () => void
  onJoin: (code: string) => void
  onDisconnect: () => void
}) {
  const [codeInput, setCodeInput] = useState('')
  useTestPlay({ mode, connStatus, roomCode, onHost, onJoin })
  const busy = connStatus === 'connecting'

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`font-semibold ${STATUS_COLOR[connStatus]}`}>● {STATUS_LABEL[connStatus]}</span>

      {mode === 'solo' && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onHost}
            className="rounded border border-ok px-2 py-1 text-ok hover:bg-ok/15 disabled:opacity-40"
          >
            ホストで開始
          </button>
          <span className="text-ink-faint">|</span>
          <input
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            placeholder="ルームコード"
            maxLength={6}
            className="w-24 rounded border border-line-strong bg-surface-2 px-2 py-1 uppercase tracking-widest outline-none"
          />
          <button
            type="button"
            disabled={busy || codeInput.length < 4}
            onClick={() => onJoin(codeInput.trim())}
            className="rounded border border-accent px-2 py-1 text-accent hover:bg-accent/15 disabled:opacity-40"
          >
            コードで参加
          </button>
        </>
      )}

      {mode === 'host' && roomCode && (
        <>
          <span className="text-ink-muted">
            ルームコード:{' '}
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(roomCode)}
              className="rounded bg-surface-2 px-2 py-0.5 font-mono text-sm tracking-widest text-ok hover:bg-surface-3"
              title="クリックでコピー"
            >
              {roomCode}
            </button>
          </span>
          <button type="button" onClick={onDisconnect} className="ml-auto rounded border border-line-strong px-2 py-1 text-ink-muted hover:border-danger hover:text-danger">
            切断
          </button>
        </>
      )}

      {mode === 'guest' && (
        <>
          <span className="text-ink-muted">相手: {roomCode}</span>
          {connStatus === 'disconnected' && (
            <button
              type="button"
              onClick={() => roomCode && onJoin(roomCode)}
              className="rounded border border-accent px-2 py-1 text-accent hover:bg-accent/15"
            >
              再接続
            </button>
          )}
          <button type="button" onClick={onDisconnect} className="ml-auto rounded border border-line-strong px-2 py-1 text-ink-muted hover:border-danger hover:text-danger">
            切断
          </button>
        </>
      )}

      {connError && <span className="text-danger">{connError}</span>}
    </div>
  )
}
