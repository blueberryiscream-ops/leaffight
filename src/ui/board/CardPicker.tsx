import { useMemo, useState } from 'react'
import { searchKey } from '../../core/name'
import type { Seat, ZoneId } from '../../core/board'
import { CARD_KINDS, CARD_KIND_LABEL, type CardKind } from '../../core/types'
import type { PoolCard } from '../../data/types'
import { otherSeat } from './useBoard'

// P0のカード一覧を「ピッカー」として使う（PHASE1.md §3.2）。
// クリックで選択中の 持ち主/ゾーン に1枚スポーンする。
// 「自分/相手」の割り当てはmySeat基準（PHASE2.5.md §2.3。以前は'me'決め打ちだったのを解消）。

function targetZones(mySeat: Seat): { owner: Seat; zone: ZoneId; label: string }[] {
  const theirs = otherSeat(mySeat)
  return [
    { owner: mySeat, zone: 'deck', label: '自分のデッキ' },
    { owner: mySeat, zone: 'hand', label: '自分の手札' },
    { owner: mySeat, zone: 'leader', label: '自分のリーダー' },
    { owner: theirs, zone: 'deck', label: '相手のデッキ' },
    { owner: theirs, zone: 'hand', label: '相手の手札' },
    { owner: theirs, zone: 'leader', label: '相手のリーダー' },
  ]
}

export function CardPicker({
  cards,
  mySeat,
  onPick,
  onClose,
}: {
  cards: PoolCard[]
  mySeat: Seat
  onPick: (card: PoolCard, owner: Seat, zone: ZoneId) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<CardKind | ''>('')
  const [targetIdx, setTargetIdx] = useState(0)
  const TARGET_ZONES = useMemo(() => targetZones(mySeat), [mySeat])

  const visible = useMemo(() => {
    const q = searchKey(query)
    return cards.filter((c) => {
      if (kind && c.kind !== kind) return false
      if (q && !searchKey(c.name).includes(q) && !searchKey(c.kana).includes(q)) return false
      return true
    })
  }, [cards, query, kind])

  const target = TARGET_ZONES[targetIdx]

  return (
    <div className="fixed inset-y-0 right-0 z-20 flex w-80 flex-col gap-2 border-l border-slate-700 bg-slate-950 p-3 shadow-2xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-100">カードを追加</h2>
        <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200">
          ✕
        </button>
      </div>

      <select
        value={targetIdx}
        onChange={(e) => setTargetIdx(Number(e.target.value))}
        className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs"
      >
        {TARGET_ZONES.map((t, i) => (
          <option key={i} value={i}>
            置き先: {t.label}
          </option>
        ))}
      </select>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="カード名・かなで検索"
        className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs outline-none placeholder:text-slate-600"
      />

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setKind('')}
          className={`rounded-full border px-2 py-0.5 text-[10px] ${kind === '' ? 'border-emerald-500 text-emerald-300' : 'border-slate-700 text-slate-400'}`}
        >
          すべて
        </button>
        {CARD_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`rounded-full border px-2 py-0.5 text-[10px] ${kind === k ? 'border-emerald-500 text-emerald-300' : 'border-slate-700 text-slate-400'}`}
          >
            {CARD_KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <p className="text-[10px] text-slate-500">{visible.length} 種 ・ クリックで「{target.label}」に1枚追加</p>

      <ul className="flex-1 overflow-y-auto rounded border border-slate-800">
        {visible.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c, target.owner, target.zone)}
              className="flex w-full items-center justify-between gap-2 border-b border-slate-800 px-2 py-1.5 text-left text-xs hover:bg-slate-800"
            >
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 text-[9px] text-slate-500">{CARD_KIND_LABEL[c.kind]}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
