// 正規タイミングの導出（core専用・カード知識ゼロ）。DESIGN.md §5.1「⭐既存の自動化操作を"フック"に
// すればタイミング窓を鳴らせる」/ PHASE3c.md §2。
// 「盤面の状態が before → after にどう変わったか」だけを見て、原典60種の正規タイミングのうち
// 既存操作（宣言/解決・気力増減・手札→ゴミ箱）に対応する分を導出する純粋関数。
// 効果の解決内容・合法性判定・条件充足は一切扱わない（DESIGN §5.1「あえて作らない」）。
//
// ⚠️ アクション（BoardAction）ではなく状態の差分だけから導出する設計にしてある。
// ゲストクライアントはホストから配信される「結果のstate」しか受け取らず、元のアクションは
// 見えない（DESIGN.md §6「単純さ優先・stateを丸ごと配信」）。ホスト/ゲストどちらでも同じ
// ロジックで動くようにするため、あえてアクションに依存しない実装にしている。

import type { BoardState, Seat } from './board'
import type { DeclaredAction, Priority } from './priority'
import type { CardKind } from './types'

export interface TimingEvent {
  timing: string
  /** このイベントの「実行者」相当。相手が/自分が スコープの照合に使う */
  actor: Seat
  targetIid: string | null
}

// ---------------------------------------------------------------------------
// 宣言/解決（declareAction/resolveStep）由来のタイミング
// ---------------------------------------------------------------------------

function declareTimings(action: DeclaredAction, cardKindOf: (cardId: string) => CardKind | undefined): TimingEvent[] {
  if (action.kind === '能力') {
    return [{ timing: '特殊能力を使用するとき', actor: action.by, targetIid: action.sourceIid }]
  }
  if (action.kind === 'プレイ' && action.sourceIid) {
    const kind = cardKindOf(action.sourceIid)
    if (kind === 'e') return [{ timing: 'イベントカードを使用するとき', actor: action.by, targetIid: action.sourceIid }]
    if (kind === 'f') return [{ timing: 'フィールドカードを使用するとき', actor: action.by, targetIid: action.sourceIid }]
    if (kind === 'c' || kind === 't') {
      return [{ timing: 'キャラクターカードが呼び出されるとき', actor: action.by, targetIid: action.sourceIid }]
    }
  }
  // バトル/その他はv1では扱わない（PHASE3c.md §0）
  return []
}

function resolvedTimings(action: DeclaredAction, cardKindOf: (cardId: string) => CardKind | undefined): TimingEvent[] {
  if (action.kind === '能力') {
    return [{ timing: '特殊能力を使用したとき', actor: action.by, targetIid: action.sourceIid }]
  }
  if (action.kind === 'プレイ' && action.sourceIid && cardKindOf(action.sourceIid) === 'e') {
    return [{ timing: 'イベントカードを使用したとき', actor: action.by, targetIid: action.sourceIid }]
  }
  return []
}

/** before→afterで新たに宣言された DeclaredAction を1件だけ検出する（無ければnull） */
function detectDeclared(before: Priority | null, after: Priority | null): DeclaredAction | null {
  const b = before?.frames ?? []
  const a = after?.frames ?? []

  if (a.length > b.length) {
    // 新しい窓が開いた（ルート or 割り込みでの入れ子push）。新フレームのactiveが宣言
    return a[a.length - 1]?.active ?? null
  }
  if (a.length === b.length && b.length > 0) {
    const bf = b[b.length - 1]
    const af = a[a.length - 1]
    if (af.nonActive && !bf.nonActive) return af.nonActive
    if (af.active && !bf.active) return af.active
  }
  return null
}

