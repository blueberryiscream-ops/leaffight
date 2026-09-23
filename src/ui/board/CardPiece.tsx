import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { BoardAction } from '../../core/actions'
import type { CardInstance } from '../../core/board'
import { effectiveStat, modifiersFor } from '../../core/board'
import type { BoardState } from '../../core/board'
import { ATTRS } from '../../core/types'
import type { PoolCard } from '../../data/types'
import { CardFace } from './CardFace'
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
  flipped,
  groupRotate,
  attachBadgeOverride,
  battleBadge,
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
  /**
   * 相手が置いたカードを180°反転して見せる（PHASE2.9b.md §2-1）。owner!==mySeatをBoard側が渡す。
   * 手札/デッキ/ゴミ箱（向きに意味がない束）には渡さない。
   */
  flipped?: boolean
  /**
   * アイテムを重ねたスタック内で使う（PHASE2.9c.md §2-4）。指定時は instance.orientation/flipped を
   * 見ず、この角度・原点で回転する（対象＋付随アイテムが同じ軸で1つの剛体として回るようにするため）。
   * origin は各カード自身の左上を基準にしたCSS transform-origin値（例 "23px 40px"）。
   * ここを起点にすることで、スタック全体を包む要素自体は回転させずに済み、
   * HoverPreview（回転しない兄弟要素）が親の回転を巻き込まれる問題を避けられる。
   */
  groupRotate?: { deg: number; origin: string }
  /**
   * 🔗バッジの件数を上書きする（PHASE2.9c.md §1-5）。スタック内の対象カードは重ね表示自体で
   * 付随数が見えるためバッジは冗長＝0を渡して隠す。付与数が多く重ねが窮屈な時だけ
   * `StackedCardSlot`側から実数を渡して「+N」相当として出す。未指定時は自分で数える（従来通り）。
   */
  attachBadgeOverride?: number
  /**
   * バトル中の参加キャラ／バトル種目カードの目印（PHASE3d-2b §1）。盤面上でひと目分かるよう
   * ⚔バッジを出す。判定（誰が参加中か等）はBoard.tsx側（board.battleを見て）が行う。
   */
  battleBadge?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: instance.iid,
    disabled: dragDisabled,
  })
  const [hovered, setHovered] = useState(false)

  // 向き（PHASE2.9b.md §2-1）: 相手のカードは180°反転、消耗は上部が自分から見て左に来るよう-90°。
  // グループ回転中（PHASE2.9c.md §2-4）は外から角度・原点を指定されるので自分では計算しない。
  const base = flipped ? 180 : 0
  const tap = instance.orientation === 'rested' ? -90 : 0
  const rotate = groupRotate ? groupRotate.deg : base + tap
  const style = {
    width: size.w,
    height: size.h,
    transform: transform
      ? `${CSS.Translate.toString(transform)} rotate(${rotate}deg)`
      : `rotate(${rotate}deg)`,
    transformOrigin: groupRotate?.origin,
    opacity: isDragging ? 0.35 : 1,
  }

  const mods = modifiersFor(board, instance.iid)
  const attachedCount =
    attachBadgeOverride ?? Object.values(board.cards).filter((c) => c.attachedTo === instance.iid).length
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
        <CardFace faceUp={faceUp} imageUrl={imageUrl} card={card} name={name} compact />

        {/* オーバーレイ: 印刷されていない「今の状態」。画像/テキストどちらの上にも重ねる（PHASE2.8.md §2） */}
        {faceUp && (instance.kiryoku !== null || mods.length > 0) && (
          <div className="pointer-events-none absolute inset-x-0.5 bottom-0.5 flex flex-col items-start gap-0.5">
            {instance.kiryoku !== null && (
              <span className="rounded bg-slate-950/85 px-1 text-[8px] font-bold text-emerald-400">
                気{instance.kiryoku}
              </span>
            )}
            {mods.length > 0 && (
              <div className="flex flex-wrap gap-0.5">
                {ATTRS.filter((a) => mods.some((m) => m.stat === a)).map((a) => {
                  const base = card?.stats?.[a] ?? 0
                  const eff = effectiveStat(board, instance.iid, base, a)
                  const diff = eff - base
                  return (
                    <span
                      key={a}
                      className={`rounded px-0.5 text-[7px] ${diff >= 0 ? 'bg-emerald-900/90 text-emerald-300' : 'bg-red-900/90 text-red-300'}`}
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
        )}

        <AttachBadge count={attachedCount} />
        {battleBadge && (
          <span className="absolute left-0.5 top-0.5 rounded-full bg-red-700 px-1 text-[8px] font-bold text-white">
            ⚔
          </span>
        )}
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
