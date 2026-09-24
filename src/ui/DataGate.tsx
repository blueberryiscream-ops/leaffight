import { useRef, useState } from 'react'
import { importBundle } from '../data/bundle'

// 初回起動画面。カードデータはリポジトリに入っていないので（権利面。DESIGN.md §7.5）、
// ユーザーが手元の leaffight-data.zip を選ぶところから始まる。

export function DataGate({ onLoaded }: { onLoaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    setError(null)
    try {
      const meta = await importBundle(file, setStatus)
      setStatus(`カード ${meta.cardCount} 種 / 画像 ${meta.imageCount} 枚 を保存しました`)
      onLoaded()
    } catch (e) {
      setStatus(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const busy = status !== null && error === null

  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center gap-6 p-8">
      <header>
        <h1 className="text-2xl font-bold">リーフファイト対戦ツール</h1>
        <p className="mt-1 text-sm text-ink-muted">ver.1〜3 プール</p>
      </header>

      <div className="rounded-xl border border-line-strong bg-surface-1/60 p-6">
        <p className="text-sm leading-relaxed text-ink">
          カードデータと画像はこのアプリに含まれていません。
          手元の <code className="rounded bg-surface-2 px-1 py-0.5">leaffight-data.zip</code> を
          読み込んでください。中身はこのブラウザの中にだけ保存され、次回からは自動で読み込まれます。
        </p>

        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="mt-5 w-full rounded-lg bg-ok px-4 py-3 font-semibold text-on-accent transition hover:bg-ok/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          データファイルを読み込む
        </button>

        {status && <p className="mt-4 text-sm text-ok">{status}</p>}
        {error && (
          <p className="mt-4 rounded-lg border border-danger/60 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>

      <p className="text-xs leading-relaxed text-ink-muted">
        ZIPは <code>npm run data:bundle</code> でローカルに生成できます（開発者向け）。
      </p>
    </div>
  )
}
