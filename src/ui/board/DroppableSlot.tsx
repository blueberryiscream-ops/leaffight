import { useDroppable } from '@dnd-kit/core'
import type { ReactNode } from 'react'

// フィールド系の固定スロット（キャラ/バトル/フィールド/リーダー）1マス分。
// 位置にルール上の意味は無い＝ただの置き場（DESIGN.md §4.13）。

export function DroppableSlot({
  dropId,
  label,
  children,
}: {
  dropId: string
  label: string
  children: ReactNode | null
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      data-dropid={dropId}
      className={`flex h-[118px] w-[84px] shrink-0 items-center justify-center rounded-md border-2 border-dashed transition-colors ${
        isOver ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700/70 bg-slate-950/40'
      }`}
    >
      {children ?? <span className="text-[9px] text-slate-600">{label}</span>}
    </div>
  )
}
