import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  MouseSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import type { Seat, ZoneId } from '../../core/board'
import { cardsInZone, fieldCard } from '../../core/board'
import { nearestBattle } from '../../core/proc'
import type { AnnotationsMap, PoolCard } from '../../data/types'
import { BattlePanel } from './BattlePanel'
import { CardContextMenu } from './CardContextMenu'
import { CardPicker } from './CardPicker'
import { ConnectionPanel } from './ConnectionPanel'
import { DetailPanel } from './DetailPanel'
import { DroppableSlot } from './DroppableSlot'
import { LogPanel } from './LogPanel'
import { SetupBand } from './SetupBand'
import { StackedCardSlot } from './StackedCardSlot'
import { StartWithDeckDialog } from './StartWithDeckDialog'
import { cellSizeForB, portraitCell, squareCell, useMeasuredHeight, useMeasuredWidth } from './useMeasuredHeight'
import { ZoneBundle } from './ZoneBundle'
import { newIid, otherSeat, useBoard } from './useBoard'
import { EngineBar, stepLine } from '../engine/EngineBar'
import { buildEngineCtx } from '../engine/host'
import { ProcPanel } from '../engine/ProcPanel'
import { useEngineUI } from '../engine/useEngineUI'
import type { CardDef } from '../../engine/dsl'
import { currentStats, layersOn, maxKiryokuOf } from '../../engine/layers'

// 盤面レイアウト（PHASE2.7.md。原本図 _local/reference/layout_sketch.png.png が正）。
// 🚨 マスをflex-1で引き伸ばさない（PHASE2.6の元凶）。マスの大きさはrowHeightから計算した
// 固定pxで決め、各行を「1fr auto 1fr」の3列グリッドにして中央のクラスタ/フィールドを
// 盤面の水平中央に固定する（DESIGN.md §4.18.1・§4.18.2）。

type DropTarget = { toZone: ZoneId; toOwner?: Seat; toIndex?: number }

function parseDropId(id: string): DropTarget | null {
  if (id === 'field') return { toZone: 'field' }
  const parts = id.split(':')
  if (parts.length === 2) return { toOwner: parts[0] as Seat, toZone: parts[1] as ZoneId }
  if (parts.length === 3) return { toOwner: parts[0] as Seat, toZone: parts[1] as ZoneId, toIndex: Number(parts[2]) }
  return null
}

/**
 * closestCenter単体だと、手札のような「実際に占有している幅より広いドロップ判定領域」を持つ
 * ゾーンの端（空いて見える部分）にドロップしたとき、中心座標が近いだけの別の（小さい）ゾーンに
 * 奪われる（PHASE2.8.md §4）。ポインタが実際に入っている領域を優先し、どこにも入っていない
 * ときだけ最近傍にフォールバックする。
 */
const collisionDetectionStrategy: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  if (pointerCollisions.length > 0) return pointerCollisions
  return closestCenter(args)
}

/**
 * 行を「1fr auto 1fr」の3列にし、中央列(cluster/field)を盤面の水平中央に固定する（DESIGN.md §4.18.2）。
 * 行自体の高さは自分では持たない（親の6行グリッドのfr配分に任せる）。h-fullで受け取るだけ。
 * 🚨 ここで height を自分のstyleに設定すると、rowHeight計測用のrefと循環参照になり、
 * 常に高さ0で固まる（実際に踏んだ。IMPLEMENTATION-NOTES.md参照）。
 */
function CenterRow({
  left,
  leftAlign = 'start',
  center,
  right,
  rightAlign = 'start',
  rowRef,
}: {
  left?: ReactNode
  leftAlign?: 'start' | 'end'
  center: ReactNode
  right?: ReactNode
  rightAlign?: 'start' | 'end'
  rowRef?: React.Ref<HTMLDivElement>
}) {
  return (
    <div ref={rowRef} className="grid h-full min-h-0 min-w-0" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
      <div className={`flex min-w-0 items-center gap-1 ${leftAlign === 'end' ? 'justify-end' : 'justify-start'}`}>{left}</div>
      <div className="flex min-w-0 items-center justify-center gap-1">{center}</div>
      <div className={`flex min-w-0 items-center gap-1 ${rightAlign === 'end' ? 'justify-end' : 'justify-start'}`}>{right}</div>
    </div>
  )
}

