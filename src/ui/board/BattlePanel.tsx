import { useState } from 'react'
import type { BoardAction } from '../../core/actions'
import { AT_LABELS, canDeclareBattle, computeDamage, isActionAt, isWindowAt, other, type Battle } from '../../core/battle'
import { cardsInZone, effectiveStat, maxKiryokuFor, type BoardState, type CardInstance, type Seat } from '../../core/board'
import { ATTRS, type Attr } from '../../core/types'
import type { PoolCard } from '../../data/types'
import { autoBattleValues, battleStatModifierSum } from './battleValues'

// バトルパネル（PHASE3d-2b.md）。右列のDetailPanelの上に置く。窓の中の宣言・パス・解決は
// 既存のStackPanelのまま（ここは「今どの窓か」を表示するだけ・二重に作らない）。
// 🚨 ルールエンジンを作らない。参加できるか・選べるか・何点入るかの合法性は判定しない（§0）。

/** バトル種目の攻/防が単一の素の属性か（'力'等）。'-'や'？'や複合テキストはnull（参考表示の判定用・§2-3） */
function singleAttr(s: string | undefined): Attr | null {
  if (!s) return null
  return (ATTRS as readonly string[]).includes(s) ? (s as Attr) : null
}

function seatLabel(seat: Seat, localSeat: Seat): string {
  return seat === localSeat ? 'あなた' : '相手'
}

/**
 * 押せる人の判定（§2-3見出し）。freeモードでは両者とも押せる。ターン起因のロックではない（§0）。
 * 🚨 export して Board.tsx（盤面クリック選択）・TodoBand.tsx（今やること帯）からも同じものを使う
 * （PHASE3d-3.md §1・§5「二重に書かない」）。
 */
export function canAct(board: BoardState, localSeat: Seat, expectedSeat: Seat): boolean {
  return board.mode === 'free' || localSeat === expectedSeat
}

/**
 * 「次へ」を押しても何も起きない前提未達の点を、UIで押せなくするための鏡写し判定。
 * 🚨 合法性判定ではない。core（advanceStep）が既に同じ前提でno-opにする箇所を、
 * 「押せるのに何も起きないボタンを出さない」ためだけにUI側で先読みしている（PHASE3d-2b §7の自己点検対象）。
 */
export function nextBlocked(board: BoardState, battle: Battle): boolean {
  if (battle.at === 7) return battle.participants[battle.challenger].length === 0
  if (battle.at === 11) {
    // 未指定でも、待機キャラがいなければ core がリーダーを自動参加させて進める（20-8・actions.ts の at=11 分岐）。
    // 塞ぐのは「未指定かつ待機キャラがいる」＝core が何もしないときだけ
    const receiver = other(battle.challenger)
    return (
      battle.participants[receiver].length === 0 &&
      cardsInZone(board, receiver, 'char').some((c) => c.orientation === 'ready')
    )
  }
  if (battle.at === 16) return battle.battleCardIid === null
  if (battle.at === 23) {
    return !(
      typeof battle.atk.A === 'number' &&
      typeof battle.atk.B === 'number' &&
      typeof battle.def.A === 'number' &&
      typeof battle.def.B === 'number'
    )
  }
  return false
}

/**
 * 「次へ」がその判断をする人の操作である点（§2-3 の表）。[7][16][21]は挑んだ側、[11]は挑まれた側。
 * それ以外（[23][28]・free）は誰でも。手番ロックではなく、相手の選択を先取りして進めないための区別
 */
/** [28]の「次へ」で消える攻防修正（kind=攻防修正・scope=このバトル）の件数。core の clearBattleModifiers と同じ条件（表示専用） */
export function clearableBattleMods(board: BoardState): number {
  return Object.values(board.modifiers).filter((m) => m.kind === '攻防修正' && m.scope === 'このバトル').length
}

export function nextActor(battle: Battle): Seat | null {
  if (battle.at === 7 || battle.at === 16 || battle.at === 21) return battle.challenger
  if (battle.at === 11) return other(battle.challenger)
  return null
}

/**
 * 「決定して次へ」（§1）を押せるかの判定。既存 nextBlocked の[7][11]分岐と同じ式だが、
 * 判定対象がcommit済みのbattle.participantsでなく「今まさに選んでいる（未決定の）selected」配列である点が違う
 * （盤面クリックの選択はBoard.tsxに持ち上げたローカルstateなので、決定前の値で押せるか判定する必要がある）。
 * Board.tsx（盤面クリック時のリング表示）・TodoBand.tsx（今やること帯の主ボタン）からも呼ぶ。
 */
