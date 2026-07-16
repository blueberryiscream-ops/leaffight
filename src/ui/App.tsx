import { useCallback, useEffect, useRef, useState } from 'react'
import { loadLibrary } from '../data/bundle'
import { clearBundle, readBundleMeta } from '../data/db'
import type { BundleMeta, PoolCard } from '../data/types'
import { Board } from './board/Board'
import { CardList } from './CardList'
import { DataGate } from './DataGate'

type Phase = 'booting' | 'empty' | 'ready'
type View = 'board' | 'library'

export function App() {
  const [phase, setPhase] = useState<Phase>('booting')
  const [cards, setCards] = useState<PoolCard[]>([])
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map())
  const [meta, setMeta] = useState<BundleMeta | null>(null)
  const [view, setView] = useState<View>('board')

  // 画像は Blob URL なので、使い終わったら必ず revoke する。
  // useState の更新関数の中で revoke してはいけない（React は更新関数を2回呼ぶことがあり、
  // 読み込みが競合すると生きている URL を消してしまう）。ref で「今使っている URL」を持つ。
  const urlsRef = useRef<Map<string, string>>(new Map())
  const generation = useRef(0)

  const revoke = (urls: Iterable<string>) => {
    for (const url of urls) URL.revokeObjectURL(url)
  }

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    const saved = await readBundleMeta()
    if (!saved) {
      if (gen === generation.current) setPhase('empty')
      return
    }
    const lib = await loadLibrary()
    if (gen !== generation.current) {
      // 追い越された。今作った URL は誰も使わないので捨てる
      revoke(lib.imageUrls.values())
      return
    }
    revoke(urlsRef.current.values())
    urlsRef.current = lib.imageUrls
    setImageUrls(lib.imageUrls)
    setCards(lib.cards)
    setMeta(saved)
    setPhase('ready')
  }, [])

  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
      revoke(urlsRef.current.values())
      urlsRef.current = new Map()
    }
  }, [refresh])

  const reset = useCallback(async () => {
    if (!confirm('保存したカードデータを削除します。よろしいですか？')) return
    generation.current++
    await clearBundle()
    revoke(urlsRef.current.values())
    urlsRef.current = new Map()
    setImageUrls(new Map())
    setCards([])
    setMeta(null)
    setPhase('empty')
  }, [])

  if (phase === 'booting') {
    return <p className="p-8 text-sm text-slate-500">読み込んでいます…</p>
  }
  if (phase === 'empty') {
    return <DataGate onLoaded={() => void refresh()} />
  }
  return (
    <div className="flex h-full flex-col">
      <nav className="flex shrink-0 gap-1 border-b border-slate-800 bg-slate-950 px-2 pt-2">
        {(['board', 'library'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-t px-3 py-1.5 text-xs font-medium ${
              view === v ? 'bg-slate-900 text-emerald-400' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {v === 'board' ? '対戦卓' : 'カード一覧'}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {view === 'board' ? (
          <Board cards={cards} imageUrls={imageUrls} />
        ) : (
          <CardList cards={cards} imageUrls={imageUrls} meta={meta} onReset={() => void reset()} />
        )}
      </div>
    </div>
  )
}
