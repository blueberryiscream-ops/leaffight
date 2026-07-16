import { useDroppable } from '@dnd-kit/core'
import type { BoardState, Player, ZoneId } from '../../core/board'
import { cardsInZone, ZONE_LABEL } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardPiece } from './CardPiece'

// デッキ / 手札 / ゴミ箱。固定スロットではなく「束・横帯」（DESIGN.md §4.13）。

export function ZoneBundle({
  owner,
  zone,
  board,
  cardOf,
  imageUrlOf,
  onCardClick,
  onShuffle,
  fanOut,
}: {
  owner: Player
  zone: Extract<ZoneId, 'deck' | 'hand' | 'trash'>
  board: BoardState
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  onCardClick: (iid: string) => void
  onShuffle?: () => void
  /** 手札は全部横並びで表示する。デッキ/ゴミ箱は一番上だけ見せる束にする */
  fanOut?: boolean
}) {
  const dropId = `${owner}:${zone}`
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  const list = cardsInZone(board, owner, zone)

  return (
    <div
      ref={setNodeRef}
      data-dropid={dropId}
      className={`flex min-h-[118px] min-w-[84px] items-center gap-1 rounded-md border-2 border-dashed p-1 transition-colors ${
        isOver ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700/70 bg-slate-950/30'
      }`}
    >
      <div className="flex flex-col items-center justify-center px-1 text-[9px] text-slate-500">
        <span>{ZONE_LABEL[zone]}</span>
        <span className="text-slate-400">{list.length}</span>
        {zone === 'deck' && onShuffle && (
          <button
            type="button"
            onClick={onShuffle}
            className="mt-1 rounded border border-slate-600 px-1 py-0.5 text-[8px] text-slate-400 hover:border-emerald-500 hover:text-emerald-300"
          >
            シャッフル
          </button>
        )}
      </div>

      {list.length === 0 ? null : fanOut ? (
        <div className="flex gap-1 overflow-x-auto">
          {list.map((inst) => (
            <CardPiece
              key={inst.iid}
              instance={inst}
              card={cardOf(inst.cardId)}
              imageUrl={imageUrlOf(inst.cardId)}
              board={board}
              onClick={() => onCardClick(inst.iid)}
            />
          ))}
        </div>
      ) : (
        // 束表示: 一番上(index最小)の1枚だけドラッグ対象として見せる
        <CardPiece
          instance={list[0]}
          card={cardOf(list[0].cardId)}
          imageUrl={imageUrlOf(list[0].cardId)}
          board={board}
          onClick={() => onCardClick(list[0].iid)}
        />
      )}
    </div>
  )
}
