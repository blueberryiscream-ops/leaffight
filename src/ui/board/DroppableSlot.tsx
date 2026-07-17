import { useDroppable } from '@dnd-kit/core'
import type { ReactNode } from 'react'

// フィールド系の固定スロット（キャラ/バトル/フィールド/リーダー）1マス分。
// 位置にルール上の意味は無い＝ただの置き場（DESIGN.md §4.13）。
// サイズは親の行が決める（PHASE2.6.md §4）。ここは行の高さいっぱいに、幅は等分の1枠を占める。

export function DroppableSlot({
  dropId,
  label,
  emphasize,
  children,
}: {
  dropId: string
  label: string
  /** フィールドの共有スロットを目立たせる（DESIGN.md §4.18「共有であることが見た目で分かる」） */
  emphasize?: boolean
  children: ReactNode | null
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      data-dropid={dropId}
      className={`flex h-full min-w-0 flex-1 items-center justify-center rounded-md border-2 border-dashed transition-colors ${
        isOver
          ? 'border-emerald-500 bg-emerald-950/40'
          : emphasize
            ? 'border-amber-700/70 bg-amber-950/10'
            : 'border-slate-700/70 bg-slate-950/40'
      }`}
    >
      {children ?? <span className="text-[9px] text-slate-600">{label}</span>}
    </div>
  )
}
