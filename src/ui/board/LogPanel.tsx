import type { LogEntry } from '../../core/history'

export function LogPanel({
  log,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClearBoard,
  showUndoRedo = true,
}: {
  log: LogEntry[]
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onClearBoard: () => void
  /** 接続中はゲスト側で隠す（DESIGN.md §6・PHASE2.md §4: Undo/Redoはホストのみ） */
  showUndoRedo?: boolean
}) {
  return (
    <div className="flex h-40 flex-col gap-1.5 border-t border-slate-800 bg-slate-950/80 p-2">
      <div className="flex items-center gap-2">
        {showUndoRedo && (
          <>
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              className="rounded border border-slate-600 px-2 py-1 text-xs disabled:opacity-30"
            >
              ↶ Undo
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              className="rounded border border-slate-600 px-2 py-1 text-xs disabled:opacity-30"
            >
              ↷ Redo
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onClearBoard}
          className="ml-auto rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-red-800 hover:text-red-300"
        >
          盤面クリア
        </button>
      </div>
      <div className="flex-1 overflow-y-auto rounded border border-slate-800 bg-slate-900/60 px-2 py-1 font-mono text-[11px] leading-relaxed text-slate-400">
        {log.length === 0 ? (
          <p className="text-slate-600">ログはまだありません</p>
        ) : (
          [...log].reverse().map((entry) => <div key={entry.id}>{entry.text}</div>)
        )}
      </div>
    </div>
  )
}
