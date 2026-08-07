import { useMemo, useState, type ReactNode } from 'react'
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
import { canDeclare, type ActionTiming } from '../../core/priority'
import type { AnnotationsMap, InterruptsMap, PoolCard } from '../../data/types'
import { CardContextMenu } from './CardContextMenu'
import { CardPicker } from './CardPicker'
import { ConnectionPanel } from './ConnectionPanel'
import { DetailPanel } from './DetailPanel'
import { DroppableSlot } from './DroppableSlot'
import { LogPanel } from './LogPanel'
import { StackedCardSlot } from './StackedCardSlot'
import { StackPanel } from './StackPanel'
import { portraitCell, squareCell, useMeasuredHeight } from './useMeasuredHeight'
import { ZoneBundle } from './ZoneBundle'
import { newIid, otherSeat, useBoard } from './useBoard'

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
  interrupts,
}: {
  cards: PoolCard[]
  imageUrls: Map<string, string>
  annotations: AnnotationsMap
  interrupts: InterruptsMap
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
  } = useBoard()
  const [selectedIid, setSelectedIid] = useState<string | null>(null)
  const [menuTarget, setMenuTarget] = useState<{ iid: string; x: number; y: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // ドラッグ拒否の一言（PHASE3a-3.md §3-1「黙って何も起きないのは不可」）。共有ログではなく
  // このクライアントだけのローカルな失敗通知（「何も起きなかった」試みを両者のログに残す
  // 必要は無い）。数秒で自動的に消す。
  const [dragNotice, setDragNotice] = useState<string | null>(null)
  const notifyDragRejected = (text: string) => {
    setDragNotice(text)
    window.setTimeout(() => setDragNotice((cur) => (cur === text ? null : cur)), 2500)
  }

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

  // rows1-5は等高（1fr）なので1つ測れば足りる。row6(手札)だけ別に測る
  const [rowRef, rowH] = useMeasuredHeight<HTMLDivElement>()
  const [handRowRef, handRowH] = useMeasuredHeight<HTMLDivElement>()
  const cellSquare = squareCell(rowH) // キャラ/リーダー/バトル（回転する＝正方形。DESIGN.md §4.18.1）
  const cellPortrait = portraitCell(rowH) // デッキ/ゴミ箱/フィールド/相手手札の帯（回転しない＝縦長）
  const handCardSize = portraitCell(handRowH)

  // PC専用。少し動いたらドラッグ開始（クリックとの競合を避ける。tcg-companion の知見＝distance:6）
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }))

  // 手札→場/ゴミ箱のドラッグは「プレイ宣言」に変える（PHASE3a-3.md §3-1）。
  // 'deck'は含めない（手札をデッキに戻すのは雑務）。'trash'は含める（イベント使用に一致する動き）。
  // 🚨 PHASE3a-4: ここは「宣言のきっかけになるか」を決めるだけで、着地先には一切影響しない。
  // プレイしたカードの行き先はカードの種別とルールが一意に決める（解決時にStackPanelが決める）。
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

    const isPlayDeclare =
      board.mode === 'assist' && instance.zone === 'hand' && PLAY_DECLARE_TARGET_ZONES.has(target.toZone)

    if (isPlayDeclare) {
      if (!canDeclare(board.priority, localSeat)) {
        // engineが受理しない状況（相手の応答待ち中等）。カードは動かさず、黙って終わらせない
        // （PHASE3a-3.md §3-1「黙って何も起きないのは不可」）。
        notifyDragRejected(`今は「${cardName}」を宣言できません（相手の応答待ち）`)
        return
      }
      const current = board.priority?.frames[board.priority.frames.length - 1]
      const actionType: ActionTiming =
        current && (current.step === 'processActive' || current.step === 'processNonActive') ? '割込型' : '通常型'
      // 🚨 どのマスに落としたかは記録しない（PHASE3a-4.md §1-1）。ドラッグの意味は
      // 「このカードをプレイすると宣言する」だけ。detailに「〜へ」と書くと着地先があるかの
      // ような誤解を生むので書かない。
      dispatch({
        type: 'declareAction',
        action: { by: localSeat, sourceIid: iid, kind: 'プレイ', actionType, label: cardName },
      })
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
            onCardClick={setSelectedIid}
            onCardContextMenu={openMenu}
            selectedIid={selectedIid}
            size={cellPortrait}
            flipped={owner !== mySeat}
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
            onCardClick={setSelectedIid}
            onCardContextMenu={openMenu}
            selectedIid={selectedIid}
            size={cellPortrait}
            flipped={owner !== mySeat}
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
                onCardClick={setSelectedIid}
                onCardContextMenu={openMenu}
                selectedIid={selectedIid}
                size={cellPortrait}
                flipped={owner !== mySeat}
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
            onCardClick={setSelectedIid}
            onCardContextMenu={openMenu}
            selectedIid={selectedIid}
            size={cellPortrait}
            flipped={inst.owner !== mySeat}
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
      cardOf={cardOf}
      imageUrlOf={imageUrlOf}
      dispatch={dispatch}
      onCardClick={setSelectedIid}
      onCardContextMenu={openMenu}
      onShuffle={opts.onShuffle}
      fanOut={opts.fanOut}
      hideContents={zone === 'hand' && owner !== mySeat}
      thin={opts.thin}
      size={cellPortrait}
      handSize={handCardSize}
      selectedIid={selectedIid}
    />
  )

  // レイアウトA: 現行6行構成（PHASE2.7.md）。中身は無変更（PHASE2.10.md §0「Aの見た目・挙動を壊さない」）。
  const renderLayoutA = () => (
    // 🚨 key必須: A⇄B切替時にDOMノードを強制的に作り直させる。同じ位置に同じ要素型(div)が
    // 並ぶだけだとReactが既存ノードを再利用し、rowRef(useMeasuredHeight)のコールバックrefが
    // 再発火せず、切替後もrowHが古いレイアウトの値のまま固まる（実機で発覚）。
    <div key="A" className="grid min-h-0 min-w-0 gap-1" style={{ gridTemplateRows: '1fr 1fr 1fr 1fr 1fr 1.6fr' }}>
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
    <div key="B" className="grid min-h-0 min-w-0 gap-1" style={{ gridTemplateRows: '1fr 1fr 1fr 1fr 1.6fr' }}>
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
      <div className="flex h-full flex-col overflow-hidden bg-slate-950 text-slate-200">
        {/* 上部の薄いチロム。原本図には無いが、接続/追加/Undo等の操作をどこかに置く必要があるため
            盤面の外（chrome）にまとめた（PHASE2.6.mdはこの種の操作の置き場を指定していないための判断）。*/}
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-3 py-1.5">
          <h1 className="text-sm font-semibold text-slate-200">🎴 対戦卓</h1>
          {mode === 'solo' && (
            <button
              type="button"
              onClick={() => setLocalSeat(theirSeat)}
              title="ひとり回し用: 自分の視点をA/Bで切り替える"
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-sky-600 hover:text-sky-300"
            >
              視点切替（現在: {mySeat}）
            </button>
          )}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-950"
          >
            ＋ カードを追加
          </button>
          <button
            type="button"
            onClick={toggleLayout}
            title="盤面レイアウトを見比べる（PHASE2.10.md。localStorageに保存）"
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-sky-600 hover:text-sky-300"
          >
            レイアウト: {layout} ⇄
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'setMode', mode: board.mode === 'assist' ? 'free' : 'assist' })}
            title="アシスト=優先権/スタックが働く。フリー=優先権オフで自由操作（DESIGN.md §5.1・共有・同期される）"
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-sky-600 hover:text-sky-300"
          >
            モード: {board.mode === 'assist' ? 'アシスト' : 'フリー'} ⇄
          </button>
          {mode !== 'guest' && (
            <>
              <button type="button" onClick={undo} disabled={!canUndo} className="rounded border border-slate-600 px-2 py-1 text-xs disabled:opacity-30">
                ↶ Undo
              </button>
              <button type="button" onClick={redo} disabled={!canRedo} className="rounded border border-slate-600 px-2 py-1 text-xs disabled:opacity-30">
                ↷ Redo
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleClearBoard}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-red-800 hover:text-red-300"
          >
            盤面クリア
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

        {dragNotice && (
          <div className="shrink-0 border-b border-amber-800 bg-amber-950/60 px-3 py-1 text-center text-xs text-amber-300">
            {dragNotice}
          </div>
        )}

        {/* 本体: 左(システム+ログ) / 中央(盤面) / [Bのみ]スタック置き場 / 右(詳細+割り込み枠)。スクロールなし */}
        <div
          className="grid min-h-0 flex-1 gap-1.5 p-1.5"
          style={{ gridTemplateColumns: layout === 'B' ? '180px 1fr 140px 300px' : '180px 1fr 300px' }}
        >
          {/* 左列 */}
          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="shrink-0 rounded border border-slate-800 bg-slate-900/60 p-2 text-[10px] text-slate-500">
              <div className="mb-1 font-semibold text-slate-400">システム</div>
              <div>ダウン数 -/-（P4）</div>
              <div>ターン -（P4）</div>
              <div>フェイズ -（P4）</div>
            </div>
            <LogPanel log={log} />
          </div>

          {/* 中央: 盤面。マスの大きさは計測したrowHeightから固定pxで決める（DESIGN.md §4.18.1） */}
          {layout === 'A' ? renderLayoutA() : renderLayoutB()}

          {/* Bのみ: スタック処理中置き場（PHASE2.10.md §1の予約枠。P3a-2aで実装） */}
          {layout === 'B' && (
            <StackPanel
              board={board}
              localSeat={localSeat}
              dispatch={dispatch}
              cardOf={cardOf}
              interrupts={interrupts}
              onSelectCard={setSelectedIid}
              imageUrlOf={imageUrlOf}
              onCardContextMenu={openMenu}
              selectedIid={selectedIid}
            />
          )}

          {/* 右列: 詳細＋能力トリガー、下部に割り込み関係/システムボタンの枠（P3で実装） */}
          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="min-h-0 flex-1 rounded border border-slate-800 bg-slate-900/60">
              <DetailPanel
                iid={selectedIid}
                board={board}
                mySeat={mySeat}
                cardOf={cardOf}
                imageUrlOf={imageUrlOf}
                annotationsOf={annotationsOf}
                dispatch={dispatch}
              />
            </div>
            {/* h-56: 提示エリア（PHASE3a-4.md §1-4）のカード1枚分＋ラベルを足したぶん高くした。
                上のDetailPanel（flex-1・内部でoverflow-y-auto）が縮むだけでページのスクロールは増えない */}
            <div className="flex h-56 shrink-0 gap-1.5">
              {/* レイアウトAのみ: 右カラム下の「割り込み関係」枠にスタック置き場を出す（Bは専用枠がある。PHASE3a-2a.md §2-1） */}
              {layout === 'A' && (
                <div className="flex-1 min-h-0">
                  <StackPanel
                    board={board}
                    localSeat={localSeat}
                    dispatch={dispatch}
                    cardOf={cardOf}
                    interrupts={interrupts}
                    onSelectCard={setSelectedIid}
                    imageUrlOf={imageUrlOf}
                    onCardContextMenu={openMenu}
                    selectedIid={selectedIid}
                  />
                </div>
              )}
              <button
                type="button"
                disabled
                title="P4で実装予定（ターン進行）"
                className="flex-1 rounded border border-slate-700 bg-slate-900/40 p-2 text-[10px] text-slate-500"
              >
                ターンエンド /<br />次フェイズへ
                <br />
                (P4で実装)
              </button>
            </div>
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
        />
      )}

      {pickerOpen && <CardPicker cards={cards} mySeat={mySeat} onPick={handlePick} onClose={() => setPickerOpen(false)} />}
    </DndContext>
  )
}
