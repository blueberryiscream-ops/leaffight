import type { LogEntry } from '../../core/history'

// ログ（左列・縦長。DESIGN.md §4.18）。読むもの・流れるものなのでスクロールしてよい
// （盤面本体はスクロール禁止だが、ログと詳細パネルはPHASE2.6.md §4の例外）。

export function LogPanel({ log }: { log: LogEntry[] }) {
  return (
    <div className="lf-panel flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1 font-mono text-[11px] leading-relaxed text-ink-muted">
      {log.length === 0 ? (
        <p className="text-ink-faint">ログはまだありません</p>
      ) : (
        [...log].reverse().map((entry) => <div key={entry.id}>{entry.text}</div>)
      )}
    </div>
  )
}
