import { useMemo, useState } from 'react'
import { ATTRS, CARD_KINDS, CARD_KIND_LABEL, type Attr, type CardKind } from '../core/types'
import { searchKey } from '../core/name'
import type { BundleMeta, PoolCard } from '../data/types'
import { CardTile } from './CardTile'

export function CardList({
  cards,
  imageUrls,
  meta,
  onReset,
}: {
  cards: PoolCard[]
  imageUrls: Map<string, string>
  meta: BundleMeta | null
  onReset: () => void
}) {
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<Set<CardKind>>(new Set())
  const [attr, setAttr] = useState<Attr | ''>('')

  const visible = useMemo(() => {
    const q = searchKey(query)
    return cards.filter((c) => {
      if (kinds.size > 0 && !kinds.has(c.kind)) return false
      if (attr && !c.attr.includes(attr)) return false
      if (q && !searchKey(c.name).includes(q) && !searchKey(c.kana).includes(q)) return false
      return true
    })
  }, [cards, query, kinds, attr])

  function toggleKind(k: CardKind) {
    setKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const withImage = visible.filter((c) => imageUrls.has(c.id)).length

  return (
    <div className="mx-auto h-full max-w-[1600px] overflow-y-auto p-4">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">カード一覧</h1>
          <p className="text-xs text-slate-500">
            {visible.length} / {cards.length} 種を表示（うち画像あり {withImage}）
            {meta && ` ・ プール ${meta.poolSets.length} セット`}
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 transition hover:border-red-800 hover:text-red-300"
        >
          データを削除して読み込み直す
        </button>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="カード名・かなで検索"
          className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-emerald-600"
        />

        <div className="flex flex-wrap gap-1">
          {CARD_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                kinds.has(k)
                  ? 'border-emerald-500 bg-emerald-600/20 text-emerald-300'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {CARD_KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <select
          value={attr}
          onChange={(e) => setAttr(e.target.value as Attr | '')}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-emerald-600"
        >
          <option value="">属性すべて</option>
          {ATTRS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <p className="py-20 text-center text-sm text-slate-500">該当するカードがありません。</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {visible.map((card) => (
            <CardTile key={card.id} card={card} imageUrl={imageUrls.get(card.id)} />
          ))}
        </div>
      )}
    </div>
  )
}
