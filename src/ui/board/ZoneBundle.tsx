import { useLayoutEffect, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { BoardAction } from '../../core/actions'
import type { BoardState, Seat, ZoneId } from '../../core/board'
import { cardsInZone } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardPiece } from './CardPiece'

// デッキ / 手札 / ゴミ箱。固定スロットではなく「束・横帯」（DESIGN.md §4.13）。
// カードサイズはレイアウトが決める（PHASE2.6.md §4）ので、束は行の高さいっぱいに
// 1枚だけ見せ、枚数はカードに重ねたバッジで示す（横に別カラムを取らない）。

export function ZoneBundle({
  owner,
  zone,
  board,
  cardOf,
  imageUrlOf,
  dispatch,
  onCardClick,
  onCardContextMenu,
  onShuffle,
  fanOut,
  hideContents,
  thin,
  selectedIid,
}: {
  owner: Seat
  zone: Extract<ZoneId, 'deck' | 'hand' | 'trash'>
  board: BoardState
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  dispatch: (action: BoardAction) => void
  onCardClick: (iid: string) => void
  onCardContextMenu: (iid: string, x: number, y: number) => void
  onShuffle?: () => void
  /** 手札は重ねた扇状で表示する。デッキ/ゴミ箱は一番上だけ見せる束にする */
  fanOut?: boolean
  /**
   * 相手の手札を伏せるためのフラグ（PHASE2.5.md §2.3）。状態(faceUp)は変えず、描画だけ隠す。
   * 操作（ドラッグで動かす等）自体は塞がない＝「描画側で隠すだけ」の割り切り。
   */
  hideContents?: boolean
  /** 相手の手札は極薄の帯に圧縮する（DESIGN.md §4.18・PHASE2.6.md §2）。枚数のみ、個別カードは出さない */
  thin?: boolean
  selectedIid?: string | null
}) {
  const dropId = `${owner}:${zone}`
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  const list = cardsInZone(board, owner, zone)

  if (thin) {
    return (
      <div
        ref={setNodeRef}
        data-dropid={dropId}
        className={`flex h-full w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-dashed text-[9px] text-slate-500 transition-colors ${
          isOver ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700/70 bg-slate-950/40'
        }`}
        title="相手の手札（伏せ）"
      >
        <div className="h-4/5 w-6 rounded-sm border border-slate-600 bg-gradient-to-br from-slate-700 to-slate-900" />
        <span>{list.length}</span>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      data-dropid={dropId}
      className={`relative flex h-full min-w-0 flex-1 items-center justify-center gap-1 rounded-md border-2 border-dashed p-0.5 transition-colors ${
        isOver ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700/70 bg-slate-950/30'
      }`}
    >
      {list.length === 0 ? (
        <span className="text-[9px] text-slate-600">{zone === 'hand' ? '手札' : zone === 'deck' ? 'デッキ' : 'ゴミ箱'}</span>
      ) : fanOut ? (
        <HandFan
          list={list}
          board={board}
          cardOf={cardOf}
          imageUrlOf={imageUrlOf}
          dispatch={dispatch}
          onCardClick={onCardClick}
          onCardContextMenu={onCardContextMenu}
          hideContents={hideContents}
          selectedIid={selectedIid}
        />
      ) : (
        // 束表示: 一番上(index最小)の1枚だけドラッグ対象として見せる。枚数はバッジで重ねる
        <div className="relative aspect-[63/88] h-full shrink-0">
          <CardPiece
            instance={list[0]}
            card={cardOf(list[0].cardId)}
            imageUrl={imageUrlOf(list[0].cardId)}
            board={board}
            dispatch={dispatch}
            onClick={() => onCardClick(list[0].iid)}
            onContextMenu={(x, y) => onCardContextMenu(list[0].iid, x, y)}
            selected={selectedIid === list[0].iid}
          />
          <span className="pointer-events-none absolute -left-1 -top-1 rounded-full bg-slate-700 px-1 text-[8px] font-bold text-slate-200 shadow">
            {list.length}
          </span>
          {zone === 'deck' && onShuffle && (
            <button
              type="button"
              onClick={onShuffle}
              title="シャッフル"
              className="absolute -bottom-1 -right-1 rounded-full border border-slate-600 bg-slate-800 px-1 text-[9px] text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
            >
              🔀
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function HandFan({
  list,
  board,
  cardOf,
  imageUrlOf,
  dispatch,
  onCardClick,
  onCardContextMenu,
  hideContents,
  selectedIid,
}: {
  list: ReturnType<typeof cardsInZone>
  board: BoardState
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  dispatch: (action: BoardAction) => void
  onCardClick: (iid: string) => void
  onCardContextMenu: (iid: string, x: number, y: number) => void
  hideContents?: boolean
  selectedIid?: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [overlapPx, setOverlapPx] = useState(0)

  // 手札の枚数に応じて、コンテナ幅に収まるよう重なりを計算する（扇状。DESIGN.md §4.20）。
  // 視認性が確保できない場合は単純な横一列に落とす、という逃げ道が §6 に明記されている。
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const containerWidth = el.clientWidth
      const firstCard = el.querySelector('[data-hand-card]') as HTMLElement | null
      const cardWidth = firstCard?.offsetWidth ?? 0
      if (!cardWidth || list.length <= 1) {
        setOverlapPx(0)
        return
      }
      const totalNaturalWidth = cardWidth * list.length
      const needed = totalNaturalWidth > containerWidth ? (totalNaturalWidth - containerWidth) / (list.length - 1) : 0
      setOverlapPx(needed)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [list.length])

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center">
      {list.map((inst, i) => (
        <div
          key={inst.iid}
          data-hand-card
          className="aspect-[63/88] h-full shrink-0"
          style={{ marginLeft: i === 0 ? 0 : -overlapPx }}
        >
          <CardPiece
            instance={inst}
            card={cardOf(inst.cardId)}
            imageUrl={imageUrlOf(inst.cardId)}
            board={board}
            dispatch={dispatch}
            onClick={() => onCardClick(inst.iid)}
            onContextMenu={(x, y) => onCardContextMenu(inst.iid, x, y)}
            hidden={hideContents}
            selected={selectedIid === inst.iid}
          />
        </div>
      ))}
    </div>
  )
}
