import { useRef, useState } from 'react'
import type { PoolCard } from '../../data/types'

// デッキ画面のモーダル3つ（見本 `_local/デッキ構築の雛形.html`）。
// 取り込み（インポート）は見本に無い「足すもの」（PHASE5a.md §4）。

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-20 grid place-items-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-[860px] rounded-lg p-4 lf-panel">{children}</div>
    </div>
  )
}

export function DrawModal({
  hand,
  hasChar,
  imageUrls,
  onRedraw,
  onClose,
}: {
  hand: PoolCard[]
  hasChar: boolean
  imageUrls: Map<string, string>
  onRedraw: () => void
  onClose: () => void
}) {
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-center justify-between">
        <b>試しに7枚引く（リーダーを抜いてシャッフル→7枚）</b>
        <button type="button" className="rounded border border-line-strong px-2.5 py-1 text-xs" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="my-3 flex flex-wrap justify-center gap-2.5">
        {hand.map((c, i) => {
          const url = imageUrls.get(c.id)
          return (
            <div key={i} title={c.name} className="w-[100px] overflow-hidden rounded-md lf-card-rim">
              <div className="aspect-[63/88] bg-cover bg-center" style={url ? { backgroundImage: `url(${url})` } : { backgroundColor: 'var(--color-surface-0)' }}>
                {!url && <div className="flex h-full items-center justify-center p-1 text-center text-[10px] text-ink-muted">{c.name}</div>}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <span>
          {hasChar ? (
            <span className="text-ink-muted">キャラあり＝この手でスタート</span>
          ) : (
            <b className="text-warn">キャラが1枚も無い＝マリガンできる手（全部引き直し1回）</b>
          )}
        </span>
        <button type="button" className="rounded px-3 py-1.5 text-sm font-bold lf-btn-primary" onClick={onRedraw}>
          もう一度
        </button>
      </div>
    </ModalShell>
  )
}

export function ExportModal({ text, onClose }: { text: string; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-center justify-between">
        <b>書き出し（このまま友人に貼って渡せる・取り込みも同じ形）</b>
        <button type="button" className="rounded border border-line-strong px-2.5 py-1 text-xs" onClick={onClose}>
          閉じる
        </button>
      </div>
      <p className="text-ink-muted">1行＝「枚数 カード名」。先頭の「リーダー:」行でリーダーを指定。</p>
      <textarea
        ref={ref}
        readOnly
        value={text}
        className="h-56 w-full rounded-md border border-line-strong bg-surface-0 p-2 font-mono text-xs"
      />
      <button
        type="button"
        className="mt-2 rounded border border-line-strong px-2.5 py-1 text-xs"
        onClick={() => ref.current?.select()}
      >
        全選択
      </button>
    </ModalShell>
  )
}

export function ImportModal({ onClose, onImport }: { onClose: () => void; onImport: (text: string) => void }) {
  const [text, setText] = useState('')
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-center justify-between">
        <b>テキストから取り込む</b>
        <button type="button" className="rounded border border-line-strong px-2.5 py-1 text-xs" onClick={onClose}>
          閉じる
        </button>
      </div>
      <p className="text-ink-muted">書き出しと同じ形（「リーダー: 名前」／「# 種類」の見出し／「枚数 カード名」）を貼り付けてください。</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="h-56 w-full rounded-md border border-line-strong bg-surface-0 p-2 font-mono text-xs"
        placeholder={'リーダー: 名前\n# デッキ名\n\n# キャラ\n4 カード名'}
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className="rounded px-3 py-1.5 text-sm font-bold lf-btn-primary"
          onClick={() => onImport(text)}
        >
          取り込む
        </button>
      </div>
    </ModalShell>
  )
}
