import { useDroppable } from '@dnd-kit/core'
import type { ReactNode } from 'react'

// フィールド系の固定スロット（キャラ/バトル/フィールド/リーダー）1マス分。
// 位置にルール上の意味は無い＝ただの置き場（DESIGN.md §4.13）。
//
// マスの大きさは「消耗（90°回転）したカードが収まる最小」で計算する（DESIGN.md §4.18.1）。
// 呼び出し側（Board.tsx）がpxで計算して渡す。ここではflex-1等で引き伸ばさない
// （PHASE2.6で「引き伸ばした結果、枠数の違う行で列が揃わなくなった」バグを踏んだ。
// PHASE2.7.md §1.1・IMPLEMENTATION-NOTES.md参照）。

export function DroppableSlot({
  dropId,
  label,
  size,
  emphasize,
  children,
}: {
  dropId: string
  label: string
  /** マスの大きさ(px)。回転するゾーンはH×H、しないゾーンは0.716H×H */
  size: { w: number; h: number }
  /** フィールドの共有スロットを目立たせる（DESIGN.md §4.18「共有であることが見た目で分かる」） */
  emphasize?: boolean
  children: ReactNode | null
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      data-dropid={dropId}
      style={{ width: size.w, height: size.h }}
      className={`flex shrink-0 items-center justify-center rounded-md border-2 border-dashed transition-colors ${
        isOver
          ? 'border-ok bg-ok/40'
          : emphasize
            ? 'border-warn/70 bg-warn/10'
            : 'border-line-strong/70 bg-surface-0/40'
      }`}
    >
      {children ?? <span className="text-[9px] text-ink-faint">{label}</span>}
    </div>
  )
}