export function decideBlocked(board: BoardState, battle: Battle, seat: Seat, selected: string[]): boolean {
  if (battle.at === 7) return selected.length === 0
  if (battle.at === 11) {
    return selected.length === 0 && cardsInZone(board, seat, 'char').some((c) => c.orientation === 'ready')
  }
  return false
}

function ParticipantChecklist({
  seat,
  candidates,
  battle,
  board,
  localSeat,
  cardOf,
  dispatch,
  onSelectCard,
  selected,
  onToggle,
}: {
  seat: Seat
  candidates: CardInstance[]
  battle: Battle
  board: BoardState
  localSeat: Seat
  cardOf: (cardId: string) => PoolCard | undefined
  dispatch: (action: BoardAction) => void
  onSelectCard?: (iid: string) => void
  /**
   * 未決定の選択（iidの配列）。🚨 Board.tsx に持ち上げた state（盤面クリックと共有。PHASE3d-3 §1）。
   * at===7/11 が変わったら Board.tsx 側でリセットされる（旧 key={battle.at} の useState と同じ効果）。
   */
  selected: string[]
  onToggle: (iid: string) => void
}) {
  const allowed = canAct(board, localSeat, seat)

  return (
    <div className="rounded border border-line-strong p-1.5">
      <div className="mb-1 font-semibold text-ink">
        {seat === battle.challenger ? '挑んだ側' : '挑まれた側'}の参加キャラを選ぶ（盤面のカードをクリックしても選べます）
      </div>
      <ul className="mb-1 flex flex-col gap-0.5">
        {candidates.map((c) => (
          <li key={c.iid} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              disabled={!allowed}
              checked={selected.includes(c.iid)}
              onChange={() => onToggle(c.iid)}
            />
            <button
              type="button"
              onClick={() => onSelectCard?.(c.iid)}
              className="truncate text-left text-accent underline decoration-dotted hover:text-accent"
            >
              {cardOf(c.cardId)?.name ?? c.cardId}
            </button>
            <span className="text-ink-muted">
              気{c.kiryoku ?? '-'}・{c.orientation === 'ready' ? '待機' : '消耗'}
            </span>
          </li>
        ))}
        {candidates.length === 0 && <li className="text-ink-faint">（対象カードなし）</li>}
      </ul>
      <button
        type="button"
        disabled={!allowed || decideBlocked(board, battle, seat, selected)}
        onClick={() => {
          // §1「決定の操作を1回にする」: setBattleParticipants → advanceBattleStep を続けて dispatch。
          // assistでpriorityが開いている等advanceが効かない状況では、advance側がcoreでno-opになるだけでよい
          dispatch({ type: 'setBattleParticipants', seat, iids: selected })
          dispatch({ type: 'advanceBattleStep' })
        }}
        className="lf-btn-primary w-full rounded py-1 disabled:opacity-30"
      >
        決定して次へ
      </button>
    </div>
  )
}

function BattleCardChecklist({
  board,
  battle,
  localSeat,
  cardOf,
  dispatch,
  onSelectCard,
}: {
  board: BoardState
  battle: Battle
  localSeat: Seat
  cardOf: (cardId: string) => PoolCard | undefined
  dispatch: (action: BoardAction) => void
  onSelectCard?: (iid: string) => void
}) {
  const allowed = canAct(board, localSeat, battle.challenger)
  const candidates = (['A', 'B'] as const).flatMap((seat) =>
    cardsInZone(board, seat, 'battle')
      .filter((c) => c.used !== true)
      .map((c) => ({ seat, c })),
  )

  return (
    <div className="rounded border border-line-strong p-1.5">
      <div className="mb-1 font-semibold text-ink">バトルカードを1枚指定（20-9：自分のに限らない）</div>
      <ul className="flex flex-col gap-0.5">
        {candidates.map(({ seat, c }) => {
          const card = cardOf(c.cardId)
          const name = card?.name ?? c.cardId
          return (
            <li key={c.iid} className="flex items-center justify-between gap-1">
              <button
                type="button"
                onClick={() => onSelectCard?.(c.iid)}
                className="truncate text-left text-accent underline decoration-dotted hover:text-accent"
              >
                {seat}: {name}
              </button>
              <button
                type="button"
                disabled={!allowed}
                onClick={() => dispatch({ type: 'setBattleCard', iid: c.iid, cardName: name })}
                className={`shrink-0 rounded border px-1.5 py-0.5 ${
                  battle.battleCardIid === c.iid
                    ? 'border-ok text-ok'
                    : 'border-line-strong text-ink'
                } disabled:opacity-30`}
              >
                {battle.battleCardIid === c.iid ? '選択中' : '選ぶ'}
              </button>
            </li>
          )
        })}
        {candidates.length === 0 && <li className="text-ink-faint">（未使用のバトルカードなし）</li>}
      </ul>
    </div>
  )
}

