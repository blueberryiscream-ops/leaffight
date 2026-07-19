import type { BoardAction } from '../../core/actions'
import type { BoardState, CardInstance } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardPiece } from './CardPiece'

// アイテム付与カードの重ね表示（PHASE2.9c.md）。対象カード＋付与アイテム群を
// 「対象基準に左へオフセットして重ねる」1つの再利用コンポーネント。
// charCell/leaderCell/battleGroup/fieldCell はこれを呼ぶだけにし、
// レイアウト刷新（Layout B）でも同じ描画を使い回せるようにする（§2-2）。
//
// 🚨 重なった状態そのものを枠の中心軸で中央寄せする（呼び出し側の親がflexで中央寄せする前提）。
// 単に対象の位置から左にずらすと、枚数が増えるほど見た目が中心から外れていく。
// これを避けるため、外側のラッパーの幅を「対象幅＋アイテム枚数分のオフセット」まで
// 広げてから、DroppableSlot側のflex中央寄せに委ねる（枚数が変わるたびに自動で再中央寄せされる）。
//
// 🚨 消耗時の回転はスタック全体を1つの剛体として回す（§2-4）。ただし「外側のラッパーごと
// rotateする」実装はしない。それだと HoverPreview（P2.7で「回転しないきょうだい要素」として
// 設計した拡大ポップアップ）まで巻き込んで回ってしまう（CSS transformは子孫の描画全体に効くため、
// positionが独立していても回転からは逃れられない）。代わりに、対象・アイテムそれぞれの
// CardPiece個別にtransform-originをスタック共通の中心点に合わせて同じ角度で回す
// （＝見た目は1つの剛体として回るが、各カードの「回転しない外枠+HoverPreview」構造はそのまま保てる）。

const NOMINAL_OFFSET = 18
/** これ以上付いていると重なりが窮屈になるので、🔗個数バッジ相当の「+N」に切り替える目安 */
const MANY_THRESHOLD = 4

export function StackedCardSlot({
  target,
  items,
  cardOf,
  imageUrlOf,
  board,
  dispatch,
  onCardClick,
  onCardContextMenu,
  selectedIid,
  size,
  flipped,
}: {
  target: CardInstance
  /** targetに付与されているカード（attachedTo===target.iid）。呼び出し側でindex順にソート済みを渡す */
  items: CardInstance[]
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  board: BoardState
  dispatch: (action: BoardAction) => void
  onCardClick: (iid: string) => void
  onCardContextMenu: (iid: string, x: number, y: number) => void
  selectedIid?: string | null
  /** カードの自然な（縦向き・未回転の）サイズ(px)。呼び出し側のDroppableSlotと同じcellPortrait */
  size: { w: number; h: number }
  /** 相手が置いたカードを180°反転（PHASE2.9b.md §2-1）。targetのownerを見て呼び出し側が渡す */
  flipped?: boolean
}) {
  const n = items.length

  if (n === 0) {
    return (
      <CardPiece
        instance={target}
        card={cardOf(target.cardId)}
        imageUrl={imageUrlOf(target.cardId)}
        board={board}
        dispatch={dispatch}
        onClick={() => onCardClick(target.iid)}
        onContextMenu={(x, y) => onCardContextMenu(target.iid, x, y)}
        selected={selectedIid === target.iid}
        size={size}
        flipped={flipped}
      />
    )
  }

  // 回転後（消耗時）に正方形枠(H×H)の高さを超えないよう、余白(H-対象幅)を使い切らない範囲でオフセットを縮める。
  const maxExtra = Math.max(size.h - size.w, 0)
  const offset = Math.min(NOMINAL_OFFSET, maxExtra / n)
  const groupWidth = size.w + n * offset
  const groupCenterX = groupWidth / 2
  const originY = size.h / 2
  const pivotOrigin = (left: number) => `${groupCenterX - left}px ${originY}px`

  const rotate = (flipped ? 180 : 0) + (target.orientation === 'rested' ? -90 : 0)
  const targetLeft = groupWidth - size.w
  // 重ねが窮屈になる枚数からは🔗バッジを「+N」相当（実数）で出す。それ未満は重ね自体で見えるので隠す（0）。
  const targetBadgeOverride = n >= MANY_THRESHOLD ? n : 0

  return (
    <div className="relative shrink-0" style={{ width: groupWidth, height: size.h }}>
      {items.map((item, i) => {
        const left = groupWidth - size.w - (i + 1) * offset
        return (
          <div key={item.iid} className="absolute top-0" style={{ left, width: size.w, height: size.h, zIndex: n - i }}>
            <CardPiece
              instance={item}
              card={cardOf(item.cardId)}
              imageUrl={imageUrlOf(item.cardId)}
              board={board}
              dispatch={dispatch}
              onClick={() => onCardClick(item.iid)}
              onContextMenu={(x, y) => onCardContextMenu(item.iid, x, y)}
              selected={selectedIid === item.iid}
              size={size}
              // スタック内のアイテムは個別ドラッグを無効化する。ドラッグするとzone/indexだけ変わり
              // attachedToはcore仕様上そのまま（P2.9c.md §0）なので、見た目は外れたのに実は
              // 付いたままという分かりにくい状態になってしまう。取り外しは右クリックの「取り外す」を使う。
              dragDisabled
              groupRotate={{ deg: rotate, origin: pivotOrigin(left) }}
            />
          </div>
        )
      })}
      <div className="absolute top-0" style={{ left: targetLeft, width: size.w, height: size.h, zIndex: n + 1 }}>
        <CardPiece
          instance={target}
          card={cardOf(target.cardId)}
          imageUrl={imageUrlOf(target.cardId)}
          board={board}
          dispatch={dispatch}
          onClick={() => onCardClick(target.iid)}
          onContextMenu={(x, y) => onCardContextMenu(target.iid, x, y)}
          selected={selectedIid === target.iid}
          size={size}
          groupRotate={{ deg: rotate, origin: pivotOrigin(targetLeft) }}
          attachBadgeOverride={targetBadgeOverride}
        />
      </div>
    </div>
  )
}
