import type { BoardAction } from '../../core/actions'
import { cardsInZone, type BoardState, type Seat } from '../../core/board'
import { shuffle } from '../../data/deck'
import type { PoolCard } from '../../data/types'

/**
 * 開始準備中の帯（PHASE5b.md §2-2）。`setup[localSeat]` があって `leaderRevealed` が false の間だけ出す。
 * R2u-2: 旧 TodoBand（優先権の窓・旧バトルの帯）を消したとき、この帯だけ残した（エンジンの間も出す）。
 */
export function SetupBand({
  board,
  localSeat,
  dispatch,
  cardOf,
}: {
  board: BoardState
  localSeat: Seat
  dispatch: (action: BoardAction) => void
  cardOf: (cardId: string) => PoolCard | undefined
}) {
  const setup = board.setup[localSeat]!
  const hand = cardsInZone(board, localSeat, 'hand')
  // 🚨 マリガンの判定はタッグを数えない。kind==='c' だけ（DESIGN.md §4.21 見本からの訂正1）
  const charCount = hand.filter((c) => cardOf(c.cardId)?.kind === 'c').length
  const canMulligan = !setup.mulliganUsed && charCount === 0
  const mulliganTitle = setup.mulliganUsed
    ? 'マリガンは1回だけ'
    : !canMulligan
      ? '手札にキャラクターカードがあるためマリガンできません'
      : undefined
  const leaderInst = cardsInZone(board, localSeat, 'leader')[0]
  const leaderName = leaderInst ? (cardOf(leaderInst.cardId)?.name ?? leaderInst.cardId) : ''

  function handleMulligan() {
    if (!confirm('マリガンします（手札を公開してすべてデッキに戻し、シャッフルして7枚引き直します）。よろしいですか？')) return
    const deckCards = cardsInZone(board, localSeat, 'deck')
    const orderedIids = shuffle([...hand, ...deckCards].map((c) => c.iid), Math.random)
    const revealedNames = hand.map((c) => cardOf(c.cardId)?.name ?? c.cardId)
    dispatch({ type: 'mulligan', owner: localSeat, orderedIids, revealedNames, draw: 7 })
  }

  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
      <span className="truncate text-sm font-bold text-accent">
        開始準備: マリガン（手札にキャラクターカードが無いときだけ）→ じゃんけん等で先攻後攻を決める → リーダーを表にする
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={!canMulligan}
          title={mulliganTitle}
          onClick={handleMulligan}
          className="lf-btn-primary shrink-0 rounded px-3 py-1 text-xs disabled:opacity-30"
        >
          マリガン
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'revealLeader', owner: localSeat, cardName: leaderName })}
          className="lf-btn-primary shrink-0 rounded px-3 py-1 text-xs"
        >
          リーダーを表にする
        </button>
      </div>
    </div>
  )
}
