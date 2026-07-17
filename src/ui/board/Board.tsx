import { useMemo, useState, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  MouseSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import type { Seat, ZoneId } from '../../core/board'
import { cardsInZone, fieldCard } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardContextMenu } from './CardContextMenu'
import { CardPicker } from './CardPicker'
import { CardPiece } from './CardPiece'
import { ConnectionPanel } from './ConnectionPanel'
import { DetailPanel } from './DetailPanel'
import { DroppableSlot } from './DroppableSlot'
import { LogPanel } from './LogPanel'
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

export function Board({ cards, imageUrls }: { cards: PoolCard[]; imageUrls: Map<string, string> }) {
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

  const mySeat: Seat = localSeat
  const theirSeat: Seat = otherSeat(localSeat)

  const cardMap = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  const cardOf = (cardId: string) => cardMap.get(cardId)
  const imageUrlOf = (cardId: string) => imageUrls.get(cardId)

  const openMenu = (iid: string, x: number, y: number) => setMenuTarget({ iid, x, y })

  // rows1-5は等高（1fr）なので1つ測れば足りる。row6(手札)だけ別に測る
  const [rowRef, rowH] = useMeasuredHeight<HTMLDivElement>()
  const [handRowRef, handRowH] = useMeasuredHeight<HTMLDivElement>()
  const cellSquare = squareCell(rowH) // キャラ/リーダー/バトル（回転する＝正方形。DESIGN.md §4.18.1）
  const cellPortrait = portraitCell(rowH) // デッキ/ゴミ箱/フィールド/相手手札の帯（回転しない＝縦長）
  const handCardSize = portraitCell(handRowH)

  // PC専用。少し動いたらドラッグ開始（クリックとの競合を避ける。tcg-companion の知見＝distance:6）
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }))

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

  const charCell = (owner: Seat, index: number) => {
    const inst = cardsInZone(board, owner, 'char').find((c) => c.index === index)
    return (
      <DroppableSlot key={`${owner}-char-${index}`} dropId={`${owner}:char:${index}`} label="キャラ" size={cellSquare}>
        {inst && (
          <CardPiece
            instance={inst}
            card={cardOf(inst.cardId)}
            imageUrl={imageUrlOf(inst.cardId)}
            board={board}
            dispatch={dispatch}
            onClick={() => setSelectedIid(inst.iid)}
            onContextMenu={(x, y) => openMenu(inst.iid, x, y)}
            selected={selectedIid === inst.iid}
            size={cellSquare}
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
          <CardPiece
            instance={inst}
            card={cardOf(inst.cardId)}
            imageUrl={imageUrlOf(inst.cardId)}
            board={board}
            dispatch={dispatch}
            onClick={() => setSelectedIid(inst.iid)}
            onContextMenu={(x, y) => openMenu(inst.iid, x, y)}
            selected={selectedIid === inst.iid}
            size={cellSquare}
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
              <CardPiece
                instance={inst}
                card={cardOf(inst.cardId)}
                imageUrl={imageUrlOf(inst.cardId)}
                board={board}
                dispatch={dispatch}
                onClick={() => setSelectedIid(inst.iid)}
                onContextMenu={(x, y) => openMenu(inst.iid, x, y)}
                selected={selectedIid === inst.iid}
                size={cellSquare}
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
          <CardPiece
            instance={inst}
            card={cardOf(inst.cardId)}
            imageUrl={imageUrlOf(inst.cardId)}
            board={board}
            dispatch={dispatch}
            onClick={() => setSelectedIid(inst.iid)}
            onContextMenu={(x, y) => openMenu(inst.iid, x, y)}
            selected={selectedIid === inst.iid}
            size={cellPortrait}
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

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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

        {/* 本体: 左(システム+ログ) / 中央(盤面) / 右(詳細+割り込み枠) の3カラム。スクロールなし */}
        <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr_300px] gap-1.5 p-1.5">
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

          {/* 中央: 盤面。6行。マスの大きさは計測したrowHeightから固定pxで決める（DESIGN.md §4.18.1） */}
          <div className="grid min-h-0 min-w-0 gap-1" style={{ gridTemplateRows: '1fr 1fr 1fr 1fr 1fr 1.6fr' }}>
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

          {/* 右列: 詳細＋能力トリガー、下部に割り込み関係/システムボタンの枠（P3で実装） */}
          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="min-h-0 flex-1 rounded border border-slate-800 bg-slate-900/60">
              <DetailPanel iid={selectedIid} board={board} mySeat={mySeat} cardOf={cardOf} imageUrlOf={imageUrlOf} />
            </div>
            <div className="flex shrink-0 gap-1.5">
              <div className="flex-1 rounded border border-dashed border-slate-700 bg-slate-950/40 p-2 text-center text-[10px] text-slate-600">
                割り込み関係
                <br />
                (P3で実装)
              </div>
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
