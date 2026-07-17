import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { BoardAction } from '../../core/actions'
import type { CardInstance } from '../../core/board'
import { effectiveStat, modifiersFor } from '../../core/board'
import type { BoardState } from '../../core/board'
import { ATTRS, CARD_KIND_LABEL } from '../../core/types'
import type { PoolCard } from '../../data/types'
import { HoverPreview } from './HoverPreview'

// 盤面上の1枚。操作の割り当ては DESIGN.md §4.17:
//   ホバー   → すぐ近くに拡大ポップアップ（0クリック）
//   左クリック → 詳細パネルで選択（Board.tsx側の右パネルに表示）
//   左ダブルクリック → 待機⇔消耗
//   右クリック → 状態変化メニュー（Board.tsx側で浮かせる CardContextMenu）
//
// サイズは呼び出し側（Board.tsx）がpxで渡す（DESIGN.md §4.18.1）。
// CSSのaspect-ratio/max-widthのパーセンテージ計算には頼らない
// （P2.6で「幅未確定の要素にaspect-ratio+%を使うと循環参照で最初の1枚だけ
// 小さく描画される」というバグを踏んだため。IMPLEMENTATION-NOTES.md参照）。
// カード自体は常に「縦向きの自然な大きさ」(w×h)で描画し、消耗時は
// transform:rotate(90deg)で見た目だけ回転させる（マス＝正方形はP2.7で
// 呼び出し側が確保する。ここでは回転後にはみ出さないよう心配しない）。

export function CardPiece({
  instance,
  card,
  imageUrl,
  board,
  dispatch,
  onClick,
  onContextMenu,
  size,
  dragDisabled,
  hidden,
  selected,
}: {
  instance: CardInstance
  card: PoolCard | undefined
  imageUrl: string | undefined
  board: BoardState
  dispatch: (action: BoardAction) => void
  /** 左クリック→詳細選択 */
  onClick: () => void
  /** 右クリック→状態変化メニューを開く（座標はBoard.tsx側で浮かせるため渡す） */
  onContextMenu: (clientX: number, clientY: number) => void
  /** カードの自然な（縦向き・未回転の）サイズ(px)。呼び出し側が計算して渡す */
  size: { w: number; h: number }
  dragDisabled?: boolean
  /**
   * 相手の手札を伏せるためのフラグ（PHASE2.5.md §2.3）。カード自体の faceUp（ゲーム内の表裏）
   * とは別に、「このクライアントの画面には見せない」という描画専用の上書き。
   * 操作は塞がない（掴んで動かすことはできる。見えないだけ）。
   */
  hidden?: boolean
  /** 詳細パネルで選択中のカードを軽く強調する */
  selected?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: instance.iid,
    disabled: dragDisabled,
  })
  const [hovered, setHovered] = useState(false)

  const rotate = instance.orientation === 'rested' ? 90 : 0
  const style = {
    width: size.w,
    height: size.h,
    transform: transform
      ? `${CSS.Translate.toString(transform)} rotate(${rotate}deg)`
      : `rotate(${rotate}deg)`,
    opacity: isDragging ? 0.35 : 1,
  }

  const mods = modifiersFor(board, instance.iid)
  const attachedCount = Object.values(board.cards).filter((c) => c.attachedTo === instance.iid).length
  const faceUp = hidden ? false : instance.faceUp
  const name = card?.name ?? instance.cardId

  return (
    <div
      className="relative shrink-0"
      style={{ width: size.w, height: size.h }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        ref={setNodeRef}
        type="button"
        style={style}
        data-iid={instance.iid}
        data-orientation={instance.orientation}
        {...attributes}
        {...listeners}
        onClick={onClick}
        onDoubleClick={(e) => {
          e.stopPropagation()
          dispatch({ type: 'toggleOrientation', iid: instance.iid, cardName: name })
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu(e.clientX, e.clientY)
        }}
        className={`relative flex shrink-0 touch-none select-none flex-col overflow-hidden rounded-md border bg-slate-900 text-left shadow transition-shadow hover:border-emerald-500 hover:shadow-emerald-900/40 ${
          selected ? 'border-emerald-400 ring-2 ring-emerald-500/50' : 'border-slate-600'
        }`}
      >
        {!faceUp ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-700 to-slate-900 text-[9px] text-slate-500">
            裏
          </div>
        ) : (
          <div className="flex h-full w-full flex-col">
            <div className="h-[55%] w-full shrink-0 bg-slate-950">
              {imageUrl ? (
                <img src={imageUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-center text-[9px] leading-tight text-slate-500">
                  {card ? CARD_KIND_LABEL[card.kind] : '?'}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-hidden px-1 py-0.5">
              <div className="truncate text-[9px] font-semibold leading-tight text-slate-100">{name}</div>
              {instance.kiryoku !== null && <div className="text-[8px] text-emerald-400">気{instance.kiryoku}</div>}
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
          </div>
        )}

        <AttachBadge count={attachedCount} />
      </button>

      {hovered && !isDragging && (
        <HoverPreview instance={instance} card={card} imageUrl={imageUrl} faceUp={faceUp} />
      )}
    </div>
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
