import { useState } from 'react'
import type { ConnMode, ConnStatus } from './useBoard'

const STATUS_LABEL: Record<ConnStatus, string> = {
  idle: '未接続',
  connecting: '接続中…',
  waiting: 'ゲスト待ち',
  connected: '接続済み',
  disconnected: '切断',
  error: 'エラー',
}

const STATUS_COLOR: Record<ConnStatus, string> = {
  idle: 'text-slate-500',
  connecting: 'text-amber-400',
  waiting: 'text-amber-400',
  connected: 'text-emerald-400',
  disconnected: 'text-red-400',
  error: 'text-red-400',
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
  const busy = connStatus === 'connecting'

  return (
    <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-950/60 px-3 py-1.5 text-xs">
      <span className={`font-semibold ${STATUS_COLOR[connStatus]}`}>● {STATUS_LABEL[connStatus]}</span>

      {mode === 'solo' && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onHost}
            className="rounded border border-emerald-700 px-2 py-1 text-emerald-400 hover:bg-emerald-950 disabled:opacity-40"
          >
            ホストで開始
          </button>
          <span className="text-slate-600">|</span>
          <input
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            placeholder="ルームコード"
            maxLength={6}
            className="w-24 rounded border border-slate-600 bg-slate-800 px-2 py-1 uppercase tracking-widest outline-none"
          />
          <button
            type="button"
            disabled={busy || codeInput.length < 4}
            onClick={() => onJoin(codeInput.trim())}
            className="rounded border border-sky-700 px-2 py-1 text-sky-400 hover:bg-sky-950 disabled:opacity-40"
          >
            コードで参加
          </button>
        </>
      )}

      {mode === 'host' && roomCode && (
        <>
          <span className="text-slate-400">
            ルームコード:{' '}
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(roomCode)}
              className="rounded bg-slate-800 px-2 py-0.5 font-mono text-sm tracking-widest text-emerald-300 hover:bg-slate-700"
              title="クリックでコピー"
            >
              {roomCode}
            </button>
          </span>
          <button type="button" onClick={onDisconnect} className="ml-auto rounded border border-slate-700 px-2 py-1 text-slate-400 hover:border-red-800 hover:text-red-300">
            切断
          </button>
        </>
      )}

      {mode === 'guest' && (
        <>
          <span className="text-slate-500">相手: {roomCode}</span>
          {connStatus === 'disconnected' && (
            <button
              type="button"
              onClick={() => roomCode && onJoin(roomCode)}
              className="rounded border border-sky-700 px-2 py-1 text-sky-400 hover:bg-sky-950"
            >
              再接続
            </button>
          )}
          <button type="button" onClick={onDisconnect} className="ml-auto rounded border border-slate-700 px-2 py-1 text-slate-400 hover:border-red-800 hover:text-red-300">
            切断
          </button>
        </>
      )}

      {connError && <span className="text-red-400">{connError}</span>}
    </div>
  )
}
