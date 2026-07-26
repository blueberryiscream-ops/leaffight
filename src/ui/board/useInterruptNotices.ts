import { useEffect, useRef, useState } from 'react'
import type { BoardState, Seat } from '../../core/board'
import { deriveTimingEvents } from '../../core/timing'
import { findInterruptCandidates, type InterruptCandidate } from '../../data/interrupt'
import type { InterruptsMap, PoolCard } from '../../data/types'

// 割り込み自動検出 v1（DESIGN.md §5.1「⭐割り込み自動検出」/ PHASE3c.md）。
// 「候補が1件以上あるプレイヤーにだけ通知を出す。0件なら何も出さない」が目的（§4）。
// エンジン（core/priority.ts）は無改造。ここはあくまで「提案」を作るだけで、
// 候補クリックは既存の declareAction を通常のフローに乗せる。

export interface InterruptNotice {
  id: string
  timing: string
  candidates: InterruptCandidate[]
}

let noticeSeq = 0

export function useInterruptNotices(
  board: BoardState,
  localSeat: Seat,
  cardOf: (cardId: string) => PoolCard | undefined,
  interrupts: InterruptsMap,
) {
  const [notices, setNotices] = useState<InterruptNotice[]>([])
  const prevBoardRef = useRef<BoardState | null>(null)

  useEffect(() => {
    const prev = prevBoardRef.current
    prevBoardRef.current = board
    // 初回マウント時は「差分」が無いので何もしない
    if (!prev || prev === board) return
    // mode==='free'では出さない（PHASE3c.md §4）
    if (board.mode === 'free') return

    // 🚨 core/timing.ts の cardKindOf は引数名こそ cardId だが、実際に渡ってくるのは
    // DeclaredAction.sourceIid（CardInstanceのiid。PHASE3a-3.md §7で確認された既知の紛らわしさ）。
    // iidからPoolCardの種別を引くには一段挟んでcardIdに変換する必要がある（P3a-3以前はkind='プレイ'の
    // 宣言経路自体が存在せず、この変換漏れは実害が無かった。手札プレイの自動宣言でここが初めて生きる）。
    const cardKindOf = (iid: string) => {
      const inst = board.cards[iid] ?? prev.cards[iid]
      return inst ? cardOf(inst.cardId)?.kind : undefined
    }
    const events = deriveTimingEvents(prev, board, cardKindOf)
    const found: InterruptNotice[] = []
    for (const event of events) {
      const candidates = findInterruptCandidates(event, localSeat, board, interrupts)
      if (candidates.length === 0) continue // 候補0件なら静か（＝これが目的）
      found.push({ id: `notice_${++noticeSeq}`, timing: event.timing, candidates })
    }
    if (found.length > 0) {
      setNotices((prevNotices) => [...prevNotices, ...found])
    }
  }, [board, localSeat, cardOf, interrupts])

  // フリーモードに切り替えたら、溜まっていた通知も一緒に畳む
  useEffect(() => {
    if (board.mode === 'free') setNotices([])
  }, [board.mode])

  const dismiss = (id: string) => setNotices((prev) => prev.filter((n) => n.id !== id))

  return { notices, dismiss }
}
