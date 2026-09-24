import { useEffect, useMemo, useState } from 'react'
import { CARD_KINDS, CARD_KIND_LABEL, type CardKind } from '../../core/types'
import { deleteDeck, listDecks, saveDeck } from '../../data/db'
import { deckTotal, parseDeckText, type Deck } from '../../data/deck'
import type { PoolCard } from '../../data/types'
import { DeckEditor } from './DeckEditor'
import { ImportModal } from './modals'

// デッキ画面の入口（DESIGN.md §4.21・PHASE5a.md §4）。
// 一覧⇔編集の画面遷移と、保存済みデッキの読み書き（Dexie）をここで持つ。
// 編集中の値そのものは DeckEditor に作業コピーとして渡し、保存/取り消しはここで確定する。

const KIND_COLOR: Record<CardKind, string> = {
  c: 'bg-kind-c',
  t: 'bg-kind-t',
  b: 'bg-kind-b',
  i: 'bg-kind-i',
  e: 'bg-kind-e',
  f: 'bg-kind-f',
}

function formatUpdatedAt(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000))
  if (days <= 0) return '今日'
  if (days === 1) return '1日前'
  if (days < 7) return `${days}日前`
  if (days < 14) return '1週間前'
  return `${Math.floor(days / 7)}週間前`
}

export function DeckView({ cards, imageUrls }: { cards: PoolCard[]; imageUrls: Map<string, string> }) {
  const [decks, setDecks] = useState<Deck[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingImport, setPendingImport] = useState<Deck | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [autoOpenExport, setAutoOpenExport] = useState(false)

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])

  useEffect(() => {
    void listDecks().then((d) => {
      setDecks(d)
      setLoaded(true)
    })
  }, [])

  function newDeck(): Deck {
    return { id: crypto.randomUUID(), name: 'まだ名前のないデッキ', leaderCardId: null, counts: {}, updatedAt: Date.now() }
  }

  function openNewDeck() {
    const d = newDeck()
    setPendingImport(d)
    setEditingId(d.id)
    setAutoOpenExport(false)
  }

  function openImport(text: string) {
    const { deck, errors } = parseDeckText(text, cards)
    setImportErrors(errors)
    const full: Deck = {
      id: crypto.randomUUID(),
      name: deck.name || 'まだ名前のないデッキ',
      leaderCardId: deck.leaderCardId,
      counts: deck.counts,
      updatedAt: Date.now(),
    }
    setPendingImport(full)
    setImportOpen(false)
    setEditingId(full.id)
    setAutoOpenExport(false)
  }

  function openEdit(id: string, exportImmediately = false) {
    setPendingImport(null)
    setEditingId(id)
    setAutoOpenExport(exportImmediately)
  }

  async function duplicate(deck: Deck) {
    const copy: Deck = { ...deck, id: crypto.randomUUID(), name: `${deck.name}（コピー）`, updatedAt: Date.now() }
    await saveDeck(copy)
    setDecks(await listDecks())
  }

  async function handleDelete(id: string) {
    await deleteDeck(id)
    setDecks(await listDecks())
    setEditingId(null)
    setPendingImport(null)
  }

  async function handleSave(deck: Deck) {
    const toSave: Deck = { ...deck, updatedAt: Date.now() }
    await saveDeck(toSave)
    setDecks(await listDecks())
    setPendingImport(null)
    return toSave
  }

  const editingDeck = editingId ? (pendingImport && pendingImport.id === editingId ? pendingImport : decks.find((d) => d.id === editingId)) : undefined

  if (!loaded) {
    return <p className="p-8 text-sm text-ink-muted">読み込んでいます…</p>
  }

  if (editingId && editingDeck) {
    return (
      <div className="h-full overflow-y-auto">
        <DeckEditor
          key={editingDeck.id}
          deck={editingDeck}
          isNew={!decks.some((d) => d.id === editingDeck.id)}
          cards={cards}
          cardById={cardById}
          imageUrls={imageUrls}
          importErrors={pendingImport?.id === editingDeck.id ? importErrors : []}
          autoOpenExport={autoOpenExport}
          onSave={handleSave}
          onDelete={handleDelete}
          onBack={() => {
            setEditingId(null)
            setPendingImport(null)
            setAutoOpenExport(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3.5">
        {decks.map((d) => {
          const total = deckTotal(d)
          const leader = d.leaderCardId ? cardById.get(d.leaderCardId) : undefined
          const leaderImg = leader ? imageUrls.get(leader.id) : undefined
          const ok = total === 60
          return (
            <div key={d.id} className="flex flex-col overflow-hidden rounded-lg lf-panel">
              <div className="relative h-[120px] bg-surface-0 bg-cover bg-[position:center_18%]" style={leaderImg ? { backgroundImage: `url(${leaderImg})` } : undefined}>
                {!leaderImg && (
                  <div className="flex h-full items-center justify-center text-xs text-ink-faint">
                    {leader ? leader.name : 'リーダー未選択'}
                  </div>
                )}
                <span
                  className={`absolute right-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-extrabold ${
                    ok ? 'bg-ok text-on-accent' : 'bg-warn text-on-accent'
                  }`}
                >
                  {ok ? '60/60 ✓' : `${total}/60`}
                </span>
              </div>
              <div className="grid gap-1.5 p-2.5">
                <div className="text-sm font-extrabold">{d.name}</div>
                <div className="text-[11.5px] text-ink-muted">
                  リーダー: {leader?.name ?? '（未選択）'}・{formatUpdatedAt(d.updatedAt)}
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-sm bg-surface-0">
                  {CARD_KINDS.map((k) => {
                    const n = cards.filter((c) => c.kind === k && (d.counts[c.id] ?? 0) > 0).reduce((a, c) => a + (d.counts[c.id] ?? 0), 0)
                    if (n === 0 || total === 0) return null
                    return <div key={k} className={KIND_COLOR[k]} style={{ width: `${(n / total) * 100}%` }} />
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className="flex-1 rounded px-1.5 py-1 text-xs lf-btn-primary" onClick={() => openEdit(d.id)}>
                    編集
                  </button>
                  <button type="button" className="flex-1 rounded border border-line-strong px-1.5 py-1 text-xs" onClick={() => void duplicate(d)}>
                    複製
                  </button>
                  <button
                    type="button"
                    className="flex-1 rounded border border-line-strong px-1.5 py-1 text-xs"
                    onClick={() => openEdit(d.id, true)}
                  >
                    書き出し
                  </button>
                </div>
              </div>
            </div>
          )
        })}
        <div className="grid min-h-[230px] cursor-pointer place-items-center rounded-lg border-2 border-dashed border-line-strong bg-white/5 text-center font-bold text-ink-muted" onClick={openNewDeck}>
          <div>
            ＋ 新しいデッキ
            <br />
            <button
              type="button"
              className="mt-1 text-xs font-normal text-accent underline"
              onClick={(e) => {
                e.stopPropagation()
                setImportOpen(true)
              }}
            >
              テキストから取り込むこともできる
            </button>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2.5 text-[11.5px] text-ink-muted">
        {CARD_KINDS.map((k) => (
          <span key={k}>
            <i className={`mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px] ${KIND_COLOR[k]}`} />
            {CARD_KIND_LABEL[k]}
          </span>
        ))}
      </div>
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)} onImport={openImport} />
      )}
    </div>
  )
}