export function Board({
  cards,
  imageUrls,
  annotations,
  cardDefs = {},
}: {
  cards: PoolCard[]
  imageUrls: Map<string, string>
  annotations: AnnotationsMap
  /** カードの記述（carddefs.json）。R2u のエンジンの材料 */
  cardDefs?: Record<string, unknown>
}) {
  const {
    board,
    log,
    canUndo,
    canRedo,
    dispatch,
    undo,
    redo,
    resetBoard,
    mode,
    connStatus,
    connError,
    roomCode,
    connectHost,
    connectGuest,
    disconnect,
    localSeat,
    setLocalSeat,
    engineRequest,
    setEngineCtx,
    engineSteps,
    engineNotice,
    clearEngineNotice,
  } = useBoard()
  // R2u: エンジンの材料。乱数（シャッフル）は ui 側で作って渡す（PHASE-R2u §1）
  const engineCtx = useMemo(
    () =>
      buildEngineCtx(cards, cardDefs as Record<string, CardDef>, (iids) => {
        const a = [...iids]
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[a[i], a[j]] = [a[j], a[i]]
        }
        return a
      }),
    [cards, cardDefs],
  )
  useEffect(() => setEngineCtx(engineCtx), [engineCtx, setEngineCtx])
  // R2u §3-3: 宣言の入口・対象・支払い・選択肢を盤面のクリックで（このクライアントだけの状態）
  const ui = useEngineUI({ board, ctx: engineCtx, localSeat, solo: mode === 'solo', engineRequest })
  const engineActionsFor = (iid: string | null) => (iid && ui.on ? ui.declsFor(iid).map((d) => ({ label: d.label, onClick: () => ui.start(d) })) : [])
  const nameOfId = (id: string) => cardMap.get(id)?.name ?? id
  const [selectedIid, setSelectedIid] = useState<string | null>(null)
  const [menuTarget, setMenuTarget] = useState<{ iid: string; x: number; y: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [startWithDeckOpen, setStartWithDeckOpen] = useState(false)
  // レイアウトA(現行・6行)/B(段数削減・4行)の実行時切替（PHASE2.10.md）。localStorageで保持、既定はA。
  const [layout, setLayout] = useState<'A' | 'B'>(
    () => (localStorage.getItem('lf.layout') as 'A' | 'B' | null) ?? 'A',
  )
  const toggleLayout = () => {
    const next = layout === 'A' ? 'B' : 'A'
    setLayout(next)
    localStorage.setItem('lf.layout', next)
  }

  const mySeat: Seat = localSeat
  const theirSeat: Seat = otherSeat(localSeat)

  const cardMap = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  const cardOf = (cardId: string) => cardMap.get(cardId)
  const imageUrlOf = (cardId: string) => imageUrls.get(cardId)
  const annotationsOf = (cardId: string) => annotations[cardId]

  const openMenu = (iid: string, x: number, y: number) => setMenuTarget({ iid, x, y })

  function handleCardClick(iid: string) {
    // エンジンモード: 対象・支払い・選択肢（バトルの参加キャラ・種目を含む procMeta.choice）の候補なら、そのクリックはエンジンの入力（R2u §2-1・§3-3）
    ui.click(iid)
    setSelectedIid(iid)
  }

  /** リング表示（対象・支払い・選択の候補）。候補でなければ何も返さない（対象カードの見た目は変えない） */
  const ringProps = (iid: string) => ui.ring(iid)

  // rows1-5は等高（1fr）なので1つ測れば足りる。row6(手札)だけ別に測る
  const [rowRef, rowH] = useMeasuredHeight<HTMLDivElement>()
  const [handRowRef, handRowH] = useMeasuredHeight<HTMLDivElement>()
  const [boardBRef, boardBW] = useMeasuredWidth<HTMLDivElement>()
  const cellH = layout === 'B' ? cellSizeForB(rowH, boardBW) : rowH
  const cellSquare = squareCell(cellH) // キャラ/リーダー/バトル（回転する＝正方形。DESIGN.md §4.18.1）
  const cellPortrait = portraitCell(cellH) // デッキ/ゴミ箱/フィールド/相手手札の帯（回転しない＝縦長）
  const handCardSize = portraitCell(handRowH)

  // PC専用。少し動いたらドラッグ開始（クリックとの競合を避ける。tcg-companion の知見＝distance:6）
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }))

  // エンジンモード: 手札→場/ゴミ箱のドラッグは「そのカードを使う宣言」に変える（PHASE3a-3.md §3-1・R2u §3-3）。
  // 'deck'は含めない（手札をデッキに戻すのは雑務）。'trash'は含める（イベント使用に一致する動き）。
  // 🚨 ここは「宣言のきっかけになるか」を決めるだけで、着地先には一切影響しない（行き先は手順が決める）。
  const PLAY_DECLARE_TARGET_ZONES = new Set<ZoneId>(['char', 'leader', 'battle', 'field', 'trash'])

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over) return
    const iid = String(active.id)
    const instance = board.cards[iid]
    if (!instance) return
    const target = parseDropId(String(over.id))
    if (!target) return

    const samePlace =
      instance.zone === target.toZone &&
      (target.toOwner === undefined || instance.owner === target.toOwner) &&
      (target.toIndex === undefined || instance.index === target.toIndex)
    if (samePlace) return

    const cardName = cardOf(instance.cardId)?.name ?? instance.cardId

    // エンジンモード: 手札から盤面へのドラッグ＝そのカードを使う宣言（R2u §3-3）。カードは動かさない（行き先は手順が決める）
    if (board.mode === 'engine' && instance.zone === 'hand' && PLAY_DECLARE_TARGET_ZONES.has(target.toZone)) {
      ui.startFor(iid)
      return
    }

    dispatch({
      type: 'moveCard',
      iid,
      toOwner: target.toOwner,
      toZone: target.toZone,
      toIndex: target.toIndex,
      cardName,
    })
  }

  function handleShuffle(owner: Seat) {
    const deckIids = Object.values(board.cards)
      .filter((c) => c.owner === owner && c.zone === 'deck')
      .map((c) => c.iid)
    // 乱数はここ（ui）で消費し、結果の並びだけを core に渡す（core純粋性のため）
    for (let i = deckIids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[deckIids[i], deckIids[j]] = [deckIids[j], deckIids[i]]
    }
    dispatch({ type: 'shuffleDeck', owner, orderedIids: deckIids })
  }

  function handlePick(card: PoolCard, owner: Seat, zone: ZoneId) {
    dispatch({ type: 'spawnCard', iid: newIid(), cardId: card.id, cardName: card.name, owner, zone })
  }

  // 「デッキで始める」ボタンの押せる/押せない（PHASE5b.md §2-1）。手順（proc）の処理中は
  // 盤面を差し替えると参照が壊れるため押せない（core側の startWithDeck も同じ条件で弾く）
  const startWithDeckBlocked = board.proc.length > 0 ? '手順の処理中は使えません' : null
  const hasOwnCards = Object.values(board.cards).some((c) => c.owner === mySeat)

  function handleClearBoard() {
    if (!confirm('盤面をすべてクリアします。よろしいですか？')) return
    setSelectedIid(null)
    setMenuTarget(null)
    resetBoard()
  }

  // 対象に付与されているアイテム（StackedCardSlotへ渡す。PHASE2.9c.md §2-2）。安定した並びにするためindex順。
  const attachedItemsOf = (targetIid: string) =>
    Object.values(board.cards)
      .filter((c) => c.attachedTo === targetIid)
      .sort((a, b) => a.index - b.index)

  // 参加キャラ／バトル種目カードに⚔バッジを出す（PHASE3d-2b §1）。付随アイテムには出さない
  // （StackedCardSlotのtargetにだけ渡す）。バトル（proc の battle フレーム）が無ければ常にfalse。
  const battleNow = nearestBattle(board)?.battle
  const isBattleMarked = (iid: string) =>
    !!battleNow && (battleNow.participants.A.includes(iid) || battleNow.participants.B.includes(iid) || battleNow.battleCard === iid)

  const charCell = (owner: Seat, index: number) => {
    const inst = cardsInZone(board, owner, 'char').find((c) => c.index === index)
    return (
      <DroppableSlot key={`${owner}-char-${index}`} dropId={`${owner}:char:${index}`} label="キャラ" size={cellSquare}>
        {inst && (
          <StackedCardSlot
            target={inst}
            items={attachedItemsOf(inst.iid)}
            cardOf={cardOf}
            imageUrlOf={imageUrlOf}
            board={board}
            dispatch={dispatch}
            onCardClick={handleCardClick}
            onCardContextMenu={openMenu}
            selectedIid={selectedIid}
            size={cellPortrait}
            flipped={owner !== mySeat}
            battleBadge={isBattleMarked(inst.iid)}
            {...ringProps(inst.iid)}
          />
        )}
      </DroppableSlot>
    )
  }

  const leaderCell = (owner: Seat) => {
    const inst = cardsInZone(board, owner, 'leader')[0]
    return (
      <DroppableSlot dropId={`${owner}:leader:0`} label="リーダー" size={cellSquare}>
        {inst && (
          <StackedCardSlot
            target={inst}
            items={attachedItemsOf(inst.iid)}
            cardOf={cardOf}
            imageUrlOf={imageUrlOf}
            board={board}
            dispatch={dispatch}
            onCardClick={handleCardClick}
            onCardContextMenu={openMenu}
            selectedIid={selectedIid}
            size={cellPortrait}
            flipped={owner !== mySeat}
            battleBadge={isBattleMarked(inst.iid)}
            {...ringProps(inst.iid)}
          />
        )}
      </DroppableSlot>
    )
  }

  const battleGroup = (owner: Seat) => (
    <>
      {[0, 1, 2].map((i) => {
        const inst = cardsInZone(board, owner, 'battle').find((c) => c.index === i)
        return (
          <DroppableSlot key={`${owner}-battle-${i}`} dropId={`${owner}:battle:${i}`} label="バトル" size={cellSquare}>
            {inst && (
              <StackedCardSlot
                target={inst}
                items={attachedItemsOf(inst.iid)}
                cardOf={cardOf}
                imageUrlOf={imageUrlOf}
                board={board}
                dispatch={dispatch}
                onCardClick={handleCardClick}
                onCardContextMenu={openMenu}
                selectedIid={selectedIid}
                size={cellPortrait}
                flipped={owner !== mySeat}
                battleBadge={isBattleMarked(inst.iid)}
                {...ringProps(inst.iid)}
              />
            )}
          </DroppableSlot>
        )
      })}
    </>
  )

  const fieldCell = () => {
    const inst = fieldCard(board)
    return (
      <DroppableSlot dropId="field" label="フィールド" emphasize size={cellPortrait}>
        {inst && (
          <StackedCardSlot
            target={inst}
            items={attachedItemsOf(inst.iid)}
            cardOf={cardOf}
            imageUrlOf={imageUrlOf}
            board={board}
            dispatch={dispatch}
            onCardClick={handleCardClick}
            onCardContextMenu={openMenu}
            selectedIid={selectedIid}
            size={cellPortrait}
            flipped={inst.owner !== mySeat}
            {...ringProps(inst.iid)}
          />
        )}
      </DroppableSlot>
    )
  }

  const zoneBundle = (
    owner: Seat,
    zone: 'deck' | 'hand' | 'trash',
    opts: { fanOut?: boolean; thin?: boolean; onShuffle?: () => void } = {},
  ) => (
    <ZoneBundle
      owner={owner}
      zone={zone}
      board={board}
      mySeat={mySeat}
      cardOf={cardOf}
      imageUrlOf={imageUrlOf}
      dispatch={dispatch}
      onCardClick={handleCardClick}
      onCardContextMenu={openMenu}
      onShuffle={opts.onShuffle}
      fanOut={opts.fanOut}
      hideContents={zone === 'hand' && owner !== mySeat}
      thin={opts.thin}
      size={cellPortrait}
      handSize={handCardSize}
      selectedIid={selectedIid}
      ringOf={ui.on ? ui.ring : undefined}
    />
  )

  // レイアウトA: 現行6行構成（PHASE2.7.md）。中身は無変更（PHASE2.10.md §0「Aの見た目・挙動を壊さない」）。
  const renderLayoutA = () => (
    // 🚨 key必須: A⇄B切替時にDOMノードを強制的に作り直させる。同じ位置に同じ要素型(div)が
    // 並ぶだけだとReactが既存ノードを再利用し、rowRef(useMeasuredHeight)のコールバックrefが
    // 再発火せず、切替後もrowHが古いレイアウトの値のまま固まる（実機で発覚）。
    <div key="A" className="grid min-h-0 min-w-0 gap-1" style={{ gridTemplateRows: 'repeat(5, minmax(0, 1fr)) minmax(0, 1.6fr)' }}>
      {/* 行1: 相手の外側列。中央=相手キャラ3枚のクラスタ、左=手札(帯)、右=ゴミ箱/デッキ */}
      <CenterRow
        rowRef={rowRef}
        left={zoneBundle(theirSeat, 'hand', { thin: true })}
        leftAlign="start"
        center={
          <>
            {charCell(theirSeat, 0)}
            {charCell(theirSeat, 1)}
            {charCell(theirSeat, 2)}
          </>
        }
        right={
          <>
            {zoneBundle(theirSeat, 'trash')}
            {zoneBundle(theirSeat, 'deck')}
          </>
        }
        rightAlign="start"
      />

      {/* 行2: 相手の内側列。中央=相手キャラ+リーダーのクラスタ */}
      <CenterRow
        center={
          <>
            {charCell(theirSeat, 3)}
            {leaderCell(theirSeat)}
            {charCell(theirSeat, 4)}
          </>
        }
      />

      {/* 行3: 共有中央行。中央=フィールド共有1枚、左右にバトル×3ずつ */}
      <CenterRow
        left={battleGroup(theirSeat)}
        leftAlign="end"
        center={fieldCell()}
        right={battleGroup(mySeat)}
        rightAlign="start"
      />

      {/* 行4: 自分の内側列。中央=自分キャラ3枚のクラスタ */}
      <CenterRow
        center={
          <>
            {charCell(mySeat, 0)}
            {charCell(mySeat, 1)}
            {charCell(mySeat, 2)}
          </>
        }
      />

      {/* 行5: 自分の外側列。中央=自分キャラ+リーダーのクラスタ、左=ゴミ箱/デッキ、右=空き(スタック候補) */}
      <CenterRow
        left={
          <>
            {zoneBundle(mySeat, 'trash')}
            {zoneBundle(mySeat, 'deck', { onShuffle: () => handleShuffle(mySeat) })}
          </>
        }
        leftAlign="end"
        center={
          <>
            {charCell(mySeat, 3)}
            {leaderCell(mySeat)}
            {charCell(mySeat, 4)}
          </>
        }
      />

      {/* 行6: 自分の手札（大きく・扇状） */}
      <div ref={handRowRef} className="flex min-h-0 min-w-0 items-stretch">
        {zoneBundle(mySeat, 'hand', { fanOut: true })}
      </div>
    </div>
  )

  // レイアウトB: 段数削減版（PHASE2.10.md）。各プレイヤー2行（外側=ゴミ箱/デッキ/フィールドorハンド帯
  // +キャラ3・リーダー・キャラ4、内側=バトル×3+キャラ0/1/2）。共有だったバトル行を廃止し、
  // 各プレイヤー自身のバトルを内側行の左へ寄せる。向き(P2.9b)・アイテム重ね(P2.9c)は
  // charCell等のヘルパーが担うのでAと共通のまま自動的に効く。
  const renderLayoutB = () => (
    <div key="B" ref={boardBRef} className="grid min-h-0 min-w-0 gap-1" style={{ gridTemplateRows: 'repeat(4, minmax(0, 1fr)) minmax(0, 1.6fr)' }}>
      {/* 行1: 相手の外側列。中央=相手キャラ3・リーダー・キャラ4、左=ゴミ箱/デッキ/手札(帯) */}
      <CenterRow
        rowRef={rowRef}
        left={
          <>
            {zoneBundle(theirSeat, 'trash')}
            {zoneBundle(theirSeat, 'deck')}
            {zoneBundle(theirSeat, 'hand', { thin: true })}
          </>
        }
        leftAlign="end"
        center={
          <>
            {charCell(theirSeat, 3)}
            {leaderCell(theirSeat)}
            {charCell(theirSeat, 4)}
          </>
        }
      />

      {/* 行2: 相手の内側列。左=相手バトル×3、中央=相手キャラ0/1/2 */}
      <CenterRow
        left={battleGroup(theirSeat)}
        leftAlign="end"
        center={
          <>
            {charCell(theirSeat, 0)}
            {charCell(theirSeat, 1)}
            {charCell(theirSeat, 2)}
          </>
        }
      />

      {/* 行3: 自分の内側列。左=自分バトル×3、中央=自分キャラ0/1/2 */}
      <CenterRow
        left={battleGroup(mySeat)}
        leftAlign="end"
        center={
          <>
            {charCell(mySeat, 0)}
            {charCell(mySeat, 1)}
            {charCell(mySeat, 2)}
          </>
        }
      />

      {/* 行4: 自分の外側列。中央=自分キャラ3・リーダー・キャラ4、左=ゴミ箱/デッキ/フィールド(共有1枚) */}
      <CenterRow
        left={
          <>
            {zoneBundle(mySeat, 'trash')}
            {zoneBundle(mySeat, 'deck', { onShuffle: () => handleShuffle(mySeat) })}
            {fieldCell()}
          </>
        }
        leftAlign="end"
        center={
          <>
            {charCell(mySeat, 3)}
            {leaderCell(mySeat)}
            {charCell(mySeat, 4)}
          </>
        }
      />

      {/* 行5: 自分の手札（大きく・扇状） */}
      <div ref={handRowRef} className="flex min-h-0 min-w-0 items-stretch">
        {zoneBundle(mySeat, 'hand', { fanOut: true })}
      </div>
    </div>
  )

  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetectionStrategy} onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col overflow-hidden text-ink">
        {/* 上部の薄いチロム。原本図には無いが、接続/追加/Undo等の操作をどこかに置く必要があるため
            盤面の外（chrome）にまとめた（PHASE2.6.mdはこの種の操作の置き場を指定していないための判断）。*/}
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5">
          <h1 className="text-sm font-semibold text-ink">🎴 対戦卓</h1>
          {mode === 'solo' && (
            <button
              type="button"
              onClick={() => setLocalSeat(theirSeat)}
              title="ひとり回し用: 自分の視点をA/Bで切り替える"
              className="rounded border border-line-strong px-2 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent"
            >
              視点切替（現在: {mySeat}）
            </button>
          )}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded border border-ok px-2 py-1 text-xs text-ok hover:bg-ok/15"
          >
            ＋ カードを追加
          </button>
          <button
            type="button"
            onClick={toggleLayout}
            title="盤面レイアウトを見比べる（PHASE2.10.md。localStorageに保存）"
            className="rounded border border-line-strong px-2 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent"
          >
            レイアウト: {layout} ⇄
          </button>
          {mode !== 'guest' && (
            <>
              <button type="button" onClick={undo} disabled={!canUndo} className="rounded border border-line-strong px-2 py-1 text-xs disabled:opacity-30">
                ↶ Undo
              </button>
              <button type="button" onClick={redo} disabled={!canRedo} className="rounded border border-line-strong px-2 py-1 text-xs disabled:opacity-30">
                ↷ Redo
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleClearBoard}
            className="rounded border border-line-strong px-2 py-1 text-xs text-ink-muted hover:border-danger hover:text-danger"
          >
            盤面クリア
          </button>
          <button
            type="button"
            disabled={startWithDeckBlocked !== null}
            title={startWithDeckBlocked ?? undefined}
            onClick={() => setStartWithDeckOpen(true)}
            className="rounded border border-accent px-2 py-1 text-xs text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-30"
          >
            デッキで始める
          </button>
          <div className="ml-auto">
            <ConnectionPanel
              mode={mode}
              connStatus={connStatus}
              connError={connError}
              roomCode={roomCode}
              onHost={() => void connectHost()}
              onJoin={(code) => void connectGuest(code)}
              onDisconnect={disconnect}
            />
          </div>
        </div>

        {/* 大きな「今やること」帯（PHASE3d-3.md §5）。チロムの直下・盤面の上に全幅で置く。高さ固定（shrink-0） */}
        {/* R2u: エンジン⇄手動・鳴き無し・宣言の番・選択・段の表示（PHASE-R2u §3-3） */}
        <EngineBar
          board={board}
          localSeat={localSeat}
          solo={mode === 'solo'}
          ctx={engineCtx}
          ui={ui}
          nameOf={nameOfId}
          engineRequest={engineRequest}
          dispatch={dispatch}
          steps={engineSteps}
          notice={engineNotice}
          clearNotice={clearEngineNotice}
        />
        {/* 開始準備（P5b: マリガン・リーダーを表にする）の帯。済んだら EngineBar の「先攻 A/B で始める」 */}
        {board.setup[localSeat] && !board.setup[localSeat]!.leaderRevealed && (
          <SetupBand board={board} localSeat={localSeat} dispatch={dispatch} cardOf={cardOf} />
        )}


        {/* 本体: 左(システム+ログ) / 中央(盤面) / [Bのみ]スタック置き場 / 右(詳細+割り込み枠)。スクロールなし */}
        <div
          className="grid min-h-0 flex-1 gap-1.5 p-1.5"
          style={{ gridTemplateColumns: layout === 'B' ? '180px 1fr 140px 300px' : '180px 1fr 300px' }}
        >
          {/* 左列 */}
          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="lf-panel shrink-0 p-2 text-[10px] text-ink-muted">
              <div className="mb-1 font-semibold text-ink-muted">システム</div>
              <div>ダウン数 A:{board.downs.A} / B:{board.downs.B}</div>
              <div>ターン {board.turn?.n ?? '-'}（AP {board.turn?.active ?? '-'}）</div>
              <div>フェイズ {board.turn?.phase ?? '-'}</div>
            </div>
            <LogPanel log={log} stepText={(s) => stepLine(board, localSeat, nameOfId, s)} />
          </div>

          {/* 中央: 盤面。マスの大きさは計測したrowHeightから固定pxで決める（DESIGN.md §4.18.1） */}
          {layout === 'A' ? renderLayoutA() : renderLayoutB()}

          {/* Bのみ: 手順（proc）の置き場（PHASE2.10.md §1の予約枠）。手動の間も今の手順を出す */}
          {layout === 'B' && <ProcPanel board={board} localSeat={localSeat} nameOf={nameOfId} />}

          {/* 右列: バトルパネル＋詳細＋能力トリガー、下部に割り込み関係/システムボタンの枠（P3で実装） */}
          <div className="flex min-h-0 flex-col gap-1.5">
            <BattlePanel
              board={board}
              localSeat={localSeat}
              solo={mode === 'solo'}
              ctx={engineCtx}
              ui={ui}
              nameOf={nameOfId}
              engineRequest={engineRequest}
              onSelectCard={setSelectedIid}
            />
            <div className="lf-panel min-h-0 flex-1">
              <DetailPanel
                iid={selectedIid}
                board={board}
                mySeat={mySeat}
                cardOf={cardOf}
                imageUrlOf={imageUrlOf}
                annotationsOf={annotationsOf}
                engineActions={engineActionsFor(selectedIid)}
                derived={
                  ui.on && selectedIid && board.cards[selectedIid]
                    ? { stats: currentStats(engineCtx, board, selectedIid), max: maxKiryokuOf(engineCtx, board, selectedIid), layers: layersOn(engineCtx, board, selectedIid) }
                    : null
                }
              />
            </div>
            {/* レイアウトAのみ: 右カラム下に手順（proc）の置き場（Bは専用枠がある。PHASE3a-2a.md §2-1）。
                上のDetailPanel（flex-1・内部でoverflow-y-auto）が縮むだけでページのスクロールは増えない */}
            {layout === 'A' && (
              <div className="h-56 shrink-0">
                <ProcPanel board={board} localSeat={localSeat} nameOf={nameOfId} />
              </div>
            )}
          </div>
        </div>
      </div>

      {menuTarget && (
        <CardContextMenu
          iid={menuTarget.iid}
          board={board}
          mySeat={mySeat}
          x={menuTarget.x}
          y={menuTarget.y}
          cardOf={cardOf}
          dispatch={dispatch}
          onClose={() => setMenuTarget(null)}
          engineActions={engineActionsFor(menuTarget.iid)}
        />
      )}

      {pickerOpen && <CardPicker cards={cards} mySeat={mySeat} onPick={handlePick} onClose={() => setPickerOpen(false)} />}

      {startWithDeckOpen && (
        <StartWithDeckDialog
          cardById={cardMap}
          mySeat={mySeat}
          hasOwnCards={hasOwnCards}
          dispatch={dispatch}
          onClose={() => setStartWithDeckOpen(false)}
        />
      )}
    </DndContext>
  )
}