/** before→afterで解決された（resolveStepが押された）DeclaredAction を1件だけ検出する（無ければnull） */
function detectResolved(before: Priority | null, after: Priority | null): DeclaredAction | null {
  const b = before?.frames ?? []
  const a = after?.frames ?? []
  if (b.length === 0) return null
  const bf = b[b.length - 1]

  if (a.length < b.length) {
    // 窓が閉じた（pop）。閉じる直前のフレームの状態から、何が解決されたかを判定
    if (bf.step === 'processActive' && !bf.nonActive) return bf.active
    if (bf.step === 'processNonActive') return bf.nonActive
    return null
  }
  if (a.length === b.length) {
    const af = a[a.length - 1]
    if (bf.step === 'processActive' && af.step === 'processNonActive') return bf.active
  }
  return null
}

// ---------------------------------------------------------------------------
// 気力増減（adjustKiryoku/setKiryoku）由来のタイミング
// ---------------------------------------------------------------------------

/**
 * ⚠️ v1の割り切り: 「操作者」はネットワーク越しに追跡できない（ゲストはstateの差分しか
 * 見えずBoardActionを受け取らない）ため、actorは「対象カードの持ち主」で代用する。
 * 現行の注釈データ（気力/ダウン系）は相手が/自分が スコープを使わないため実害は無い
 * （味方キャラが/このキャラが等、targetIid基準のスコープのみ使用。PHASE3c.md HANDOFF参照）。
 */
function kiryokuTimings(before: BoardState, after: BoardState): TimingEvent[] {
  const events: TimingEvent[] = []
  for (const iid in after.cards) {
    const b = before.cards[iid]
    const a = after.cards[iid]
    if (!b || !a) continue
    if (b.kiryoku === null || a.kiryoku === null) continue
    if (a.kiryoku === b.kiryoku) continue

    const actor = a.owner
    if (a.kiryoku < b.kiryoku) {
      events.push({ timing: 'ダメージが発生したとき', actor, targetIid: iid })
      events.push({ timing: 'ダメージを受けるとき', actor, targetIid: iid })
      events.push({ timing: 'ダメージを受けたとき', actor, targetIid: iid })
      if (b.kiryoku >= 1 && a.kiryoku <= 0) {
        events.push({ timing: 'ダウンするとき', actor, targetIid: iid })
      }
    } else {
      events.push({ timing: '気力を回復させる効果が発生したとき', actor, targetIid: iid })
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// 手札→ゴミ箱（toTrash/moveCard）由来のタイミング
// ---------------------------------------------------------------------------

function trashTimings(before: BoardState, after: BoardState): TimingEvent[] {
  const events: TimingEvent[] = []
  for (const iid in before.cards) {
    const b = before.cards[iid]
    const a = after.cards[iid]
    if (!a) continue // removeCard等で盤外に出た場合は対象外
    if (b.zone === 'hand' && a.zone === 'trash') {
      events.push({ timing: '手札をゴミ箱送りにするとき', actor: b.owner, targetIid: iid })
      events.push({ timing: '手札をゴミ箱送りにしたとき', actor: b.owner, targetIid: iid })
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// 統合
// ---------------------------------------------------------------------------

/**
 * before→afterの状態差分から、正規タイミングの候補イベント一覧を導出する（PHASE3c.md §2フック表）。
 * `cardKindOf` は宣言されたカードの種別（c/t/b/i/e/f）を引くための呼び出し側の関数
 * （core はカード辞書を持たないため。data層の cardOf をUIが渡す）。
 */
export function deriveTimingEvents(
  before: BoardState,
  after: BoardState,
  cardKindOf: (cardId: string) => CardKind | undefined,
): TimingEvent[] {
  const events: TimingEvent[] = []

  const declared = detectDeclared(before.priority, after.priority)
  if (declared) events.push(...declareTimings(declared, cardKindOf))

  const resolved = detectResolved(before.priority, after.priority)
  if (resolved) events.push(...resolvedTimings(resolved, cardKindOf))

  events.push(...kiryokuTimings(before, after))
  events.push(...trashTimings(before, after))

  return events
}

// テスト用に内部ヘルパーも公開（単体テストで直接叩けるように）
export const _internal = { detectDeclared, detectResolved }
