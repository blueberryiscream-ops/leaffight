import type { BoardState, Player } from '../../core/board'
import { cardsInZone, SLOT_CAPACITY } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardPiece } from './CardPiece'
import { DroppableSlot } from './DroppableSlot'
import { ZoneBundle } from './ZoneBundle'

// 1プレイヤー分の盤面。DESIGN.md §4.13:
// 中央（相手との境界）から自陣の端へ [前線: バトル×3 + フィールド] [キャラ段×5] [最後列: ゴミ箱/リーダー/デッキ] [手札]

function SlotRow({
  owner,
  zone,
  board,
  cardOf,
  imageUrlOf,
  onCardClick,
  label,
}: {
  owner: Player
  zone: 'char' | 'battle' | 'field' | 'leader'
  board: BoardState
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  onCardClick: (iid: string) => void
  label: string
}) {
  const capacity = SLOT_CAPACITY[zone] ?? 1
  const byIndex = new Map(cardsInZone(board, owner, zone).map((c) => [c.index, c]))

  return (
    <>
      {Array.from({ length: capacity }, (_, i) => {
        const inst = byIndex.get(i)
        return (
          <DroppableSlot key={`${zone}-${i}`} dropId={`${owner}:${zone}:${i}`} label={label}>
            {inst && (
              <CardPiece
                instance={inst}
                card={cardOf(inst.cardId)}
                imageUrl={imageUrlOf(inst.cardId)}
                board={board}
                onClick={() => onCardClick(inst.iid)}
              />
            )}
          </DroppableSlot>
        )
      })}
    </>
  )
}

export function PlayerBoard({
  owner,
  board,
  cardOf,
  imageUrlOf,
  onCardClick,
  onShuffleDeck,
  reversed,
}: {
  owner: Player
  board: BoardState
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  onCardClick: (iid: string) => void
  onShuffleDeck: () => void
  /** 相手側は手札を上・前線を下境界寄りにする（DESIGN.md §4.13「相手陣を上」の構造的な再現） */
  reversed: boolean
}) {
  const frontLine = (
    <div className="flex items-center justify-center gap-2">
      <SlotRow owner={owner} zone="battle" board={board} cardOf={cardOf} imageUrlOf={imageUrlOf} onCardClick={onCardClick} label="バトル" />
      <div className="w-3" />
      <SlotRow owner={owner} zone="field" board={board} cardOf={cardOf} imageUrlOf={imageUrlOf} onCardClick={onCardClick} label="フィールド" />
    </div>
  )
  const charRow = (
    <div className="flex items-center justify-center gap-2">
      <SlotRow owner={owner} zone="char" board={board} cardOf={cardOf} imageUrlOf={imageUrlOf} onCardClick={onCardClick} label="キャラ" />
    </div>
  )
  const backRow = (
    <div className="flex items-center justify-center gap-4">
      <ZoneBundle owner={owner} zone="trash" board={board} cardOf={cardOf} imageUrlOf={imageUrlOf} onCardClick={onCardClick} />
      <SlotRow owner={owner} zone="leader" board={board} cardOf={cardOf} imageUrlOf={imageUrlOf} onCardClick={onCardClick} label="リーダー" />
      <ZoneBundle owner={owner} zone="deck" board={board} cardOf={cardOf} imageUrlOf={imageUrlOf} onCardClick={onCardClick} onShuffle={onShuffleDeck} />
    </div>
  )
  const hand = (
    <div className="flex justify-center">
      <ZoneBundle owner={owner} zone="hand" board={board} cardOf={cardOf} imageUrlOf={imageUrlOf} onCardClick={onCardClick} fanOut />
    </div>
  )

  const rows = reversed ? [hand, backRow, charRow, frontLine] : [frontLine, charRow, backRow, hand]

  return (
    <div className="flex flex-col gap-2 py-2">
      {rows.map((row, i) => (
        <div key={i}>{row}</div>
      ))}
    </div>
  )
}
