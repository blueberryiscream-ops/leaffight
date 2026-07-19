import { useLayoutEffect, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { BoardAction } from '../../core/actions'
import type { BoardState, Seat, ZoneId } from '../../core/board'
import { cardsInZone } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardPiece } from './CardPiece'

// デッキ / 手札 / ゴミ箱。固定スロットではなく「束・横帯」（DESIGN.md §4.13）。
// マスの大きさは呼び出し側から明示pxで受け取る（DESIGN.md §4.18.1・PHASE2.7.md §1.1）。
// デッキ/ゴミ箱は回転しないゾーン＝0.716H×Hの縦長マス1つに、束を重ねて表示する。

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
  size,
  handSize,
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
  /** 手札は全部横並び（扇状）で表示する。デッキ/ゴミ箱は一番上だけ見せる束にする */
  fanOut?: boolean
  /**
   * 相手の手札を伏せるためのフラグ（PHASE2.5.md §2.3）。状態(faceUp)は変えず、描画だけ隠す。
   * 操作（ドラッグで動かす等）自体は塞がない＝「描画側で隠すだけ」の割り切り。
   */
  hideContents?: boolean
  /**
   * 相手の手札を「枚数が読める大きさ」に圧縮する（DESIGN.md §4.18・PHASE2.7.md §1.3）。
   * 40px幅の帯まで削ると枚数すら読めなくなる、というユーザー指摘の反映。
   * カード裏1枚分の大きさは保ち、個別カードは出さず束＋枚数にする。
   */
  thin?: boolean
  /** 束（非fanOut）1枚分のマスサイズ(px)。回転しないゾーンなので 0.716H×H */
  size: { w: number; h: number }
  /** 手札(fanOut)のカード1枚のサイズ(px)。手札の行は他と高さが違うため別に渡す */
  handSize?: { w: number; h: number }
  selectedIid?: string | null
}) {
  const dropId = `${owner}:${zone}`
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  // 付与済みアイテムは対象カードの上に重ねて描く（StackedCardSlot、PHASE2.9c.md §2-1）ので、
  // 元のゾーン（主に手札）にダブって出さない。
  const list = cardsInZone(board, owner, zone).filter((c) => c.attachedTo === null)

  if (thin) {
    return (
      <div
        ref={setNodeRef}
        data-dropid={dropId}
        style={{ width: size.w, height: size.h }}
        className={`relative flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-dashed text-[10px] text-slate-400 transition-colors ${
          isOver ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700/70 bg-slate-950/40'
        }`}
        title="相手の手札（伏せ）"
      >
        <div className="flex h-[70%] w-[80%] items-center justify-center rounded-sm border border-slate-600 bg-gradient-to-br from-slate-700 to-slate-900 text-[9px] text-slate-500">
          裏
        </div>
        <span className="font-semibold text-slate-300">{list.length}枚</span>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      data-dropid={dropId}
      style={fanOut ? undefined : { width: size.w, height: size.h }}
      className={`relative flex shrink-0 items-center justify-center gap-1 rounded-md border-2 border-dashed p-0.5 transition-colors ${
        fanOut ? 'h-full min-w-0 flex-1' : ''
      } ${isOver ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700/70 bg-slate-950/30'}`}
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
          cardSize={handSize ?? size}
        />
      ) : (
        // 束表示: 一番上(index最小)の1枚だけドラッグ対象として見せる。枚数はバッジで重ねる
        <div className="relative shrink-0" style={{ width: size.w, height: size.h }}>
          <CardPiece
            instance={list[0]}
            card={cardOf(list[0].cardId)}
            imageUrl={imageUrlOf(list[0].cardId)}
            board={board}
            dispatch={dispatch}
            onClick={() => onCardClick(list[0].iid)}
            onContextMenu={(x, y) => onCardContextMenu(list[0].iid, x, y)}
            selected={selectedIid === list[0].iid}
            size={size}
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
  cardSize,
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
  cardSize: { w: number; h: number }
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [overlapPx, setOverlapPx] = useState(0)

  // 手札の枚数に応じて、コンテナ幅に収まるよう重なりを計算する（扇状。DESIGN.md §4.20）。
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || list.length <= 1) {
      setOverlapPx(0)
      return
    }
    const measure = () => {
      const containerWidth = el.clientWidth
      const totalNaturalWidth = cardSize.w * list.length
      const needed = totalNaturalWidth > containerWidth ? (totalNaturalWidth - containerWidth) / (list.length - 1) : 0
      setOverlapPx(needed)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [list.length, cardSize.w])

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center">
      {list.map((inst, i) => (
        <div
          key={inst.iid}
          className="shrink-0"
          style={{ width: cardSize.w, height: cardSize.h, marginLeft: i === 0 ? 0 : -overlapPx }}
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
            size={cardSize}
          />
        </div>
      ))}
    </div>
  )
}
