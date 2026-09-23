// 優先権エンジン（core専用・カード知識ゼロ）。DESIGN.md §5.1（2026-07-19 モデルの訂正）/ PHASE3a-1r.md §2-3。
// 「1つのアクション窓＝アクティブ/非アクティブの2枠」「処理順は固定：アクティブ→非アクティブ」
// 「入れ子＝一段深い窓が一時的に開く再帰（フレームのスタック）」の状態機械。
// 旧版（stack: StackItem[] に積み続けLIFOで降ろす）はMTG寄りの誤りだったため作り直した
// （DESIGN.md §5.1「🚨 モデルの訂正」）。効果の解決内容・合法性判定・コストは一切扱わない。
// 乱数・時刻は持たない。

import type { Seat } from './board'

export type DeclaredActionKind = 'プレイ' | '能力' | 'バトル' | 'その他'
export type ActionTiming = '通常型' | '割込型'

/**
 * 🚨 「着地先(place)」はPHASE3a-4で撤回した。プレイしたカードの行き先はカードの種別とルールが
 * 一意に決めており、プレイヤーがどのマスにドロップしたかは一切関係しない
 * （oldrule.txt:834 イベント→ゴミ箱 / 935 フィールド→フィールド枠 / 887 アイテム→装備対象）。
 * 行き先は「解決するとき」に呼び出し側（ui）が種別から決めて resolveStep に渡す。
 */
export interface DeclaredAction {
  by: Seat
  sourceIid: string | null
  kind: DeclaredActionKind
  actionType: ActionTiming
  label: string
  detail?: string
}

/**
 * 窓の進行段階。
 * awaitActive/awaitNonActive＝宣言フェーズ（まだ処理していない）。
 * processActive/processNonActive＝処理フェーズ（人間が効果を解決してresolveStepを押す）。
 */
export type WindowStep = 'awaitActive' | 'awaitNonActive' | 'processActive' | 'processNonActive'

export interface ActionWindow {
  active: DeclaredAction | null
  nonActive: DeclaredAction | null
  step: WindowStep
}

export interface Priority {
  /** 窓のスタック（入れ子）。末尾＝現在の窓。通常0〜1個、稀に数段（DESIGN.md §5.1） */
  frames: ActionWindow[]
  /** 手番側＝処理順の優先。当面は「最初に窓を開いた側」で代用（ターン管理はP4） */
  activePlayer: Seat
}

export type Mode = 'assist' | 'free'

export interface PriorityResult {
  priority: Priority | null
  log: string
}

