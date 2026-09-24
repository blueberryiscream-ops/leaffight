import { useEffect, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import { maxKiryokuFor, type Seat } from '../../core/board'
import type { Card } from '../../core/types'
import { listDecks } from '../../data/db'
import { shuffle, validateDeck, type Deck } from '../../data/deck'

// 「デッキで始める」ダイアログ（DESIGN.md §4.21「対戦卓での使用」・PHASE5b.md §2-1）。
// 自分のデッキ一覧から1つ選ぶと、開始準備（10-1 [1]〜[4]）を1回の操作で行う。
// 🚨 乱数（シャッフル）はここ（ui）で消費し、core へは結果の並びだけを渡す。

function newIid(): string {
  return crypto.randomUUID()
}

export function StartWithDeckDialog({
  cardById,
  mySeat,
  hasOwnCards,
  dispatch,
  onClose,
}: {
  cardById: Map<string, Card>
  mySeat: Seat
  hasOwnCards: boolean
  dispatch: (action: BoardAction) => void
  onClose: () => void
}) {
  const [decks, setDecks] = useState<Deck[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listDecks().then(setDecks)
  }, [])

  function handlePick(deck: Deck) {
    setError(null)

    // 今のカードデータに無い cardId があれば dispatch しない
    const unknownIds = Object.keys(deck.counts).filter((id) => (deck.counts[id] ?? 0) > 0 && !cardById.has(id))
    if (deck.leaderCardId && !cardById.has(deck.leaderCardId)) unknownIds.push(deck.leaderCardId)
    if (unknownIds.length > 0) {
      setError(`カードデータに無いカード: ${[...new Set(unknownIds)].join('・')}`)
      return
    }

    if (hasOwnCards && !confirm('自分の盤面のカードをすべて片付けて、このデッキで置き直します。よろしいですか？')) {
      return
    }

    // counts から iid を振って60枚を作る。leaderCardId の1枚をリーダーに、残り59枚をシャッフル
    const entries: { cardId: string }[] = []
    for (const [cardId, n] of Object.entries(deck.counts)) {
      for (let i = 0; i < n; i++) entries.push({ cardId })
    }
    const leaderIdx = entries.findIndex((e) => e.cardId === deck.leaderCardId)
    if (leaderIdx === -1) {
      setError('リーダーがデッキに含まれていません（デッキ画面で選び直してください）')
      return
    }
    const leaderEntry = entries[leaderIdx]
    const rest = [...entries.slice(0, leaderIdx), ...entries.slice(leaderIdx + 1)]
    const shuffled = shuffle(rest, Math.random)
    const deckCards = shuffled.map((e) => ({ iid: newIid(), cardId: e.cardId }))

    const leaderCard = cardById.get(leaderEntry.cardId)
    const leaderKiryoku = maxKiryokuFor('leader', leaderCard?.kiryoku ?? null)

    dispatch({
      type: 'startWithDeck',
      owner: mySeat,
      deckName: deck.name,
      leader: { iid: newIid(), cardId: leaderEntry.cardId, kiryoku: leaderKiryoku },
      deck: deckCards,
      draw: 7,
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-lg p-4 lf-panel">
        <div className="flex items-center justify-between">
          <b className="text-sm">デッキで始める</b>
          <button type="button" className="rounded border border-line-strong px-2.5 py-1 text-xs" onClick={onClose}>
            閉じる
          </button>
        </div>

        {error && <p className="mt-2 rounded border border-danger bg-danger/10 p-2 text-xs text-danger">{error}</p>}

        {decks === null ? (
          <p className="mt-3 text-xs text-ink-muted">読み込み中…</p>
        ) : decks.length === 0 ? (
          <p className="mt-3 text-xs text-ink-muted">デッキがありません。デッキ画面で作ってください。</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {decks.map((d) => {
              const v = validateDeck(d, cardById)
              const leaderName = d.leaderCardId ? (cardById.get(d.leaderCardId)?.name ?? d.leaderCardId) : '（未選択）'
              const reasons: string[] = []
              if (!v.exactly60) reasons.push(`${v.total}/60枚`)
              if (!v.max4ByName) reasons.push('同名5枚以上あり')
              if (!v.leaderOk) reasons.push('リーダー未選択')
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    disabled={!v.ok}
                    title={v.ok ? undefined : reasons.join('・')}
                    onClick={() => handlePick(d)}
                    className={`flex w-full items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-left text-xs ${
                      v.ok
                        ? 'border-line-strong hover:border-ok hover:bg-ok/10'
                        : 'cursor-not-allowed border-line-strong/50 text-ink-faint'
                    }`}
                  >
                    <span className="truncate">
                      <span className="font-semibold">{d.name}</span>
                      <span className="ml-1.5 text-ink-muted">（リーダー: {leaderName}）</span>
                    </span>
                    <span className={`shrink-0 ${v.ok ? 'text-ok' : 'text-warn'}`}>
                      {v.ok ? '60/60 ✓' : reasons.join('・')}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
