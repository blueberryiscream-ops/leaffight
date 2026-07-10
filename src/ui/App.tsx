import { useCallback, useEffect, useRef, useState } from 'react'
import { loadLibrary } from '../data/bundle'
import { clearBundle, readBundleMeta } from '../data/db'
import type { BundleMeta, PoolCard } from '../data/types'
import { CardList } from './CardList'
import { DataGate } from './DataGate'

type Phase = 'booting' | 'empty' | 'ready'

export function App() {
  const [phase, setPhase] = useState<Phase>('booting')
  const [cards, setCards] = useState<PoolCard[]>([])
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map())
  const [meta, setMeta] = useState<BundleMeta | null>(null)

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
  return <CardList cards={cards} imageUrls={imageUrls} meta={meta} onReset={() => void reset()} />
}
