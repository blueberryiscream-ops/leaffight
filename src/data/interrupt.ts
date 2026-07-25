// 割り込み候補の照合（主語スコープの意味論）。DESIGN.md §5.1「割り込み自動検出」/ PHASE3c.md §3。
// core/timing.ts が導出した TimingEvent に対し、あるプレイヤー視点で「割り込める札」を集める。
// 合法性・追加条件（気力N以下等）の判定はしない。候補として挙げるだけ（人間判断のフォールバック）。
//
// core/ には置かない: InterruptAnnotation はカード辞書（data層）由来の型であり、
// core/ は ui/net/data を import できない（DESIGN.md §3）。この照合は BoardState（core）と
// InterruptAnnotation（data）の両方を必要とするため、data/ 側に置く。

import type { BoardState, CardInstance, Seat } from '../core/board'
import type { TimingEvent } from '../core/timing'
import type { InterruptAnnotation, InterruptsMap } from './types'

export interface InterruptCandidate {
  /** 候補カード（キャラ本体、または装備アイテム）のiid */
  cardIid: string
  cardId: string
  annotation: InterruptAnnotation
}

// 候補札の範囲は「盤面・手札・装備アイテム」（PHASE3c.md §3）。デッキ（非公開）とゴミ箱（死亡札）は除く
const EXCLUDED_ZONES = new Set(['deck', 'trash'])

/** subjectの生テキストを解釈し、この候補カード(self)がイベントに反応できるか判定する（PHASE3c.md §3の表） */
function matchesSubject(subject: string, event: TimingEvent, self: CardInstance, board: BoardState): boolean {
  if (subject === '相手が' || subject === '相手の') return event.actor !== self.owner
  if (subject === '自分が') return event.actor === self.owner
  if (subject === '味方キャラが' || subject === '自分のキャラが') {
    if (!event.targetIid) return false
    const target = board.cards[event.targetIid]
    return !!target && target.owner === self.owner
  }
  if (subject === 'このキャラが') return event.targetIid === self.iid
  if (subject === 'このアイテムを装備したキャラが') return event.targetIid !== null && event.targetIid === self.attachedTo
  // なし・その他（表記ゆれを含む）: 主語制約なし＝タイミング一致のみで成立
  return true
}

/**
 * viewer（そのプレイヤー自身）から見て、このタイミングイベントに割り込める札の候補を集める。
 * 相手の手札等は候補に含まれない（owner!==viewerのカードは最初から見ない＝伏せ情報を漏らさない）。
 */
export function findInterruptCandidates(
  event: TimingEvent,
  viewer: Seat,
  board: BoardState,
  interrupts: InterruptsMap,
): InterruptCandidate[] {
  const candidates: InterruptCandidate[] = []
  for (const card of Object.values(board.cards)) {
    if (card.owner !== viewer) continue
    if (EXCLUDED_ZONES.has(card.zone)) continue
    const annos = interrupts[card.cardId]
    if (!annos) continue
    for (const anno of annos) {
      if (!anno.timings.includes(event.timing)) continue
      if (!matchesSubject(anno.subject, event, card, board)) continue
      candidates.push({ cardIid: card.iid, cardId: card.cardId, annotation: anno })
    }
  }
  return candidates
}
