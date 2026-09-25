import { useCallback, useEffect, useRef, useState } from 'react'
import { loadLibrary } from '../data/bundle'
import { clearBundle, readBundleMeta } from '../data/db'
import type { AnnotationsMap, BundleMeta, InterruptsMap, PoolCard } from '../data/types'
import { Board } from './board/Board'
import { CardList } from './CardList'
import { DataGate } from './DataGate'
import { DeckView } from './deck/DeckView'

type Phase = 'booting' | 'empty' | 'ready'
type View = 'board' | 'deck' | 'library'

export function App() {
  const [phase, setPhase] = useState<Phase>('booting')
  const [cards, setCards] = useState<PoolCard[]>([])
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map())
  const [annotations, setAnnotations] = useState<AnnotationsMap>({})
  const [interrupts, setInterrupts] = useState<InterruptsMap>({})
  const [cardDefs, setCardDefs] = useState<Record<string, unknown>>({})
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
    setAnnotations(lib.annotations)
    setInterrupts(lib.interrupts)
    setCardDefs(lib.cardDefs)
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
    setAnnotations({})
    setInterrupts({})
    setMeta(null)
    setPhase('empty')
  }, [])

  if (phase === 'booting') {
    return <p className="p-8 text-sm text-ink-muted">読み込んでいます…</p>
  }
  if (phase === 'empty') {
    return <DataGate onLoaded={() => void refresh()} />
  }
  return (
    <div className="flex h-full flex-col">
      <nav className="flex shrink-0 gap-1 border-b border-line bg-surface-0 px-2 pt-2">
        {(['board', 'deck', 'library'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-t px-3 py-1.5 text-xs font-medium ${
              view === v ? 'bg-surface-1 text-ok' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {v === 'board' ? '対戦卓' : v === 'deck' ? 'デッキ' : 'カード一覧'}
          </button>
        ))}
      </nav>
      <div className="relative min-h-0 flex-1">
        {/* 🚨 Boardは常にマウントしたまま非表示のときはCSSで隠す（タブ切替でPeerJSの接続を切らない。
            DESIGN.md §4.21・PHASE5a.md §1）。デッキ/カード一覧は今までどおり切り替えでよい。
            🚨 display:none（hidden）にしない: 隠している間に窓の大きさが変わると、戻したときに
            ResizeObserver が発火せずマスの大きさが古い値のまま固まる（統括7が実測）。
            invisible＝レイアウトは保つので、隠れている間も行の高さの計測が生き続ける */}
        <div
          className={`absolute inset-0 ${view === 'board' ? '' : 'pointer-events-none invisible'}`}
          aria-hidden={view !== 'board'}
        >
          <Board cards={cards} imageUrls={imageUrls} annotations={annotations} interrupts={interrupts} cardDefs={cardDefs} />
        </div>
        {view === 'deck' && (
          <div className="absolute inset-0">
            <DeckView cards={cards} imageUrls={imageUrls} />
          </div>
        )}
        {view === 'library' && (
          <div className="absolute inset-0">
            <CardList cards={cards} imageUrls={imageUrls} meta={meta} onReset={() => void reset()} />
          </div>
        )}
      </div>
    </div>
  )
}
