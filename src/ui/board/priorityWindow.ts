// 「今どちらが応答/解決する番か」の判定を1か所にまとめる（PHASE3d-3.md §5「二重に書かない」）。
// StackPanel.tsx と TodoBand.tsx の両方がここを呼ぶ。合法性判定はしない（読み取り専用の表示判定）。

import type { ResolveDestination } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import { awaitingSeat, resolvingSeat, type DeclaredAction, type Priority } from '../../core/priority'
import type { PoolCard } from '../../data/types'

/**
 * 解決された「プレイ」宣言のカードの行き先（元は StackPanel.tsx 内の private 関数。PHASE3a-4.md §1-3）。
 * 🚨 種別判定はここ（ui）の責務。core が受け取るのは行き先のゾーンだけ。
 */
export function resolveDestinationOf(
  action: DeclaredAction | null,
  board: BoardState,
  cardOf: (cardId: string) => PoolCard | undefined,
): ResolveDestination | undefined {
  if (!action || action.kind !== 'プレイ' || !action.sourceIid) return undefined
  const inst = board.cards[action.sourceIid]
  if (!inst || inst.zone !== 'pending') return undefined
  const kind = cardOf(inst.cardId)?.kind
  if (kind === 'e') return { toZone: 'trash' }
  if (kind === 'f') return { toZone: 'field' }
  return undefined
}

export interface PriorityWindowInfo {
  priority: Priority
  awaiting: Seat | null
  resolving: Seat | null
  resolveTo: ResolveDestination | undefined
}

/** board.priority が無ければ null。あれば awaiting/resolving/resolveTo をまとめて返す */
export function priorityWindowInfo(
  board: BoardState,
  cardOf: (cardId: string) => PoolCard | undefined,
): PriorityWindowInfo | null {
  const priority = board.priority
  if (!priority) return null
  const current = priority.frames[priority.frames.length - 1]
  const resolvingActionObj = current
    ? current.step === 'processActive'
      ? current.active
      : current.step === 'processNonActive'
        ? current.nonActive
        : null
    : null
  return {
    priority,
    awaiting: awaitingSeat(priority),
    resolving: resolvingSeat(priority),
    resolveTo: resolveDestinationOf(resolvingActionObj, board, cardOf),
  }
}
