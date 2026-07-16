import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { CardInstance } from '../../core/board'
import { effectiveStat, modifiersFor } from '../../core/board'
import type { BoardState } from '../../core/board'
import { ATTRS, CARD_KIND_LABEL } from '../../core/types'
import type { PoolCard } from '../../data/types'

// 盤面上の1枚。P0の CardTile とは別に、盤面用に小さく・回転できる形で作る
// （消耗＝90°回転。DESIGN.md §4.5・§4.13）。

export function CardPiece({
  instance,
  card,
  imageUrl,
  board,
  onClick,
  dragDisabled,
  hidden,
}: {
  instance: CardInstance
  card: PoolCard | undefined
  imageUrl: string | undefined
  board: BoardState
  onClick: () => void
  dragDisabled?: boolean
  /**
   * 相手の手札を伏せるためのフラグ（PHASE2.5.md §2.3）。カード自体の faceUp（ゲーム内の表裏）
   * とは別に、「このクライアントの画面には見せない」という描画専用の上書き。
   * 操作は塞がない（掴んで動かすことはできる。見えないだけ）。
   */
  hidden?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: instance.iid,
    disabled: dragDisabled,
  })

  const rotate = instance.orientation === 'rested' ? 90 : 0
  const style = {
    transform: transform
      ? `${CSS.Translate.toString(transform)} rotate(${rotate}deg)`
      : `rotate(${rotate}deg)`,
    opacity: isDragging ? 0.35 : 1,
  }

  const mods = modifiersFor(board, instance.iid)
  const attachedCount = Object.values(board.cards).filter((c) => c.attachedTo === instance.iid).length
  const faceUp = hidden ? false : instance.faceUp

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      data-iid={instance.iid}
      data-orientation={instance.orientation}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className="relative flex h-[112px] w-20 shrink-0 touch-none select-none flex-col overflow-hidden rounded-md border border-slate-600 bg-slate-900 text-left shadow transition-shadow hover:border-emerald-500 hover:shadow-emerald-900/40"
    >
      {!faceUp ? (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-700 to-slate-900 text-[9px] text-slate-500">
          裏
        </div>
      ) : (
        <>
          <div className="h-14 w-full shrink-0 bg-slate-950">
            {imageUrl ? (
              <img src={imageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-center text-[9px] leading-tight text-slate-500">
                {card ? CARD_KIND_LABEL[card.kind] : '?'}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-hidden px-1 py-0.5">
            <div className="truncate text-[9px] font-semibold leading-tight text-slate-100">
              {card?.name ?? instance.cardId}
            </div>
            {instance.kiryoku !== null && (
              <div className="text-[8px] text-emerald-400">気{instance.kiryoku}</div>
            )}
            {mods.length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-0.5">
                {ATTRS.filter((a) => mods.some((m) => m.stat === a)).map((a) => {
                  const base = card?.stats?.[a] ?? 0
                  const eff = effectiveStat(board, instance.iid, base, a)
                  const diff = eff - base
                  return (
                    <span
                      key={a}
                      className={`rounded px-0.5 text-[7px] ${diff >= 0 ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'}`}
                    >
                      {a}
                      {diff >= 0 ? '+' : ''}
                      {diff}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      <AttachBadge count={attachedCount} />
    </button>
  )
}

function AttachBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className="absolute right-0.5 top-0.5 rounded-full bg-sky-600 px-1 text-[8px] font-bold text-white">
      🔗{count}
    </span>
  )
}
