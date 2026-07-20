// 優先権/スタックエンジン（core専用・カード知識ゼロ）。DESIGN.md §5.1 / PHASE3a-1.md §2。
// 「積む・順番・両者合意で降ろす」だけの状態機械。効果の解決内容・合法性判定・コストは一切扱わない。
// 乱数・時刻は持たない。StackItem.id は呼び出し側が採番する（既存の iid 方針と同じ）。

import type { Seat } from './board'

export type StackKind = 'プレイ' | '能力' | 'バトル' | 'その他'

export interface StackItem {
  id: string
  by: Seat
  kind: StackKind
  sourceIid: string | null
  label: string
  detail?: string
  note?: string
}

export interface PriorityState {
  stack: StackItem[]
  activePlayer: Seat
  awaitingConsentFrom: Seat
  consentedInARow: Seat[]
}

export type Mode = 'assist' | 'free'

export interface PriorityResult {
  priority: PriorityState | null
  log: string
}

export function other(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

/** declareAction: 宣言を積む（新規窓を開く、または割り込みとして入れ子で積む） */
export function declareAction(priority: PriorityState | null, item: StackItem): PriorityResult {
  if (priority === null) {
    return {
      priority: { stack: [item], activePlayer: item.by, awaitingConsentFrom: other(item.by), consentedInARow: [] },
      log: `${item.by} が「${item.label}」を宣言`,
    }
  }
  if (item.by !== priority.awaitingConsentFrom) {
    // 不正: 今は宣言者の番ではない。何もしない
    return { priority, log: '' }
  }
  return {
    priority: {
      ...priority,
      stack: [...priority.stack, item],
      awaitingConsentFrom: other(item.by),
      consentedInARow: [],
    },
    log: `${item.by} が「${item.label}」を宣言`,
  }
}

/** passPriority: 合意（割り込まない）。両者連続合意なら resolveTop を自動発火する */
export function passPriority(priority: PriorityState | null, by: Seat): PriorityResult {
  if (priority === null || by !== priority.awaitingConsentFrom) {
    return { priority, log: '' }
  }
  const consented = [...priority.consentedInARow, by]
  const bothConsented = consented.includes('A') && consented.includes('B')

  if (!bothConsented) {
    return {
      priority: { ...priority, consentedInARow: consented, awaitingConsentFrom: other(by) },
      log: `${by} が通した`,
    }
  }

  // 両者連続合意 → 最上段を降ろす（13-3-1のanti-deadlockが前進を保証）
  const top = priority.stack[priority.stack.length - 1]
  const restStack = priority.stack.slice(0, -1)
  const resolveLog = top ? `「${top.label}」を解決` : ''

  if (restStack.length === 0) {
    return { priority: null, log: `${by} が通した／${resolveLog}` }
  }
  return {
    priority: {
      stack: restStack,
      activePlayer: priority.activePlayer,
      awaitingConsentFrom: other(priority.activePlayer),
      consentedInARow: [],
    },
    log: `${by} が通した／${resolveLog}`,
  }
}

/** setMode: モード切替。free にしたら窓を畳む（assist への切替では現在の priority を維持） */
export function setMode(
  priority: PriorityState | null,
  mode: Mode,
): { priority: PriorityState | null; mode: Mode; log: string } {
  return {
    priority: mode === 'free' ? null : priority,
    mode,
    log: mode === 'free' ? 'フリーモードに切り替えた' : 'アシストモードに切り替えた',
  }
}