export function other(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

/**
 * ある窓の中で「今アクティブ側として振る舞うべき席」。
 * active枠が埋まっていればその宣言者（＝入れ子の窓はその窓を開いた側が基準になる。
 * ルート窓では常に priority.activePlayer と一致する）。まだ誰も宣言していない
 * （awaitActive・active===null）ときだけ、フォールバックとして priority.activePlayer を使う。
 */
function referenceSeat(priority: Priority, frame: ActionWindow): Seat {
  return frame.active?.by ?? priority.activePlayer
}

function replaceTop(priority: Priority, frame: ActionWindow): Priority {
  const frames = priority.frames.slice(0, -1)
  frames.push(frame)
  return { ...priority, frames }
}

/** 現在の窓を閉じる（pop）。親フレームが残っていればそれを返す。framesが空ならnull（自由操作へ） */
function popFrame(priority: Priority): Priority | null {
  const frames = priority.frames.slice(0, -1)
  if (frames.length === 0) return null
  return { ...priority, frames }
}

/**
 * openWindow: 空の窓を開く（バトルの段が開く窓。誰も宣言していない状態から始まる）。
 * PHASE3d-2a.md §2-1。priority が null のときだけ有効（既に窓があるなら何もしない＝log空）。
 * nonActiveOnly（at=2用）: 挑んだ側はすでにバトルを宣言済みで、相手だけが同時アクションを宣言できる窓
 * （'awaitNonActive' で開く）。その後の遷移は既存の declareAction/passPriority/resolveStep がそのまま扱う。
 */
export function openWindow(
  priority: Priority | null,
  activePlayer: Seat,
  opts?: { nonActiveOnly?: boolean },
): PriorityResult {
  if (priority !== null) return { priority, log: '' }
  const frame: ActionWindow = {
    active: null,
    nonActive: null,
    step: opts?.nonActiveOnly ? 'awaitNonActive' : 'awaitActive',
  }
  return { priority: { frames: [frame], activePlayer }, log: '窓を開いた' }
}

/** declareAction: 宣言（窓を開く／枠を埋める／処理中への割り込みで入れ子の窓をpush） */
export function declareAction(priority: Priority | null, action: DeclaredAction): PriorityResult {
  if (priority === null) {
    const frame: ActionWindow = { active: action, nonActive: null, step: 'awaitNonActive' }
    return {
      priority: { frames: [frame], activePlayer: action.by },
      log: `${action.by} が「${action.label}」を宣言`,
    }
  }

  const current = priority.frames[priority.frames.length - 1]
  if (!current) return { priority, log: '' }
  const ref = referenceSeat(priority, current)

  if (current.step === 'awaitActive' && action.by === ref) {
    const next: ActionWindow = { ...current, active: action, step: 'awaitNonActive' }
    return { priority: replaceTop(priority, next), log: `${action.by} が「${action.label}」を宣言` }
  }

  if (current.step === 'awaitNonActive' && action.by === other(ref)) {
    const nextStep: WindowStep = current.active ? 'processActive' : 'processNonActive'
    const next: ActionWindow = { ...current, nonActive: action, step: nextStep }
    return { priority: replaceTop(priority, next), log: `${action.by} が「${action.label}」を宣言` }
  }

  if (current.step === 'processActive' || current.step === 'processNonActive') {
    // 処理中への割り込み＝入れ子の新しい窓をpush（新規窓と同じ要領。activePlayerは据え置き）
    const frame: ActionWindow = { active: action, nonActive: null, step: 'awaitNonActive' }
    return {
      priority: { ...priority, frames: [...priority.frames, frame] },
      log: `${action.by} が「${action.label}」を宣言（割り込み）`,
    }
  }

  // 不正: 手番でない側の宣言等。何もしない
  return { priority, log: '' }
}

/** passPriority: 宣言せずパス */
export function passPriority(priority: Priority | null, by: Seat): PriorityResult {
  if (priority === null) return { priority, log: '' }

  const current = priority.frames[priority.frames.length - 1]
  if (!current) return { priority, log: '' }
  const ref = referenceSeat(priority, current)

  if (current.step === 'awaitActive' && by === ref) {
    const next: ActionWindow = { ...current, step: 'awaitNonActive' }
    return { priority: replaceTop(priority, next), log: `${by} が通した` }
  }

  if (current.step === 'awaitNonActive' && by === other(ref)) {
    if (current.active === null) {
      // 両者とも何も宣言しなかった → 窓を閉じる（§13-3-1 anti-deadlock）
      return { priority: popFrame(priority), log: `${by} が通した／宣言なしで窓を閉じた` }
    }
    const next: ActionWindow = { ...current, step: 'processActive' }
    return { priority: replaceTop(priority, next), log: `${by} が通した` }
  }

  // 不正: 手番でない側のパス等。何もしない
  return { priority, log: '' }
}

/** resolveStep: 人間が「この処理を解決した」→ 次の段階へ（自動化しない。UIから明示的に呼ぶ） */
export function resolveStep(priority: Priority | null): PriorityResult {
  if (priority === null) return { priority, log: '' }

  const current = priority.frames[priority.frames.length - 1]
  if (!current) return { priority, log: '' }

  if (current.step === 'processActive') {
    const label = current.active?.label ?? ''
    if (current.nonActive) {
      const next: ActionWindow = { ...current, step: 'processNonActive' }
      return { priority: replaceTop(priority, next), log: `「${label}」を解決` }
    }
    return { priority: popFrame(priority), log: `「${label}」を解決／窓を閉じた` }
  }

  if (current.step === 'processNonActive') {
    const label = current.nonActive?.label ?? ''
    return { priority: popFrame(priority), log: `「${label}」を解決／窓を閉じた` }
  }

  // 宣言フェーズ中（awaitActive/awaitNonActive）にresolveStepは無効。何もしない
  return { priority, log: '' }
}

/**
 * その席が今「宣言」を通せるか（declareActionが受理するか）の事前判定。表示・入力ガード用。
 * declareAction本体の受理条件と完全に同じ式にしてある（PHASE3a-3.md §2-3）。
 */
export function canDeclare(priority: Priority | null, seat: Seat): boolean {
  if (priority === null) return true
  const current = priority.frames[priority.frames.length - 1]
  if (!current) return false
  const ref = referenceSeat(priority, current)
  if (current.step === 'awaitActive') return seat === ref
  if (current.step === 'awaitNonActive') return seat === other(ref)
  return true // processActive | processNonActive: 入れ子の割り込みとして常に受理
}

/**
 * 今「宣言 or パス」を返す番の席（表示用の読み取り専用ヘルパー）。
 * 宣言フェーズ（awaitActive/awaitNonActive）以外、または窓が無ければ null。
 */
export function awaitingSeat(priority: Priority): Seat | null {
  const current = priority.frames[priority.frames.length - 1]
  if (!current) return null
  const ref = referenceSeat(priority, current)
  if (current.step === 'awaitActive') return ref
  if (current.step === 'awaitNonActive') return other(ref)
  return null
}

/**
 * 今「解決（resolveStep）」を押す番の席（表示用の読み取り専用ヘルパー）。
 * 処理フェーズ（processActive/processNonActive）以外、または窓が無ければ null。
 */
export function resolvingSeat(priority: Priority): Seat | null {
  const current = priority.frames[priority.frames.length - 1]
  if (!current) return null
  if (current.step === 'processActive') return current.active?.by ?? null
  if (current.step === 'processNonActive') return current.nonActive?.by ?? null
  return null
}

/** setMode: モード切替。free にしたら窓を畳む（assist への切替では現在の priority を維持） */
export function setMode(
  priority: Priority | null,
  mode: Mode,
): { priority: Priority | null; mode: Mode; log: string } {
  return {
    priority: mode === 'free' ? null : priority,
    mode,
    log: mode === 'free' ? 'フリーモードに切り替えた' : 'アシストモードに切り替えた',
  }
}
