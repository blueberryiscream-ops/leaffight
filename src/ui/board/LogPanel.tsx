import type { LogEntry } from '../../core/history'
import { foldLog } from '../engine/host'

// ログ（左列・縦長。DESIGN.md §4.18）。読むもの・流れるものなのでスクロールしてよい
// （盤面本体はスクロール禁止だが、ログと詳細パネルはPHASE2.6.md §4の例外）。
// R2u §2-4: エンジンが進めた段は、要求の1行の下に1段1行で出す（stepText が iid を公開の名前か「＊」にする）。
// R2u-2: 自動の見送り（鳴き無しボタン）が続いたら「自動で見送り ×N」の1行に畳む（段はその下にまとめて出す）。

export function LogPanel({ log, stepText }: { log: LogEntry[]; stepText?: (s: { text: string; iids: string[] }) => string }) {
  const rows = foldLog(log)
  return (
    <div className="lf-panel flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1 font-mono text-[11px] leading-relaxed text-ink-muted">
      {rows.length === 0 ? (
        <p className="text-ink-faint">ログはまだありません</p>
      ) : (
        [...rows].reverse().map((row) => (
          <div key={row.key}>
            <div>{row.text}</div>
            {stepText &&
              row.steps.map((s, i) => (
                <div key={i} className="pl-2 text-[10px] text-ink-faint">
                  └ {stepText(s)}
                </div>
              ))}
          </div>
        ))
      )}
    </div>
  )
}
