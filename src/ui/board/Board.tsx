import { useMemo, useState } from 'react'
import {
  closestCenter,
  DndContext,
  MouseSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import type { Seat, ZoneId } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardControls } from './CardControls'
import { CardPicker } from './CardPicker'
import { ConnectionPanel } from './ConnectionPanel'
import { LogPanel } from './LogPanel'
import { SeatBoard } from './SeatBoard'
import { newIid, otherSeat, useBoard } from './useBoard'

function parseDropId(id: string): { owner: Seat; zone: ZoneId; index?: number } | null {
  const parts = String(id).split(':')
  if (parts.length === 2) return { owner: parts[0] as Seat, zone: parts[1] as ZoneId }
  if (parts.length === 3) return { owner: parts[0] as Seat, zone: parts[1] as ZoneId, index: Number(parts[2]) }
  return null
}

export function Board({ cards, imageUrls }: { cards: PoolCard[]; imageUrls: Map<string, string> }) {
  const {
    board,
    log,
    canUndo,
    canRedo,
    dispatch,
    undo,
    redo,
    resetBoard,
    mode,
    connStatus,
    connError,
    roomCode,
    connectHost,
    connectGuest,
    disconnect,
    localSeat,
    setLocalSeat,
  } = useBoard()
  const [selectedIid, setSelectedIid] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // 自分の座席を手前に描く（PHASE2.5.md §2.3）。ホスト/ゲストで固定、ソロはA既定・切替可
  const mySeat: Seat = localSeat
  const theirSeat: Seat = otherSeat(localSeat)

  const cardMap = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  const cardOf = (cardId: string) => cardMap.get(cardId)
  const imageUrlOf = (cardId: string) => imageUrls.get(cardId)

  // PC専用。少し動いたらドラッグ開始（クリックとの競合を避ける。tcg-companion の知見＝distance:6）
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }))

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over) return
    const iid = String(active.id)
    const instance = board.cards[iid]
    if (!instance) return
    const target = parseDropId(String(over.id))
    if (!target) return

    const samePlace =
      instance.owner === target.owner &&
      instance.zone === target.zone &&
      (target.index === undefined || instance.index === target.index)
    if (samePlace) return

    const cardName = cardOf(instance.cardId)?.name ?? instance.cardId
    dispatch({
      type: 'moveCard',
      iid,
      toOwner: target.owner,
      toZone: target.zone,
      toIndex: target.index,
      cardName,
    })
  }

  function handleShuffle(owner: Seat) {
    const deckIids = Object.values(board.cards)
      .filter((c) => c.owner === owner && c.zone === 'deck')
      .map((c) => c.iid)
    // 乱数はここ（ui）で消費し、結果の並びだけを core に渡す（core純粋性のため）
    for (let i = deckIids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[deckIids[i], deckIids[j]] = [deckIids[j], deckIids[i]]
    }
    dispatch({ type: 'shuffleDeck', owner, orderedIids: deckIids })
  }

  function handlePick(card: PoolCard, owner: Seat, zone: ZoneId) {
    dispatch({ type: 'spawnCard', iid: newIid(), cardId: card.id, cardName: card.name, owner, zone })
  }

  function handleClearBoard() {
    if (!confirm('盤面をすべてクリアします。よろしいですか？')) return
    setSelectedIid(null)
    resetBoard()
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="flex h-full">
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
            <h1 className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">🎴 対戦卓</h1>
            <div className="flex items-center gap-2">
              {mode === 'solo' && (
                <button
                  type="button"
                  onClick={() => setLocalSeat(theirSeat)}
                  title="ひとり回し用: 自分の視点をA/Bで切り替える"
                  className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-sky-600 hover:text-sky-300"
                >
                  視点切替（現在: {mySeat}）
                </button>
              )}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="rounded border border-emerald-700 px-3 py-1 text-xs text-emerald-400 hover:bg-emerald-950"
              >
                ＋ カードを追加
              </button>
            </div>
          </div>

          <ConnectionPanel
            mode={mode}
            connStatus={connStatus}
            connError={connError}
            roomCode={roomCode}
            onHost={() => void connectHost()}
            onJoin={(code) => void connectGuest(code)}
            onDisconnect={disconnect}
          />

          <div className="flex-1 overflow-auto">
            <div className="border-b border-dashed border-slate-700 bg-slate-950/40 px-2">
              <p className="pt-1 text-center text-[9px] tracking-widest text-slate-600">相手</p>
              <SeatBoard
                owner={theirSeat}
                mySeat={mySeat}
                board={board}
                cardOf={cardOf}
                imageUrlOf={imageUrlOf}
                onCardClick={setSelectedIid}
                onShuffleDeck={() => handleShuffle(theirSeat)}
                reversed
              />
            </div>
            <div className="px-2">
              <SeatBoard
                owner={mySeat}
                mySeat={mySeat}
                board={board}
                cardOf={cardOf}
                imageUrlOf={imageUrlOf}
                onCardClick={setSelectedIid}
                onShuffleDeck={() => handleShuffle(mySeat)}
                reversed={false}
              />
              <p className="pb-1 text-center text-[9px] tracking-widest text-slate-600">自分</p>
            </div>
          </div>

          <LogPanel
            log={log}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            onClearBoard={handleClearBoard}
            showUndoRedo={mode !== 'guest'}
          />
        </div>

        {selectedIid && (
          <CardControls
            iid={selectedIid}
            board={board}
            mySeat={mySeat}
            cardOf={cardOf}
            dispatch={dispatch}
            onClose={() => setSelectedIid(null)}
          />
        )}
      </div>

      {pickerOpen && <CardPicker cards={cards} mySeat={mySeat} onPick={handlePick} onClose={() => setPickerOpen(false)} />}
    </DndContext>
  )
}
