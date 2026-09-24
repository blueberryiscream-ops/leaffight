import { useState } from 'react'
import type { BoardAction } from '../../core/actions'
import type { BoardState, ModifierKind, Seat } from '../../core/board'
import { cardsInZone, maxKiryokuFor, modifiersFor } from '../../core/board'
import { ATTRS, type Attr } from '../../core/types'
import type { PoolCard } from '../../data/types'
import { modifierLabel } from './modifierLabel'
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
  const [modKind, setModKind] = useState<ModifierKind>('能力値修正')
  const [modStat, setModStat] = useState<Attr>('力')
  const [modBattleStat, setModBattleStat] = useState<'atk' | 'def'>('atk')
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
  const max = maxKiryokuFor(instance.zone, baseMax)

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
        className="fixed z-50 flex w-72 flex-col gap-3 overflow-y-auto rounded-lg border border-line-strong bg-surface-1 p-3 text-xs shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-ink">{name}</div>
            <div className="text-[10px] text-ink-muted">
              {instance.owner === mySeat ? '自分' : '相手'} ・ {instance.zone}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-ink-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: 'toggleOrientation', iid, cardName: name })}
            className="flex-1 rounded border border-line-strong py-1.5 hover:border-ok"
          >
            {instance.orientation === 'ready' ? '待機 → 消耗' : '消耗 → 待機'}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'flip', iid, cardName: name })}
            className="flex-1 rounded border border-line-strong py-1.5 hover:border-ok"
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
                action: { by: mySeat, kind: '能力', actionType: '通常型', sourceIid: iid, label: name },
              })
              onClose()
            }}
            title="汎用の宣言口（合法性は判定しない）。起動型能力だけの正式ボタンはP3a-2bで詳細パネルに作る（PHASE3a-2a.md §2-5）"
            className="rounded border border-accent py-1.5 text-accent hover:bg-accent/15"
          >
            ⚡ スタックに宣言
          </button>
        )}

        {baseMax !== null && (
          <section className="rounded border border-line-strong p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold text-ink">気力</span>
              <button
                type="button"
                onClick={() => setShowDamage((v) => !v)}
                className="text-[9px] text-ink-muted underline hover:text-ink"
              >
                表示: {showDamage ? 'ダメージ' : '残り気力'}（切替）
              </button>
            </div>
            {instance.kiryoku === null ? (
              <button
                type="button"
                onClick={() => dispatch({ type: 'setKiryoku', iid, value: max ?? 0, cardName: name })}
                className="w-full rounded border border-ok py-1 text-ok hover:bg-ok/15"
              >
                気力を初期値（{max}）にする
              </button>
            ) : (
              <>
                <div className="mb-1.5 text-center text-lg font-bold text-ink">
                  {showDamage ? (max ?? 0) - instance.kiryoku : instance.kiryoku}
                  <span className="ml-1 text-xs font-normal text-ink-muted">/ {max}</span>
                </div>
                <div className="flex justify-center gap-1">
                  {[-5, -1, 1, 5].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => dispatch({ type: 'adjustKiryoku', iid, delta: d, max: max ?? 0, cardName: name })}
                      className="rounded border border-line-strong px-2 py-1 hover:border-ok"
                    >
                      {d > 0 ? `+${d}` : d}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <section className="rounded border border-line-strong p-2">
          <div className="mb-1 font-semibold text-ink">能力値修正・攻防修正</div>
          {mods.length > 0 && (
            <ul className="mb-2 flex flex-col gap-1">
              {mods.map((m) => (
                <li key={m.id} className="flex items-center justify-between rounded bg-surface-2 px-1.5 py-1">
                  <span className="truncate text-[10px] text-ink">
                    {m.sourceLabel} {modifierLabel(m)}
                  </span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'removeModifier', modId: m.id, cardName: name })}
                    className="ml-1 text-ink-muted hover:text-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mb-1 flex gap-1">
            {/* 種類の切り替え（P3d-3 §3-4）。攻防を選んだらscopeの既定を「このバトル」にする（FAQ oldfaq.txt:78） */}
            <select
              value={modKind}
              onChange={(e) => {
                const kind = e.target.value as ModifierKind
                setModKind(kind)
                setModScope(kind === '攻防修正' ? 'このバトル' : 'ターン終了時')
              }}
              className="rounded border border-line-strong bg-surface-2 px-1 py-1"
            >
              <option value="能力値修正">能力値</option>
              <option value="攻防修正">攻防</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-1">
            {modKind === '能力値修正' ? (
              <select
                value={modStat}
                onChange={(e) => setModStat(e.target.value as Attr)}
                className="rounded border border-line-strong bg-surface-2 px-1 py-1"
              >
                {ATTRS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={modBattleStat}
                onChange={(e) => setModBattleStat(e.target.value as 'atk' | 'def')}
                className="rounded border border-line-strong bg-surface-2 px-1 py-1"
              >
                <option value="atk">攻</option>
                <option value="def">防</option>
              </select>
            )}
            <input
              type="number"
              value={modDelta}
              onChange={(e) => setModDelta(Number(e.target.value))}
              className="w-14 rounded border border-line-strong bg-surface-2 px-1 py-1"
            />
            <select
              value={modScope}
              onChange={(e) => setModScope(e.target.value as typeof modScope)}
              className="rounded border border-line-strong bg-surface-2 px-1 py-1"
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
              className="w-28 flex-1 rounded border border-line-strong bg-surface-2 px-1 py-1"
            />
            <button
              type="button"
              disabled={!modSource.trim()}
              onClick={() => {
                dispatch({
                  type: 'addModifier',
                  modifier:
                    modKind === '能力値修正'
                      ? {
                          id: newIid(),
                          targetIid: iid,
                          sourceLabel: modSource.trim(),
                          kind: '能力値修正',
                          stat: modStat,
                          delta: modDelta,
                          scope: modScope,
                        }
                      : {
                          id: newIid(),
                          targetIid: iid,
                          sourceLabel: modSource.trim(),
                          kind: '攻防修正',
                          battleStat: modBattleStat,
                          delta: modDelta,
                          scope: modScope,
                        },
                  cardName: name,
                })
                setModSource('')
              }}
              className="rounded border border-ok px-2 py-1 text-ok disabled:opacity-40"
            >
              追加
            </button>
          </div>
          {mods.length > 0 && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'clearModifiers', iid, cardName: name })}
              className="mt-1 w-full rounded border border-line-strong py-1 text-[10px] text-ink-muted hover:border-danger hover:text-danger"
            >
              すべての修正をクリア
            </button>
          )}
        </section>

        <section className="rounded border border-line-strong p-2">
          <div className="mb-1 font-semibold text-ink">付随カード（アイテム等）</div>
          {attachedItems.length > 0 && (
            <ul className="mb-2 flex flex-col gap-1">
              {attachedItems.map((it) => (
                <li key={it.iid} className="flex items-center justify-between rounded bg-surface-2 px-1.5 py-1">
                  <span className="truncate text-[10px] text-ink">{cardOf(it.cardId)?.name ?? it.cardId}</span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'detach', itemIid: it.iid, itemName: cardOf(it.cardId)?.name ?? it.cardId })}
                    className="text-ink-muted hover:text-danger"
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
                className="flex-1 rounded border border-line-strong bg-surface-2 px-1 py-1"
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
                className="rounded border border-accent px-2 py-1 text-accent disabled:opacity-40"
              >
                付ける
              </button>
            </div>
          )}
        </section>

        <div className="mt-auto flex gap-2 border-t border-line pt-2">
          <button
            type="button"
            onClick={() => {
              dispatch({ type: 'toTrash', iid, cardName: name })
              onClose()
            }}
            className="flex-1 rounded border border-line-strong py-1.5 hover:border-danger hover:text-danger"
          >
            ゴミ箱へ
          </button>
          <button
            type="button"
            onClick={() => {
              dispatch({ type: 'removeCard', iid, cardName: name })
              onClose()
            }}
            className="flex-1 rounded border border-line-strong py-1.5 hover:border-danger hover:text-danger"
          >
            盤外に出す
          </button>
        </div>
      </aside>
    </>
  )
}
