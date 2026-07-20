import { useState } from 'react'
import type { BoardAction } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import { cardsInZone, modifiersFor } from '../../core/board'
import { ATTRS, type Attr } from '../../core/types'
import type { PoolCard } from '../../data/types'
import { newIid } from './useBoard'

// 右クリックメニュー（DESIGN.md §4.17）。気力±・能力値修正・裏返す・付随カード・ゴミ箱等、
// 中頻度の状態変化をここに集約する。旧 CardControls（固定右パネル）の中身をそのまま移設。
// クリックした位置の近くに浮かせる（旧: 常時右側固定パネル）。

export function CardContextMenu({
  iid,
  board,
  mySeat,
  x,
  y,
  cardOf,
  dispatch,
  onClose,
}: {
  iid: string
  board: BoardState
  /** 「自分/相手」ラベルの判定用（PHASE2.5.md §2.3） */
  mySeat: Seat
  x: number
  y: number
  cardOf: (cardId: string) => PoolCard | undefined
  dispatch: (action: BoardAction) => void
  onClose: () => void
}) {
  const instance = board.cards[iid]
  // すべてのHooksは早期returnより前で呼ぶこと（Rules of Hooks）。
  // instanceは他プレイヤーの操作（P2以降のネット同期・盤面クリア等）でレンダー間に消えることがある
  // （P1のCardControlsクラッシュと同じ罠。PHASE2.6.md §10で改めて注意喚起されている）。
  const [modStat, setModStat] = useState<Attr>('力')
  const [modDelta, setModDelta] = useState(1)
  const [modSource, setModSource] = useState('')
  const [modScope, setModScope] = useState<'このバトル' | 'ターン終了時' | '発生元依存' | 'その他'>('ターン終了時')
  const [attachTarget, setAttachTarget] = useState('')
  const [showDamage, setShowDamage] = useState(false)

  if (!instance) return null
  const card = cardOf(instance.cardId)
  const name = card?.name ?? instance.cardId
  const mods = modifiersFor(board, iid)
  const baseMax = card?.kiryoku ?? null
  const max = instance.zone === 'leader' && baseMax !== null ? baseMax * 2 : baseMax

  const attachedItems = Object.values(board.cards).filter((c) => c.attachedTo === iid)
  // 相手の手札は伏せる対象なので、相手のカードに付ける操作はここでは出さない
  const handCandidates =
    instance.owner === mySeat
      ? cardsInZone(board, instance.owner, 'hand').filter((c) => c.iid !== iid && c.attachedTo === null)
      : []

  // ビューポートからはみ出さないよう位置を寄せる
  const menuWidth = 288
  const left = Math.min(x, window.innerWidth - menuWidth - 8)
  const top = Math.min(y, window.innerHeight - 8)

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <aside
        style={{ left, top: Math.min(top, window.innerHeight - 480), maxHeight: '90vh' }}
        className="fixed z-50 flex w-72 flex-col gap-3 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-100">{name}</div>
            <div className="text-[10px] text-slate-500">
              {instance.owner === mySeat ? '自分' : '相手'} ・ {instance.zone}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200">
            ✕
          </button>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: 'toggleOrientation', iid, cardName: name })}
            className="flex-1 rounded border border-slate-600 py-1.5 hover:border-emerald-500"
          >
            {instance.orientation === 'ready' ? '待機 → 消耗' : '消耗 → 待機'}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'flip', iid, cardName: name })}
            className="flex-1 rounded border border-slate-600 py-1.5 hover:border-emerald-500"
          >
            {instance.faceUp ? '表 → 裏' : '裏 → 表'}
          </button>
        </div>

        {board.mode === 'assist' && (
          <button
            type="button"
            onClick={() => {
              dispatch({
                type: 'declareAction',
                item: { id: newIid(), by: mySeat, kind: '能力', sourceIid: iid, label: name },
              })
              onClose()
            }}
            title="汎用の宣言口（合法性は判定しない）。起動型能力だけの正式ボタンはP3a-2bで詳細パネルに作る（PHASE3a-2a.md §2-5）"
            className="rounded border border-sky-700 py-1.5 text-sky-400 hover:bg-sky-950"
          >
            ⚡ スタックに宣言
          </button>
        )}

        {baseMax !== null && (
          <section className="rounded border border-slate-700 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold text-slate-300">気力</span>
              <button
                type="button"
                onClick={() => setShowDamage((v) => !v)}
                className="text-[9px] text-slate-500 underline hover:text-slate-300"
              >
                表示: {showDamage ? 'ダメージ' : '残り気力'}（切替）
              </button>
            </div>
            {instance.kiryoku === null ? (
              <button
                type="button"
                onClick={() => dispatch({ type: 'setKiryoku', iid, value: max ?? 0, cardName: name })}
                className="w-full rounded border border-emerald-700 py-1 text-emerald-400 hover:bg-emerald-950"
              >
                気力を初期値（{max}）にする
              </button>
            ) : (
              <>
                <div className="mb-1.5 text-center text-lg font-bold text-slate-100">
                  {showDamage ? (max ?? 0) - instance.kiryoku : instance.kiryoku}
                  <span className="ml-1 text-xs font-normal text-slate-500">/ {max}</span>
                </div>
                <div className="flex justify-center gap-1">
                  {[-5, -1, 1, 5].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => dispatch({ type: 'adjustKiryoku', iid, delta: d, max: max ?? 0, cardName: name })}
                      className="rounded border border-slate-600 px-2 py-1 hover:border-emerald-500"
                    >
                      {d > 0 ? `+${d}` : d}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <section className="rounded border border-slate-700 p-2">
          <div className="mb-1 font-semibold text-slate-300">能力値修正</div>
          {mods.length > 0 && (
            <ul className="mb-2 flex flex-col gap-1">
              {mods.map((m) => (
                <li key={m.id} className="flex items-center justify-between rounded bg-slate-800 px-1.5 py-1">
                  <span className="truncate text-[10px] text-slate-300">
                    {m.sourceLabel} {m.stat ? `${m.stat}${(m.delta ?? 0) >= 0 ? '+' : ''}${m.delta}` : m.note}
                    <span className="ml-1 text-slate-500">({m.scope})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'removeModifier', modId: m.id, cardName: name })}
                    className="ml-1 text-slate-500 hover:text-red-400"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-1">
            <select
              value={modStat}
              onChange={(e) => setModStat(e.target.value as Attr)}
              className="rounded border border-slate-600 bg-slate-800 px-1 py-1"
            >
              {ATTRS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={modDelta}
              onChange={(e) => setModDelta(Number(e.target.value))}
              className="w-14 rounded border border-slate-600 bg-slate-800 px-1 py-1"
            />
            <select
              value={modScope}
              onChange={(e) => setModScope(e.target.value as typeof modScope)}
              className="rounded border border-slate-600 bg-slate-800 px-1 py-1"
            >
              <option value="このバトル">このバトル</option>
              <option value="ターン終了時">ターン終了時</option>
              <option value="発生元依存">発生元依存</option>
              <option value="その他">その他</option>
            </select>
            <input
              value={modSource}
              onChange={(e) => setModSource(e.target.value)}
              placeholder="出所（カード名等）"
              className="w-28 flex-1 rounded border border-slate-600 bg-slate-800 px-1 py-1"
            />
            <button
              type="button"
              disabled={!modSource.trim()}
              onClick={() => {
                dispatch({
                  type: 'addModifier',
                  modifier: {
                    id: newIid(),
                    targetIid: iid,
                    sourceLabel: modSource.trim(),
                    stat: modStat,
                    delta: modDelta,
                    scope: modScope,
                  },
                  cardName: name,
                })
                setModSource('')
              }}
              className="rounded border border-emerald-700 px-2 py-1 text-emerald-400 disabled:opacity-40"
            >
              追加
            </button>
          </div>
          {mods.length > 0 && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'clearModifiers', iid, cardName: name })}
              className="mt-1 w-full rounded border border-slate-700 py-1 text-[10px] text-slate-400 hover:border-red-800 hover:text-red-300"
            >
              すべての修正をクリア
            </button>
          )}
        </section>

        <section className="rounded border border-slate-700 p-2">
          <div className="mb-1 font-semibold text-slate-300">付随カード（アイテム等）</div>
          {attachedItems.length > 0 && (
            <ul className="mb-2 flex flex-col gap-1">
              {attachedItems.map((it) => (
                <li key={it.iid} className="flex items-center justify-between rounded bg-slate-800 px-1.5 py-1">
                  <span className="truncate text-[10px] text-slate-300">{cardOf(it.cardId)?.name ?? it.cardId}</span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'detach', itemIid: it.iid, itemName: cardOf(it.cardId)?.name ?? it.cardId })}
                    className="text-slate-500 hover:text-red-400"
                  >
                    取り外す
                  </button>
                </li>
              ))}
            </ul>
          )}
          {handCandidates.length > 0 && (
            <div className="flex gap-1">
              <select
                value={attachTarget}
                onChange={(e) => setAttachTarget(e.target.value)}
                className="flex-1 rounded border border-slate-600 bg-slate-800 px-1 py-1"
              >
                <option value="">手札から選ぶ…</option>
                {handCandidates.map((c) => (
                  <option key={c.iid} value={c.iid}>
                    {cardOf(c.cardId)?.name ?? c.cardId}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!attachTarget}
                onClick={() => {
                  const item = board.cards[attachTarget]
                  dispatch({
                    type: 'attach',
                    itemIid: attachTarget,
                    targetIid: iid,
                    itemName: item ? (cardOf(item.cardId)?.name ?? item.cardId) : attachTarget,
                    targetName: name,
                  })
                  setAttachTarget('')
                }}
                className="rounded border border-sky-700 px-2 py-1 text-sky-400 disabled:opacity-40"
              >
                付ける
              </button>
            </div>
          )}
        </section>

        <div className="mt-auto flex gap-2 border-t border-slate-800 pt-2">
          <button
            type="button"
            onClick={() => {
              dispatch({ type: 'toTrash', iid, cardName: name })
              onClose()
            }}
            className="flex-1 rounded border border-slate-600 py-1.5 hover:border-red-600 hover:text-red-300"
          >
            ゴミ箱へ
          </button>
          <button
            type="button"
            onClick={() => {
              dispatch({ type: 'removeCard', iid, cardName: name })
              onClose()
            }}
            className="flex-1 rounded border border-slate-600 py-1.5 hover:border-red-600 hover:text-red-300"
          >
            盤外に出す
          </button>
        </div>
      </aside>
    </>
  )
}