function DamageTable({
  board,
  battle,
  cardOf,
  dispatch,
}: {
  board: BoardState
  battle: Battle
  cardOf: (cardId: string) => PoolCard | undefined
  dispatch: (action: BoardAction) => void
}) {
  const computed = computeDamage(battle)
  const rows = (['A', 'B'] as const).flatMap((seat) =>
    battle.participants[seat].map((iid) => ({ seat, iid })),
  )
  const defaultFor = (seat: Seat) => (battle.participants[seat].length === 1 ? computed[seat] : 0)

  // keyがbattle.atなのでat=26に入り直すたびリセットされる。
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(rows.map(({ seat, iid }) => [iid, defaultFor(seat)])),
  )

  return (
    <div className="rounded border border-line-strong p-1.5">
      <div className="mb-1 font-semibold text-ink">ダメージ確認表（20-10）</div>
      {(['A', 'B'] as const).some((s) => battle.participants[s].length >= 2) && (
        <p className="mb-1 text-warn">複数参加のダメージの配り方はカードの指示に従って入力してください</p>
      )}
      <ul className="mb-1 flex flex-col gap-1">
        {rows.map(({ seat, iid }) => {
          const inst = board.cards[iid]
          const card = inst && cardOf(inst.cardId)
          const name = card?.name ?? iid
          const baseMax = card?.kiryoku ?? null
          const max = maxKiryokuFor(inst?.zone ?? 'char', baseMax) ?? 0
          const kiryoku = inst?.kiryoku ?? 0
          const value = values[iid] ?? 0
          const willDown = kiryoku >= 1 && kiryoku - value <= 0
          return (
            <li key={iid} className="flex items-center justify-between gap-1">
              <span className="truncate text-ink">
                {seat}: {name}（気{kiryoku}/{max}）
              </span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  value={value}
                  onChange={(e) => setValues((cur) => ({ ...cur, [iid]: Number(e.target.value) }))}
                  className="w-14 rounded border border-line-strong bg-surface-2 px-1 py-0.5 text-right"
                />
                {willDown && <span className="rounded bg-danger px-1 text-on-accent">ダウン</span>}
              </span>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        onClick={() =>
          dispatch({
            type: 'applyBattleDamage',
            damages: rows.map(({ iid }) => {
              const inst = board.cards[iid]
              const card = inst && cardOf(inst.cardId)
              const max = maxKiryokuFor(inst?.zone ?? 'char', card?.kiryoku ?? null) ?? 0
              return { iid, amount: values[iid] ?? 0, max }
            }),
          })
        }
        className="lf-btn-primary w-full rounded py-1"
      >
        ダメージを適用
      </button>
    </div>
  )
}

/**
 * §2-4: 入力欄には「手入力 ?? 自動」を出す。自動の値には「自動」札、手入力には「手入力」＋
 * 「自動に戻す」ボタン（自動が出せるときだけ）。自動が出せない（特殊カード・複数参加・statsなし）
 * ときは今の参考表示に加え、その陣営の攻防修正の合計を出す（人が足し忘れないように）。
 */
function AtkDefRow({
  battle,
  board,
  localSeat,
  cardOf,
  dispatch,
}: {
  battle: Battle
  board: BoardState
  localSeat: Seat
  cardOf: (cardId: string) => PoolCard | undefined
  dispatch: (action: BoardAction) => void
}) {
  const editable = battle.at <= 23
  const battleCard = battle.battleCardIid ? board.cards[battle.battleCardIid] : undefined
  const battleCardDef = battleCard && cardOf(battleCard.cardId)
  const atkAttr = singleAttr(battleCardDef?.battleAtk)
  const defAttr = singleAttr(battleCardDef?.battleDef)
  const auto = autoBattleValues(board, battle, cardOf)

  const referenceFor = (seat: Seat, attr: Attr | null) => {
    if (!attr) return null
    const list = battle.participants[seat]
      .map((iid) => {
        const inst = board.cards[iid]
        const c = inst && cardOf(inst.cardId)
        if (!inst || !c?.stats) return null
        const base = c.stats[attr]
        return `${c.name}の${attr}${effectiveStat(board, iid, base, attr)}`
      })
      .filter((s): s is string => s !== null)
    return list.length > 0 ? `参考: ${list.join('／')}` : null
  }

  const modifierSumLabel = (seat: Seat, stat: 'atk' | 'def') => {
    const sum = battle.participants[seat].reduce((s, iid) => s + battleStatModifierSum(board, iid, stat), 0)
    if (sum === 0) return null
    return `攻防修正 ${stat === 'atk' ? '攻' : '防'}${sum >= 0 ? '+' : ''}${sum}`
  }

  const statRow = (seat: Seat, stat: 'atk' | 'def') => {
    const manual = battle[stat][seat]
    const autoVal = auto[stat][seat]
    const value = manual ?? autoVal
    const isAuto = manual === null && autoVal !== null
    return (
      <label className="flex items-center gap-1">
        {stat === 'atk' ? '攻' : '防'}
        <input
          type="number"
          disabled={!editable || !canAct(board, localSeat, seat)}
          value={value ?? ''}
          onChange={(e) =>
            dispatch({
              type: 'setBattleValue',
              seat,
              stat,
              value: e.target.value === '' ? null : Number(e.target.value),
            })
          }
          className="w-14 rounded border border-line-strong bg-surface-2 px-1 py-0.5 text-right disabled:opacity-40"
        />
        {isAuto && <span className="rounded bg-surface-3 px-1 text-[9px] text-ink-muted">自動</span>}
        {manual !== null && autoVal !== null && (
          <>
            <span className="text-[9px] text-warn">手入力</span>
            <button
              type="button"
              disabled={!editable || !canAct(board, localSeat, seat)}
              onClick={() => dispatch({ type: 'setBattleValue', seat, stat, value: null })}
              className="text-[9px] text-accent underline decoration-dotted hover:text-accent disabled:opacity-40"
            >
              自動に戻す
            </button>
          </>
        )}
      </label>
    )
  }

  return (
    <div className="rounded border border-line-strong p-1.5">
      <div className="mb-1 font-semibold text-ink">攻防能力値</div>
      {(['A', 'B'] as const).map((seat) => (
        <div key={seat} className="mb-1 flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-ink-muted">{seatLabel(seat, localSeat)}（{seat}）</span>
          {statRow(seat, 'atk')}
          {statRow(seat, 'def')}
          <span className="text-ink-muted">
            {/* 攻防が同じ属性（腕相撲の力/力など）なら1回だけ出す */}
            {[
              auto.atk[seat] === null ? referenceFor(seat, atkAttr) : null,
              atkAttr === defAttr ? null : auto.def[seat] === null ? referenceFor(seat, defAttr) : null,
              auto.atk[seat] === null ? modifierSumLabel(seat, 'atk') : null,
              auto.def[seat] === null ? modifierSumLabel(seat, 'def') : null,
            ]
              .filter(Boolean)
              .join('／')}
          </span>
        </div>
      ))}
    </div>
  )
}

export function BattlePanel({
  board,
  localSeat,
  dispatch,
  cardOf,
  onSelectCard,
  battleSelection,
  onToggleBattleSelection,
}: {
  board: BoardState
  localSeat: Seat
  dispatch: (action: BoardAction) => void
  cardOf: (cardId: string) => PoolCard | undefined
  onSelectCard?: (iid: string) => void
  /** [7][11]の未決定の参加キャラ選択。Board.tsxに持ち上げたstate（盤面クリックと共有。PHASE3d-3 §1） */
  battleSelection: string[]
  onToggleBattleSelection: (iid: string) => void
}) {
  const battle = board.battle

  if (!battle) {
    const reason = canDeclareBattle(board, localSeat)
    return (
      <div className="lf-panel shrink-0 p-1.5 text-[10px]">
        <button
          type="button"
          disabled={!!reason}
          onClick={() => dispatch({ type: 'declareBattle', challenger: localSeat })}
          className="lf-btn-primary w-full rounded py-1.5 disabled:opacity-30"
        >
          ⚔ バトルを挑む
        </button>
        {reason && <p className="mt-1 text-ink-muted">{reason}</p>}
      </div>
    )
  }

  const receiver = other(battle.challenger)
  const windowOpen = isWindowAt(battle.at)
  // assist の at=26 は「ダメージを適用」が次へを兼ねる（applyBattleDamage が at=27 へ進める）。free は常に出す
  const showNext =
    board.mode === 'free' || (battle.at !== 26 && isActionAt(battle.at) && board.priority === null)

  return (
    <div className="lf-panel flex shrink-0 flex-col gap-1.5 p-1.5 text-[10px] [--lf-panel-border:rgb(255_122_138/0.55)]">
      <div>
        <div className="font-semibold text-danger">
          [{battle.at}] {AT_LABELS[battle.at]}
        </div>
        <div className="text-ink-muted">
          {battle.step}
          {windowOpen && '／優先権パネルで宣言／通す'}
        </div>
      </div>

      <div className="text-ink-muted">
        挑んだ側: {seatLabel(battle.challenger, localSeat)}／挑まれた側: {seatLabel(receiver, localSeat)}
      </div>

      {battle.aborted && (
        <div className="rounded border border-danger bg-danger/50 p-1 text-danger">
          中断: {battle.abortReason}／[29]は行いません（20-6-1）
        </div>
      )}

      {/* 参加キャラ（共通表示・§2-2） */}
      {(['A', 'B'] as const).map((seat) =>
        battle.participants[seat].length === 0 ? null : (
          <div key={seat} className="rounded border border-line p-1">
            <div className="mb-0.5 text-ink-muted">
              {seatLabel(seat, localSeat)}の参加キャラ
              {battle.autoLeader[seat] && <span className="ml-1 text-warn">（自動参加・指定ではない・20-8）</span>}
            </div>
            <ul className="flex flex-col gap-0.5">
              {battle.participants[seat].map((iid) => {
                const inst = board.cards[iid]
                if (!inst) return null
                const card = cardOf(inst.cardId)
                return (
                  <li key={iid} className="flex items-center justify-between gap-1">
                    <span className="truncate">
                      {card?.name ?? iid}・気{inst.kiryoku ?? '-'}・{inst.orientation === 'ready' ? '待機' : '消耗'}
                      {battle.resultDowned.includes(iid) && (
                        <span className="ml-1 text-danger">ダウン（ゴミ箱送り・ダウン数・ボーナスドローは手で）</span>
                      )}
                    </span>
                    {inst.orientation === 'rested' && inst.owner === localSeat && (
                      <button
                        type="button"
                        onClick={() =>
                          dispatch({ type: 'setOrientation', iid, orientation: 'ready', cardName: card?.name ?? iid })
                        }
                        className="shrink-0 rounded border border-line-strong px-1 py-0.5 hover:border-ok"
                      >
                        消耗を戻す
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ),
      )}

      {/* バトル種目（共通表示） */}
      {battle.battleCardIid &&
        (() => {
          const inst = board.cards[battle.battleCardIid]
          const card = inst && cardOf(inst.cardId)
          if (!card) return null
          return (
            <div className="rounded border border-line p-1 text-ink-muted">
              種目: {card.name}（攻:{card.battleAtk}／防:{card.battleDef}）
            </div>
          )
        })()}

      {/* 攻防能力値（at>=18） */}
      {battle.at >= 18 && (
        <AtkDefRow battle={battle} board={board} localSeat={localSeat} cardOf={cardOf} dispatch={dispatch} />
      )}

      {/* 行動の点ごとの操作（§2-3） */}
      {battle.at === 7 && (
        <ParticipantChecklist
          key={battle.at}
          seat={battle.challenger}
          candidates={[...cardsInZone(board, battle.challenger, 'char'), ...cardsInZone(board, battle.challenger, 'leader')]}
          battle={battle}
          board={board}
          localSeat={localSeat}
          cardOf={cardOf}
          dispatch={dispatch}
          onSelectCard={onSelectCard}
          selected={battleSelection}
          onToggle={onToggleBattleSelection}
        />
      )}
      {battle.at === 11 && (
        <>
          <ParticipantChecklist
            key={battle.at}
            seat={receiver}
            candidates={[...cardsInZone(board, receiver, 'char'), ...cardsInZone(board, receiver, 'leader')]}
            battle={battle}
            board={board}
            localSeat={localSeat}
            cardOf={cardOf}
            dispatch={dispatch}
            onSelectCard={onSelectCard}
            selected={battleSelection}
            onToggle={onToggleBattleSelection}
          />
          <button
            type="button"
            disabled={!canAct(board, localSeat, receiver)}
            onClick={() => dispatch({ type: 'forceAutoLeaderBattle', seat: receiver })}
            className="rounded border border-warn py-1 text-warn disabled:opacity-30"
          >
            [12] リーダーを自動参加
          </button>
        </>
      )}
      {battle.at === 16 && (
        <BattleCardChecklist
          key={battle.at}
          board={board}
          battle={battle}
          localSeat={localSeat}
          cardOf={cardOf}
          dispatch={dispatch}
          onSelectCard={onSelectCard}
        />
      )}
      {battle.at === 21 && (
        <button
          type="button"
          disabled={!canAct(board, localSeat, battle.challenger)}
          onClick={() => dispatch({ type: 'loopBackBattle' })}
          className="rounded border border-warn py-1 text-warn disabled:opacity-30"
        >
          [19]に戻る
        </button>
      )}
      {battle.at === 26 && <DamageTable key={battle.at} board={board} battle={battle} cardOf={cardOf} dispatch={dispatch} />}
      {battle.at === 28 &&
        (() => {
          const clearable = clearableBattleMods(board)
          const remaining = Object.values(board.modifiers).filter(
            (m) => m.kind === '攻防修正' && m.scope !== 'このバトル',
          ).length
          return (
            <p className="text-ink-muted">
              {clearable > 0
                ? `攻防修正 ${clearable} 件を消して次へ（20-4[28]）`
                : '《バトル終了時》《バトル終了時まで》の効果を処理してから次へ'}
              {remaining > 0 && (
                <span className="ml-1 text-warn">
                  ／scope がこのバトル以外の攻防修正 {remaining} 件は残ります
                </span>
              )}
            </p>
          )
        })()}

      <div className="flex gap-1.5">
        {showNext &&
          (() => {
            // [23]は decideBattleValues で確定する（手入力??自動の4値。§2-3）。それ以外は advanceBattleStep のまま
            const auto = battle.at === 23 ? autoBattleValues(board, battle, cardOf) : null
            const displayAtk = auto ? { A: battle.atk.A ?? auto.atk.A, B: battle.atk.B ?? auto.atk.B } : null
            const displayDef = auto ? { A: battle.def.A ?? auto.def.A, B: battle.def.B ?? auto.def.B } : null
            const at23Ready =
              displayAtk !== null &&
              displayDef !== null &&
              typeof displayAtk.A === 'number' &&
              typeof displayAtk.B === 'number' &&
              typeof displayDef.A === 'number' &&
              typeof displayDef.B === 'number'
            const blocked =
              battle.at === 23
                ? !at23Ready
                : nextBlocked(board, battle) || (nextActor(battle) !== null && !canAct(board, localSeat, nextActor(battle)!))
            return (
              <button
                type="button"
                disabled={blocked}
                onClick={() => {
                  if (battle.at === 23 && at23Ready && displayAtk && displayDef) {
                    dispatch({
                      type: 'decideBattleValues',
                      atk: { A: displayAtk.A as number, B: displayAtk.B as number },
                      def: { A: displayDef.A as number, B: displayDef.B as number },
                    })
                    return
                  }
                  dispatch({ type: 'advanceBattleStep' })
                }}
                className="lf-btn-primary flex-1 rounded py-1 disabled:opacity-30"
              >
                {battle.at === 28 && clearableBattleMods(board) > 0
                  ? `攻防修正 ${clearableBattleMods(board)} 件を消して次へ`
                  : '次へ'}
              </button>
            )
          })()}
        <button
          type="button"
          onClick={() => dispatch({ type: 'abortBattle', reason: '手動で中断' })}
          className="flex-1 rounded border border-danger py-1 text-danger hover:bg-danger/15"
        >
          中断
        </button>
      </div>
    </div>
  )
}
