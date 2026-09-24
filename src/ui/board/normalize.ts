// 盤面読み込み時の正規化（旧state対応）。純関数・React/net/data は import しない
// （テストスクリプトから直接importできるよう、useBoard.ts本体とは切り離した。PHASE3d-3.md §3-3）。
// useBoard.ts の normalizeBattle/normalizePriority と同じ流儀。

import type { BoardState, Modifier } from '../../core/board'

/**
 * 旧 Modifier（P3d-3導入前・`kind` を持たない）を `'能力値修正'` に正規化する。
 * 読み込み時に `kind` が無いものだけ補完し、それ以外は変更しない（参照を保つ）。
 */
export function normalizeModifiers(board: BoardState): BoardState {
  let changed = false
  const modifiers: Record<string, Modifier> = { ...board.modifiers }
  for (const [id, mod] of Object.entries(modifiers)) {
    if ((mod as Partial<Modifier>).kind === undefined) {
      modifiers[id] = { ...mod, kind: '能力値修正' }
      changed = true
    }
  }
  return changed ? { ...board, modifiers } : board
}
