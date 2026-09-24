// Modifier の表示テキストを1か所にまとめる（PHASE3d-3.md §3-4）。CardContextMenu.tsx / DetailPanel.tsx から使う。
// 🚨 純関数・React を import しない。

import type { Modifier } from '../../core/board'

/** 「力+2（ターン終了時）」「攻+2（攻防修正・このバトル）」のように kind で書き分ける */
export function modifierLabel(m: Modifier): string {
  if (m.kind === '攻防修正') {
    const sign = (m.delta ?? 0) >= 0 ? '+' : ''
    return `${m.battleStat === 'atk' ? '攻' : '防'}${sign}${m.delta ?? 0}（攻防修正・${m.scope}）`
  }
  const statPart = m.stat ? `${m.stat}${(m.delta ?? 0) >= 0 ? '+' : ''}${m.delta ?? 0}` : (m.note ?? '')
  return `${statPart}（${m.scope}）`
}
