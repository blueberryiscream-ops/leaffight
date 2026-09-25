/*
 * 進行中の手順（PHASE-R2u §3-3「StackPanel を proc で描く」）— エンジンモードで StackPanel の代わりに出す
 *
 * core の proc（手順のスタック）・currentWindow・awaitingSeat をそのまま描く。上が今の手順。
 * 各フレーム: 手順の種類・段の番号と原典のタイミング名・窓なら AP／NAP の宣言の枠。フェイズの窓（base）も同じ形で出す。
 * 🚨 読むだけ（操作は EngineBar）。非公開のカードの名前は出さない（宣言されたカードは提示されて公開になっている）。
 */

import type { BoardState, Seat } from '../../core/board'
import { STEP_TIMINGS, activeSeat, awaitingSeat, otherSeat, type ProcDecl, type ProcFrame, type ProcWindow } from '../../core/proc'
import { publicName } from './useEngineUI'

const KIND_LABEL: Record<string, string> = {
  costGen: 'コスト発生（7-2）',
  ability: '特殊能力（15-13-1）',
  event: 'イベント（16-1）',
  damage: 'ダメージ（15-4-2）',
  down: 'ダウン（15-5）',
  simul: '同時処理（13-2）',
  call: '呼び出し（15-10-1）',
  tag: 'タッグ化（15-10-2）',
  equip: '装備（17-3）',
  field: 'フィールド配置（18-2）',
  battleCard: 'バトルカード配置（19-2）',
  battle: 'バトル（20-4）',
  entry: 'エントリーフェイズ（10-4）',
  endPhase: '終了フェイズ（10-6）',
  handAdjust: '手札調整フェイズ（10-7）',
  turnEnd: 'ターン終了（10-8）',
}

function Slot({ label, decl, mark }: { label: string; decl: ProcDecl | null; mark: boolean }) {
  return (
    <div className={`min-w-0 flex-1 rounded border px-1 py-0.5 ${mark ? 'border-accent' : 'border-line-strong'}`}>
      <div className="text-[9px] text-ink-muted">{label}</div>
      <div className="truncate text-[10px] font-semibold text-ink">{decl ? decl.label : mark ? '（番）' : '—'}</div>
    </div>
  )
}

function WindowSlots({ board, w, localSeat }: { board: BoardState; w: ProcWindow; localSeat: Seat }) {
  const ap = activeSeat(board)
  const wait = awaitingSeat(board)
  const who = (s: Seat) => `${s}${s === localSeat ? '（自分）' : ''}`
  return (
    <div className="mt-0.5 flex gap-1">
      <Slot label={`AP ${who(ap)}`} decl={w.active} mark={wait === ap && w.state !== 'closed'} />
      <Slot label={`NAP ${who(otherSeat(ap))}`} decl={w.nonActive} mark={wait === otherSeat(ap) && w.state !== 'closed'} />
    </div>
  )
}

function frameText(f: ProcFrame): string {
  const t = STEP_TIMINGS[f.kind]?.[f.step]?.names ?? []
  const kind = KIND_LABEL[f.kind] ?? f.kind
  const lab = f.label && !kind.startsWith(f.label) ? ` ${f.label}` : ''
  return `${kind}${lab} [${f.step}]${t.length ? `《${t.join('》《')}》` : ''}`
}

export function ProcPanel({ board, localSeat, nameOf }: { board: BoardState; localSeat: Seat; nameOf: (cardId: string) => string }) {
  const frames = [...board.proc].reverse()
  const base = board.procMeta.base
  const pending = Object.values(board.cards).filter((c) => c.zone === 'pending')
  return (
    <div className="lf-panel flex h-full min-h-0 flex-col gap-1 overflow-hidden p-1.5 text-[10px] text-ink">
      <div className="font-semibold text-ink-muted">手順（上が今）</div>
      {frames.length === 0 && !base && <p className="text-ink-faint">進行中の手順なし</p>}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
        {frames.map((f, i) => (
          <div key={f.id} className={`rounded border px-1 py-0.5 ${i === 0 ? 'border-accent bg-surface-2/60' : 'border-line bg-surface-1/60 text-ink-muted'}`}>
            <div className="truncate" title={frameText(f)}>
              {frameText(f)}
            </div>
            {f.window && f.status === 'window' && <WindowSlots board={board} w={f.window} localSeat={localSeat} />}
          </div>
        ))}
        {frames.length === 0 && base && (
          <div className="rounded border border-accent bg-surface-2/60 px-1 py-0.5">
            <div className="truncate">
              {board.turn?.phase ?? 'メイン'}フェイズの窓（{board.turn?.phase === '終了' ? '10-6-1' : '10-5-1'}）{base.phaseEnd ? '・AP がフェイズ終了を宣言（10-2-2）' : ''}
            </div>
            <WindowSlots board={board} w={base} localSeat={localSeat} />
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <div className="shrink-0 truncate text-ink-muted">提示エリア: {pending.map((c) => publicName(board, localSeat, c.iid, nameOf)).join('・')}</div>
      )}
      <div className="shrink-0 text-ink-muted">ダウン数 A:{board.downs.A} B:{board.downs.B}</div>
    </div>
  )
}
