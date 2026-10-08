// FAQ ケースをエンジンに通す（PHASE-R2a §3-3）。scripts/test-faq.ts から使う。
//
//   setup（BoardSpec）から BoardState を作る → steps を BoardAction にして drive を通す → expect を確かめる
//
// 実行の約束（HANDOFF-R2a「決めたこと」に全部書く）:
//  - declare は「それが合法になる最初の窓」で行う（R1 の約束）。途中の窓は両者とも見送る。at があればその段の窓だけ。
//    手順の外（メインフェイズの窓）から始めた宣言はその窓だけを見る。手順の中から始めた宣言は、手順が全部終わるまで探す。
//    見つからなければ「合法でない」（盤面は探す前に戻す）
//  - pass はその席の番の窓まで進めて見送る。choose はその席の選択が来るまで進めて答える
//  - steps に無い窓は見送り、steps に無い選択は既定で答える（順＝並びのまま・使うか＝使う・選ぶ＝先頭から）
//  - 盤面に書いていないデッキは、結果に影響しないカード20枚で埋める（ボーナスドローでデッキ切れにしないため）
// R2b で足した約束（HANDOFF-R2b「決めたこと」F10〜）:
//  - setup.battle は core の startBattleAt で [at] から始める（参加キャラ・バトルカードは決まっているもの）
//  - challenge は「バトルを行うアクションの宣言」（メインフェイズの窓）。participant・battleCard は [7][16] の選択の答えに使う
//  - 窓で相手の番に、今の step の席がその窓で宣言できなかった（見送った）とき、続く step のうち相手の宣言がその窓で合法ならそれを先に行う。
//    選択も、相手の選択が来たら続く step のうちその席の choose で選択肢に合うものを先に使う（steps の並びと処理の順が違うケース）
//  - choose の選択が最後まで来なかったら「その選択はできない」（合法でない）。core が答えを受け付けなかったら合法でない
//  - 期待の at は「その手順がその段以降で最初に止まった点」の盤面で確かめる。zone 'field' はバトルカード・フィールドカードの置き場も含む
// R3 で足した約束（HANDOFF-R3「決めたこと」F24〜）:
//  - declare の答えに violations（カードの効果による禁止・対象にならない・特殊能力を失っている・装備対象 K4）があれば、その窓では「合法でない」
//    （画面では警告して通すが、FAQ の「できません」はその宣言をしないプレイヤーとして扱う。盤面は宣言の前に戻す）
//  - force は、それより前の step で始めた手順（宣言の処理）を終えてから起こす（状況を作る出来事は、宣言した行動の処理の後のこと）

import type { BoardAction } from '../../src/core/actions'
import { EMPTY_BOARD, type BoardState, type CardInstance, type Seat, type ZoneId } from '../../src/core/board'
import { awaitingSeat, currentWindow, startBattleAt, type ProcFrame, type ProcTrace } from '../../src/core/proc'
import { applyAction } from '../../src/core/actions'
import type { CardInfo, EngineCtx } from '../../src/engine/ctx'
import { abilityCostText } from '../../src/engine/cost'
import { currentStat, declare, drive, forceOp } from '../../src/engine/drive'
import { attrsNow } from '../../src/engine/layers'
import type { BoardSpec, CardSpec, Expect, FaqCase, Side, Step, WindowRef } from '../../src/engine/faqCase'

export type Verdict = '✅' | '❌' | '保留'

export interface CaseResult {
  id: string
  verdict: Verdict
  reasons: string[]
  /** manual に倒れた操作（✅ でも記録する） */
  manual: string[]
  failures: string[]
  warnings: string[]
}

const FILLER = '_filler'
const seatOf = (side: Side): Seat => (side === 'you' ? 'A' : 'B')
/** D20（借金取り・R4a-2）: プレイヤーを対象にとる Pick { player } の答えは席の文字（'A'/'B'）。
 *  targets に 'you'/'opponent' と書けば、この盤面の固定の対応（you=A・opponent=B）でそのまま席に変換する */
const SEAT_ALIAS: Record<string, Seat> = { you: 'A', opponent: 'B' }

export function buildBoard(spec: BoardSpec, ctx: EngineCtx): { state: BoardState; refs: Record<string, string> } {
  const cards: Record<string, CardInstance> = {}
  const refs: Record<string, string> = {}
  const put = (cs: CardSpec, owner: Seat, zone: ZoneId, index: number, extra: Partial<CardInstance> = {}) => {
    const info = ctx.cards[cs.card]
    const base = info?.kiryoku ?? null
    const kiryoku = cs.kiryoku ?? (base === null ? null : zone === 'leader' ? base * 2 : base)
    cards[cs.ref] = {
      iid: cs.ref,
      cardId: cs.card,
      owner,
      zone,
      index,
      orientation: cs.ready === false ? 'rested' : 'ready',
      faceUp: zone !== 'deck',
      kiryoku: zone === 'leader' || zone === 'char' ? kiryoku : info?.kind === 'c' || info?.kind === 't' ? base : null,
      attachedTo: null,
      ...extra,
    }
    refs[cs.ref] = cs.ref
    cs.equips?.forEach((e, i) => put(e, owner, 'char', 100 + i, { attachedTo: cs.ref, kiryoku: null }))
  }
  const costs: BoardState['costs'] = { A: [], B: [] }
  const downs: BoardState['downs'] = { A: 0, B: 0 }
  for (const side of ['you', 'opponent'] as Side[]) {
    const seat = seatOf(side)
    const s = spec[side]
    put(s.leader, seat, 'leader', 0)
    s.field?.forEach((c, i) => put(c, seat, 'char', i))
    if (s.fieldCard) put(s.fieldCard, seat, 'field', 0)
    s.battleCards?.forEach((c, i) => put(c, seat, 'battle', i, { used: c.used ?? false }))
    s.hand?.forEach((c, i) => put(c, seat, 'hand', i))
    s.trash?.forEach((c, i) => put(c, seat, 'trash', i))
    const top = s.deckTop ?? []
    top.forEach((c, i) => put(c, seat, 'deck', i))
    for (let i = 0; i < (s.fillers ?? 20); i++) {
      const iid = `filler${seat}${i}`
      cards[iid] = { iid, cardId: FILLER, owner: seat, zone: 'deck', index: top.length + i, orientation: 'ready', faceUp: false, kiryoku: null, attachedTo: null }
    }
    downs[seat] = s.downs ?? 0
    costs[seat] = (s.costs ?? []).map((c, i) => ({ id: c.ref ?? `init${seat}${i}`, icon: c.icon, attrs: c.attr ? [c.attr] : [], frameId: null }))
  }
  let state: BoardState = {
    ...EMPTY_BOARD,
    cards,
    mode: 'engine',
    turn: { active: seatOf(spec.active), phase: spec.phase ?? 'メイン', ...(spec.turnNo !== undefined ? { n: spec.turnNo } : {}) },
    downs,
    costs,
  }
  if (spec.battle) {
    const bt = spec.battle
    const participants: Partial<Record<Seat, string[]>> = {}
    for (const side of ['you', 'opponent'] as Side[]) if (bt.participants?.[side]) participants[seatOf(side)] = bt.participants[side]!
    state = startBattleAt(state, { challenger: seatOf(bt.challenger), at: bt.at, participants, battleCard: bt.battleCard ?? null })
  }
  return { state, refs }
}

interface Run {
  state: BoardState
  ctx: EngineCtx
  refs: Record<string, string>
  actions: BoardAction[]
  /** 共有のログ（applyAction が返した log の並び。名前が漏れないかの確認 R4c G5c） */
  logs: string[]
  trace: ProcTrace[]
  warnings: string[]
  steps: { legal?: boolean; reason?: string; declId?: string; consumed: boolean }[]
  pending: string[]
  /** challenge の participant・battleCard（[7][16] の選択の答えに使う） */
  intent: Partial<Record<Seat, { participant?: string; battleCard?: string }>>
  /** 期待の at: 最初に止まった点の盤面 */
  snaps: { at: WindowRef; state: BoardState | null }[]
  /** 全 steps（先に使う＝lookahead のため） */
  all: Step[]
}

function snap(run: Run) {
  for (const sn of run.snaps) {
    if (sn.state) continue
    if (run.state.proc.some((f) => f.kind === sn.at.proc && f.step >= sn.at.step)) sn.state = run.state
  }
}

function apply(run: Run, a: BoardAction): boolean {
  const r = applyAction(run.state, a)
  if (r.state === run.state && !r.log) return false
  run.state = r.state
  if (r.log) run.logs.push(r.log)
  run.actions.push(a)
  if (r.trace) run.trace.push(...r.trace)
  snap(run)
  return true
}

function driveRun(run: Run) {
  const d = drive(run.state, run.ctx)
  run.state = d.state
  run.actions.push(...d.actions)
  run.logs.push(...d.logs)
  run.trace.push(...d.trace)
  run.warnings.push(...d.warnings)
  snap(run)
}

/** 割り振り（repeat）の既定: 上限の中で先頭から */
function defaultRepeat(ch: NonNullable<BoardState['procMeta']['choice']>): string[] {
  const pick: string[] = []
  for (const o of ch.options) {
    const cap = ch.caps?.[o.key] ?? ch.max
    for (let i = 0; i < cap && pick.length < ch.min; i++) pick.push(o.key)
  }
  return pick
}

/** 入力が要る点で既定の入力を1つ入れる（窓は見送る・選択は既定で答える）。何もできなければ false */
function autoStep(run: Run): boolean {
  const s = run.state
  if (s.result) return false
  const ch = s.procMeta.choice
  if (ch) {
    let pick: string[] = []
    const intent = run.intent[ch.by]
    const want = ch.purpose === 'battleParticipant' ? intent?.participant : ch.purpose === 'battleCard' ? intent?.battleCard : undefined
    if (want && ch.options.some((o) => o.key === (run.refs[want] ?? want))) pick = [run.refs[want] ?? want]
    else if (ch.repeat) pick = defaultRepeat(ch)
    else if (ch.kind === 'use') pick = ch.options.slice(0, 1).map((o) => o.key)
    // R4a-2（faq-4099 で発覚）: min===0（optionalFirst＝そもそも使うかどうかを聞く最初の選択）は既定で見送る（選ばない＝使わない）。
    // 明示の steps が無いプレイヤー（例: eachPlayer の相手側）は、意図が無ければ何もしないのが安全な既定（D8 の「一人のときは払わない」と同じ考え方）
    else if (ch.kind === 'select') pick = ch.min === 0 ? [] : ch.options.slice(0, Math.min(ch.max, ch.min)).map((o) => o.key)
    if (!want) run.warnings.push(`選択を既定で答えた: ${ch.prompt} → ${pick.join('・') || '（なし）'}`)
    if (!apply(run, { type: 'procChoose', id: ch.id, pick })) return false
    driveRun(run)
    return true
  }
  const seat = awaitingSeat(s)
  if (seat) {
    apply(run, { type: 'procPass', by: seat })
    driveRun(run)
    return true
  }
  const before = run.state
  driveRun(run)
  return run.state !== before
}

const PROC_OF: Record<WindowRef['proc'], string[]> = {
  ability: ['ability'],
  event: ['event'],
  costGen: ['costGen'],
  item: ['equip'],
  field: ['field'],
  battleCard: ['battleCard'],
  damage: ['damage'],
  down: ['down'],
  battle: ['battle'],
  phase: ['entry', 'handAdjust', 'turnEnd'],
}

function atMatches(frame: ProcFrame | null, at: WindowRef | undefined): boolean {
  if (!at) return true
  if (!frame) return at.proc === 'phase'
  return PROC_OF[at.proc].includes(frame.kind) && frame.step === at.step
}

function mapPick(run: Run, pick: string[] | string): string[] {
  return (Array.isArray(pick) ? pick : [pick]).map((p) => run.refs[p] ?? p)
}

/** メインフェイズの窓がまだ回っている（手順が空でも「手順が終わった」ではない）。
 *  開き直した新しい窓（まだ誰も宣言していない AP の番）は「回っている」に入れない＝手順が全部終わった */
function baseOpen(s: BoardState): boolean {
  const b = s.procMeta.base
  if (!b || b.state === 'closed') return false
  return !(b.state === 'awaitActive' && !b.active && !b.nonActive)
}

type DeclReq = { by: Side; source: string; ability?: string; targets?: string[]; at?: WindowRef; payWith?: string[]; option?: string; costGen?: boolean; battle?: boolean }

function declReqOf(step: Step): DeclReq | null {
  if ('declare' in step) return step.declare
  if ('challenge' in step) return { by: step.challenge.by, source: step.challenge.participant, battle: true }
  return null
}

/** その窓で宣言を試す（合法なら行う）。行ったら宣言の id を返す */
function tryDeclare(run: Run, req: DeclReq): { ok: true; declId: string } | { ok: false; reason: string; stop?: string } {
  const s = run.state
  const out = declare(s, run.ctx, {
    by: seatOf(req.by),
    source: run.refs[req.source] ?? req.source,
    ability: req.ability,
    targets: req.targets?.map((t) => run.refs[t] ?? SEAT_ALIAS[t] ?? t),
    payWith: req.payWith?.map((t) => run.refs[t] ?? t),
    option: req.option,
    costGen: req.costGen,
    battle: req.battle,
  })
  if (out.ok && out.violations.length) return { ok: false, reason: `警告（K4）: ${out.violations.map((v) => v.text).join('／')}` }
  if (out.ok) {
    run.warnings.push(...out.warnings)
    out.actions.forEach((a) => apply(run, a))
    driveRun(run)
    return { ok: true, declId: out.decl.id }
  }
  if (out.missingDef || out.manual) return { ok: false, reason: out.reason, stop: out.missingDef ? `記述の無いカード: ${out.reason}` : `manual の能力: ${out.reason}` }
  return { ok: false, reason: out.reason }
}

/** 相手の番の窓で、続く step（宣言・選択の並び）の相手の宣言をこの窓で先に行えるか（F10） */
function lookaheadDeclare(run: Run, i: number, seat: Seat): boolean {
  for (let j = i + 1; j < run.all.length; j++) {
    const st = run.all[j]
    if (run.steps[j]?.consumed) continue
    if (!('declare' in st) && !('choose' in st) && !('pass' in st)) return false
    const req = declReqOf(st)
    if (!req || seatOf(req.by) !== seat) continue
    const w = currentWindow(run.state)
    if (!w || !atMatches(w.frame, req.at)) return false
    const r = tryDeclare(run, req)
    if (r.ok) {
      run.steps[j] = { legal: true, declId: r.declId, consumed: true }
      return true
    }
    return false
  }
  return false
}

function doDeclare(run: Run, i: number, req: DeclReq) {
  const by = seatOf(req.by)
  const snapState = { state: run.state, actions: run.actions.length, trace: run.trace.length, warnings: run.warnings.length }
  let sawProc = run.state.proc.length > 0
  let lastReason = '宣言できる窓が無かった'
  /** この窓（フレームと段）で今の step の席が宣言できずに見送った */
  let refusedAt: string | null = null
  let triedFresh = false
  const winKey = () => {
    const w = currentWindow(run.state)
    return w ? `${w.frame?.id ?? 'base'}:${w.frame?.step ?? 0}:${run.state.procMeta.seq}` : ''
  }
  for (let guard = 0; guard < 600; guard++) {
    const s = run.state
    if (s.result) {
      lastReason = 'ゲームが終わった'
      break
    }
    if (s.procMeta.choice) {
      if (!lookaheadChoose(run, i, s.procMeta.choice.by) && !autoStep(run)) break
      continue
    }
    // 手順の中を探していて、手順が全部終わった＝ここまでに宣言できる窓が無かった。
    // ただし、1つ前の step が同じ席のメインフェイズの窓での宣言（続けて行う行動）で、開き直したメインフェイズの窓がその席の番なら、
    // そこで1度だけ試す（《地竜走破》の後に《応援》FAQ:2479。F26・R3）。相手の割り込みの後の step（FAQ:2225）には使わない。
    // 宣言の後に「後で決める対象」の choose（同じ席・使用代償の対象の選択など）が挟まっても、直前の declare を同じ行動の続きとして見る（R4a）
    if (sawProc && s.proc.length === 0 && !baseOpen(s)) {
      const fresh = currentWindow(s)
      let pj = i - 1
      while (pj >= 0 && 'choose' in run.all[pj] && seatOf(run.all[pj].choose.by) === by) pj--
      const prev = pj >= 0 ? run.all[pj] : undefined
      const chained = !!prev && 'declare' in prev && prev.declare.by === req.by && !prev.declare.at && !req.at
      // at: { proc: 'phase' } を明示した step は、相手の割り込みの後でも開き直したメインフェイズの窓で試す（《威圧》で手札に戻ったキャラをもう一度呼び出す FAQ:2635。統括29）
        || req.at?.proc === 'phase'
      if (chained && !triedFresh && fresh && !fresh.frame && awaitingSeat(s) === by) {
        triedFresh = true
        const r = tryDeclare(run, req)
        if (r.ok) {
          run.steps[i] = { legal: true, declId: r.declId, consumed: true }
          return
        }
        lastReason = r.reason
      }
      break
    }
    const w = currentWindow(s)
    const seat = awaitingSeat(s)
    if (w && seat === by && atMatches(w.frame, req.at)) {
      const r = tryDeclare(run, req)
      if (r.ok) {
        run.steps[i] = { legal: true, declId: r.declId, consumed: true }
        return
      }
      if (r.stop) {
        run.pending.push(r.stop)
        run.steps[i] = { reason: r.reason, consumed: false }
        return
      }
      lastReason = r.reason
      // メインフェイズの窓で宣言できない通常型は、ここが唯一の機会＝合法でない。割込型はこの窓の行動の処理の中を探す
      if (!w.frame && !r.reason.startsWith('割込型の使用タイミングでない')) break
      refusedAt = `${w.frame?.id ?? 'base'}:${w.frame?.step ?? 0}`
    }
    if (w && seat) {
      const key = `${w.frame?.id ?? 'base'}:${w.frame?.step ?? 0}`
      if (seat !== by && refusedAt === key && lookaheadDeclare(run, i, seat)) continue
      void winKey
      apply(run, { type: 'procPass', by: seat })
      driveRun(run)
      sawProc ||= run.state.proc.length > 0
      continue
    }
    if (run.state.proc.length === 0 && !baseOpen(run.state)) {
      // 手順が全部終わった（ここまでに窓が無ければ合法でない）
      if (sawProc || !autoStep(run)) break
      sawProc ||= run.state.proc.length > 0
      continue
    }
    sawProc = true
    if (!autoStep(run)) break
  }
  // 合法でない: 探す前の盤面に戻す（警告として記録）
  run.state = snapState.state
  run.actions.length = snapState.actions
  run.trace.length = snapState.trace
  run.warnings.length = snapState.warnings
  run.steps[i] = { legal: false, reason: lastReason, consumed: true }
}

function doPass(run: Run, i: number, side: Side, at?: WindowRef) {
  const by = seatOf(side)
  for (let guard = 0; guard < 600; guard++) {
    const s = run.state
    if (s.result) break
    if (s.procMeta.choice) {
      if (!autoStep(run)) break
      continue
    }
    const w = currentWindow(s)
    const seat = awaitingSeat(s)
    if (w && seat === by && atMatches(w.frame, at)) {
      apply(run, { type: 'procPass', by })
      driveRun(run)
      run.steps[i] = { legal: true, consumed: true }
      return
    }
    if (!autoStep(run)) break
  }
  run.steps[i] = { consumed: false, reason: '見送る窓が来なかった' }
}

/** 選択肢に合う鍵の並び（合わなければ null） */
function matchPick(run: Run, ch: NonNullable<BoardState['procMeta']['choice']>, pick: string[] | string): string[] | null {
  const want = mapPick(run, pick)
  const keys: string[] = []
  for (const w of want) {
    // 選択肢の鍵は iid・名前・効果の鍵（`${iid}#${能力の番号}`）・宣言の id（`d…:${席}:${iid}`）のどれでも指せる
    const hit = (o: { key: string; label: string }) => o.key === w || o.label === w || o.key.startsWith(`${w}#`) || o.key.endsWith(`:${w}`)
    const opt = ch.options.find((o) => hit(o) && (ch.repeat || !keys.includes(o.key)))
    if (!opt) return null
    keys.push(opt.key)
  }
  if (ch.kind !== 'order' && (keys.length < ch.min || keys.length > ch.max)) return null
  return keys
}

/** 相手の選択が来たら、続く step のうちその席の choose で選択肢に合うものを先に使う（F11） */
function lookaheadChoose(run: Run, i: number, seat: Seat): boolean {
  const ch = run.state.procMeta.choice
  if (!ch) return false
  for (let j = i + 1; j < run.all.length; j++) {
    const st = run.all[j]
    if (run.steps[j]?.consumed) continue
    if (!('declare' in st) && !('choose' in st) && !('pass' in st)) return false
    if (!('choose' in st) || seatOf(st.choose.by) !== seat) continue
    const keys = matchPick(run, ch, st.choose.pick)
    if (!keys) return false
    if (!apply(run, { type: 'procChoose', id: ch.id, pick: keys })) return false
    driveRun(run)
    run.steps[j] = { legal: true, consumed: true }
    return true
  }
  return false
}

function doChoose(run: Run, i: number, side: Side, pick: string[] | string) {
  const by = seatOf(side)
  for (let guard = 0; guard < 600; guard++) {
    const s = run.state
    if (s.result) break
    const ch = s.procMeta.choice
    if (ch && ch.by === by) {
      const keys = matchPick(run, ch, pick)
      // core の手順の選択（参加キャラ・種目・[21] など）と同時処理の順（K10）で選択肢に合わないものは、既定で答えて次を待つ（F13）
      if (!keys && (ch.purpose || ch.kind === 'order')) {
        if (!autoStep(run)) break
        continue
      }
      // core が答えを受け付けない（割り振りの上限など）も合法でない
      if (!keys || !apply(run, { type: 'procChoose', id: ch.id, pick: keys })) {
        run.steps[i] = { legal: false, reason: `選択肢に無い／数が合わない／受け付けられない: ${mapPick(run, pick).join('・')}（選択肢: ${ch.options.map((o) => o.label).join('・')}）`, consumed: true }
        autoStep(run)
        return
      }
      driveRun(run)
      run.steps[i] = { legal: true, consumed: true }
      return
    }
    if (ch && lookaheadChoose(run, i, ch.by)) continue
    if (!autoStep(run)) break
  }
  // 選択が最後まで来なかった＝その選択はできない（F12）
  run.steps[i] = { legal: false, consumed: true, reason: 'その席の選択が来なかった（その選択はできない）' }
}

function finish(run: Run) {
  for (let guard = 0; guard < 3000; guard++) if (!autoStep(run)) break
}

const ZONE_OF: Record<string, (c: CardInstance) => boolean> = {
  // フィールド＝キャラ（付いているアイテム含む）・バトルカード・フィールドカードの置き場
  field: (c) => c.zone === 'char' || c.zone === 'leader' || c.zone === 'battle' || c.zone === 'field',
  hand: (c) => c.zone === 'hand',
  trash: (c) => c.zone === 'trash',
  deck: (c) => c.zone === 'deck',
  aside: (c) => c.zone === 'aside', // R4c G5e: 横に置いたカード
}

const SIDE_NAME: Record<Seat, Side> = { A: 'you', B: 'opponent' }

function checkExpect(run: Run, e: Expect, c: FaqCase): { ok: boolean | 'pending'; msg: string } {
  let s = run.state
  if (e.at) {
    const sn = run.snaps.find((x) => x.at === e.at)
    if (!sn?.state) return { ok: false, msg: `at ${e.at.proc}[${e.at.step}] に止まらなかった` }
    s = sn.state
  }
  const card = (ref: string) => s.cards[run.refs[ref] ?? ref]
  if ('kiryoku' in e) {
    const v = card(e.kiryoku[0])?.kiryoku
    return { ok: v === e.kiryoku[1], msg: `気力 ${e.kiryoku[0]} = ${v}（期待 ${e.kiryoku[1]}）` }
  }
  if ('zone' in e) {
    const x = card(e.zone[0])
    if (e.zone[1] === 'gone') return { ok: !x, msg: `${e.zone[0]} が盤外` }
    const zoneOk = !!x && ZONE_OF[e.zone[1]](x)
    const ownerOk = !e.zone[2] || (!!x && x.owner === seatOf(e.zone[2]))
    return { ok: zoneOk && ownerOk, msg: `${e.zone[0]} の場所 = ${x ? `${x.owner}:${x.zone}` : '無し'}（期待 ${e.zone[1]}${e.zone[2] ? `・${e.zone[2]}` : ''}）` }
  }
  if ('ready' in e) {
    const x = card(e.ready[0])
    return { ok: !!x && (x.orientation === 'ready') === e.ready[1], msg: `${e.ready[0]} の状態 = ${x?.orientation}（期待 ${e.ready[1] ? '待機' : '消耗'}）` }
  }
  if ('used' in e) {
    const x = card(e.used[0])
    return { ok: !!x && !!x.used === e.used[1], msg: `${e.used[0]} の使用済み = ${x?.used}（期待 ${e.used[1]}）` }
  }
  if ('downs' in e) {
    const v = s.downs[seatOf(e.downs[0])]
    return { ok: v === e.downs[1], msg: `ダウン数 ${e.downs[0]} = ${v}（期待 ${e.downs[1]}）` }
  }
  if ('costs' in e) {
    const v = s.costs[seatOf(e.costs[0])].length
    return { ok: v === e.costs[1], msg: `発生済みのコスト ${e.costs[0]} = ${v}（期待 ${e.costs[1]}）` }
  }
  // PHASE-R4b §2(D)・統括17の直し: payByPlayer で払ったコストが W・属性そのままか（FAQ:1341・1344）
  if ('costToken' in e) {
    const [side, icon, attr] = e.costToken
    const toks = s.costs[seatOf(side)]
    // attr が null＝属性なしのトークンだけ（その side のコストが全部属性なしで1つ以上ある。R4c G11a-1: 8-2・NH-30⑥）
    // attr が 'なし'＝属性なしのトークンが1つ以上ある（ほかに属性つきがあってもよい。統括25: ブーストの増分は属性無し）
    const hit = attr === null ? toks.length > 0 && toks.every((t) => t.icon === icon && t.attrs.length === 0) : attr === 'なし' ? toks.some((t) => t.icon === icon && t.attrs.length === 0) : toks.some((t) => t.icon === icon && (!attr || t.attrs.includes(attr)))
    return { ok: hit, msg: `発生済みのコスト ${side} に ${icon}${attr ?? ''} が無い（今: ${toks.map((t) => `${t.icon}${t.attrs.join('')}`).join('・') || '無し'}）` }
  }
  if ('shuffled' in e) {
    const [side, n] = e.shuffled
    const got = run.actions.filter((a) => a.type === 'shuffleDeck' && a.owner === seatOf(side)).length
    return { ok: got === n, msg: `${side} のデッキのシャッフル = ${got}回（期待 ${n}回）` }
  }
  if ('revealed' in e) {
    const got = run.actions.flatMap((a) => (a.type === 'procReveal' ? [{ name: a.cardName, to: SIDE_NAME[a.to] }] : []))
    const fmt = (xs: { name: string; to: string }[]) => xs.map((x) => `${x.name}→${x.to}`).join('・') || '無し'
    return { ok: fmt(got) === fmt(e.revealed), msg: `見せたカード = ${fmt(got)}（期待 ${fmt(e.revealed)}）` }
  }
  if ('looked' in e) {
    const got = run.actions.flatMap((a) => (a.type === 'procLook' ? [{ by: SIDE_NAME[a.viewer], of: SIDE_NAME[a.owner], zone: a.zone, n: a.n }] : []))
    const fmt = (xs: { by: string; of: string; zone: string; n: number }[]) => xs.map((x) => `${x.by}が${x.of}の${x.zone}${x.n}枚`).join('・') || '無し'
    return { ok: fmt(got) === fmt(e.looked), msg: `見た記録 = ${fmt(got)}（期待 ${fmt(e.looked)}）` }
  }
  if ('deckOrder' in e) {
    const [side, refs] = e.deckOrder
    const deck = Object.values(s.cards).filter((x) => x.owner === seatOf(side) && x.zone === 'deck').sort((a, b) => a.index - b.index).map((x) => x.iid)
    const got = deck.slice(0, refs.length)
    const want = refs.map((r) => run.refs[r] ?? r)
    return { ok: got.join() === want.join(), msg: `${side} のデッキの上 = ${got.join('・')}（期待 ${want.join('・')}）` }
  }
  if ('noLeak' in e) {
    const leaked = e.noLeak.filter((nm) => run.logs.some((l) => l.includes(nm)))
    return { ok: leaked.length === 0, msg: `共有のログに名前が出た = ${leaked.join('・')}` }
  }
  if ('logged' in e) {
    const missing = e.logged.filter((s2) => !run.logs.some((l) => l.includes(s2)))
    return { ok: missing.length === 0, msg: `共有のログに出ていない = ${missing.join('・')}` }
  }
  if ('choicePending' in e) {
    const p = !!s.procMeta.choice
    return { ok: p === e.choicePending, msg: `答えを待つ選択 = ${p ? 'あり' : 'なし'}（期待 ${e.choicePending ? 'あり' : 'なし'}）` }
  }
  if ('costN' in e) {
    const [side, icon, attr, n] = e.costN
    const toks = s.costs[seatOf(side)]
    const got = toks.filter((t) => t.icon === icon && (attr === 'なし' ? t.attrs.length === 0 : t.attrs.length === 1 && t.attrs[0] === attr)).length
    return { ok: got === n, msg: `発生済みのコスト ${side} の ${icon}${attr} = ${got}個（期待 ${n}個。今: ${toks.map((t) => `${t.icon}${t.attrs.join('')}`).join('・') || '無し'}）` }
  }
  if ('result' in e) {
    const r = s.result
    const got = !r ? 'continues' : r.winner === null ? 'draw' : r.winner === 'A' ? 'youWin' : 'opponentWins'
    return { ok: got === e.result, msg: `結果 = ${got}${r ? `（${r.reason}）` : ''}（期待 ${e.result}）` }
  }
  if ('illegal' in e) {
    const st = run.steps[e.illegal.step]
    return { ok: st?.legal === false, msg: `steps[${e.illegal.step}] が合法でない: ${st?.legal === false ? `はい（${st.reason}）` : st?.legal ? 'いいえ（通った）' : `判定できない（${st?.reason ?? '未実行'}）`}` }
  }
  if ('legal' in e) {
    const st = run.steps[e.legal.step]
    return { ok: st?.legal === true, msg: `steps[${e.legal.step}] が合法: ${st?.legal ? 'はい' : `いいえ（${st?.reason ?? '未実行'}）`}` }
  }
  if ('fizzled' in e) {
    const st = run.steps[e.fizzled.step]
    const hit = st?.declId ? s.procMeta.aborted.find((a) => a.declId === st.declId) : undefined
    return { ok: !!hit, msg: `steps[${e.fizzled.step}] の立ち消え: ${hit ? hit.reason : 'なし'}` }
  }
  if ('stat' in e) {
    // 能力値＝継続効果の層から導き出した今の値（R3: 印刷値＋層を連番の順に＋手直しの層）
    const x = card(e.stat[0])
    const v = x ? currentStat(run.ctx, s, x.iid, e.stat[1]) : undefined
    return { ok: v === e.stat[2], msg: `能力値 ${e.stat[0]} ${e.stat[1]} = ${v}（層から導き出した値）（期待 ${e.stat[2]}）` }
  }
  if ('attrs' in e) {
    const x = card(e.attrs[0])
    const now = x ? attrsNow(run.ctx, s, x.iid) : []
    const v = ['力', '早', '賢', '根', '感'].filter((a) => now.includes(a as never)).join('')
    return { ok: v === e.attrs[1], msg: `今の属性 ${e.attrs[0]} = ${v || '（なし）'}（層から導き出した値）（期待 ${e.attrs[1] || '（なし）'}）` }
  }
  if ('order' in e) {
    const names = run.trace.filter((t) => t.kind === 'name')
    // バトルの名前は席でなく側で書く（「バトル（you が挑んだ）」）
    const norm = (t: string) => t.replace(/バトル（([AB]) が挑んだ）/, (_, seat: Seat) => `バトル（${SIDE_NAME[seat]} が挑んだ）`)
    const hitOf = (t: ProcTrace, want: string) => {
      const iid = run.refs[want]
      if (iid) return !!t.id && t.id.endsWith(`:${iid}`)
      const text = norm(t.text)
      return text === want || text.startsWith(`${want}:`)
    }
    const seq: string[] = []
    for (const t of names) {
      const w = e.order.find((x) => hitOf(t, x))
      if (w !== undefined) seq.push(w)
    }
    return { ok: JSON.stringify(seq) === JSON.stringify(e.order), msg: `処理の順 = ${seq.join('→') || '（なし）'}（期待 ${e.order.join('→')}）` }
  }
  if ('battleCard' in e) {
    const last = s.procMeta.battles[s.procMeta.battles.length - 1]
    const want = run.refs[e.battleCard] ?? e.battleCard
    return { ok: last?.battleCard === want, msg: `バトル種目 = ${last?.battleCard ?? '（無し）'}（期待 ${e.battleCard}）` }
  }
  if ('battleAborted' in e) {
    const last = s.procMeta.battles[s.procMeta.battles.length - 1]
    const got = !!last?.aborted
    return { ok: !!last && got === e.battleAborted, msg: `バトルの中断 = ${last ? (last.aborted ?? 'なし') : '（バトルが終わっていない）'}（期待 ${e.battleAborted ? '中断' : '中断しない'}）` }
  }
  if ('note' in e) return { ok: 'pending', msg: `型で書けない期待（note）: ${e.note}` }
  void c
  return { ok: 'pending', msg: '知らない期待' }
}

export function runCase(c: FaqCase, ctx: EngineCtx, debug = false): CaseResult & { debug?: unknown } {
  const res: CaseResult = { id: c.id, verdict: '保留', reasons: [], manual: [], failures: [], warnings: [] }
  if (!c.setup || !c.steps || !c.expect) {
    res.reasons.push('setup・steps・expect がそろっていない')
    return res
  }
  const { state, refs } = buildBoard(c.setup, ctx)
  // 盤面に置いたアイテム・フィールドで記述の無いもの（常時効果が効くかもしれない）
  const noDef = [...new Set(Object.values(state.cards).filter((x) => { const k = ctx.cards[x.cardId]?.kind; return (k === 'i' || k === 'f') && !ctx.defs[x.cardId] }).map((x) => x.cardId))]
  const snaps = (c.expect as Expect[]).filter((e) => e.at).map((e) => ({ at: e.at!, state: null as BoardState | null }))
  const run: Run = { state, ctx, refs, actions: [], logs: [], trace: [], warnings: [], steps: [], pending: [], intent: {}, snaps, all: c.steps }
  try {
    snap(run)
    driveRun(run)
    c.steps.forEach((step: Step, i) => {
      if (run.pending.length) return
      if (run.steps[i]?.consumed) return // 先に使った（F10・F11）
      if ('force' in step) {
        // 前の step で始めた手順を終えてから（F25）
        if (i > 0) for (let g = 0; g < 600 && (run.state.proc.length || baseOpen(run.state)) && !run.state.result; g++) if (!autoStep(run)) break
        const bind: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(refs)) bind[k] = [v]
        apply(run, forceOp(run.state, step.force, bind))
        driveRun(run)
        run.steps[i] = { legal: true, consumed: true }
      } else if ('declare' in step) doDeclare(run, i, step.declare)
      else if ('challenge' in step) {
        run.intent[seatOf(step.challenge.by)] = { participant: step.challenge.participant, battleCard: step.challenge.battleCard }
        doDeclare(run, i, { by: step.challenge.by, source: step.challenge.participant, battle: true })
        run.intent[seatOf(step.challenge.by)] = { participant: step.challenge.participant, battleCard: step.challenge.battleCard }
      } else if ('generateCost' in step) doDeclare(run, i, { by: step.generateCost.by, source: step.generateCost.source, at: step.generateCost.at, costGen: true, ...(step.generateCost.also ? { payWith: step.generateCost.also } : {}) })
      else if ('advancePhase' in step) {
        // フェイズを進める（10-2-2）。今の手順を終えてから
        for (let g = 0; g < 600 && (run.state.proc.length || baseOpen(run.state)) && !run.state.result; g++) if (!autoStep(run)) break
        const ok = apply(run, { type: 'procPhase', to: step.advancePhase.to })
        driveRun(run)
        run.steps[i] = ok ? { legal: true, consumed: true } : { legal: false, consumed: true, reason: 'フェイズを進められない' }
      } else if ('pass' in step) {
        const p = typeof step.pass === 'string' ? { side: step.pass, at: undefined } : step.pass
        doPass(run, i, p.side, p.at)
      } else if ('choose' in step) doChoose(run, i, step.choose.by, step.choose.pick)
      // K5（D8）: 相手への問い（offer）の答え。エンジンは procChoice kind:'use'（key 'pay'）で問う（drive.ts execOp 'offer'）
      else if ('answer' in step) doChoose(run, i, step.answer.by, step.answer.accept ? ['pay'] : [])
    })
    if (!run.pending.length) finish(run)
  } catch (err) {
    res.verdict = '❌'
    res.failures.push(`実行時エラー: ${(err as Error).stack ?? err}`)
    return res
  }
  if (debug) (res as CaseResult & { debug?: unknown }).debug = { trace: run.trace, actions: run.actions, steps: run.steps, state: run.state }
  res.warnings = [...new Set(run.warnings)]
  res.manual = res.warnings.filter((w) => w.startsWith('manual'))
  if (run.pending.length) {
    res.reasons.push(...run.pending)
    return res
  }
  const pendings: string[] = []
  for (const e of c.expect as Expect[]) {
    const r = checkExpect(run, e, c)
    if (r.ok === 'pending') pendings.push(r.msg)
    else if (!r.ok) res.failures.push(r.msg)
  }
  run.steps.forEach((st, i) => {
    if (st && !st.consumed) res.warnings.push(`steps[${i}] を使わなかった: ${st.reason ?? ''}`)
  })
  if (res.failures.length === 0 && pendings.length === 0) res.verdict = '✅'
  else if (res.failures.length === 0) {
    res.verdict = '保留'
    res.reasons.push(...pendings)
  } else if (res.manual.length) {
    res.verdict = '保留'
    res.reasons.push(`manual に倒れた（${res.manual.join(' / ')}）`, ...pendings)
  } else {
    res.verdict = '❌'
    res.reasons.push(...pendings)
    if (noDef.length) res.reasons.push(`盤面に記述の無いアイテム・フィールド: ${noDef.join('・')}`)
  }
  return res
}

/** pool.json の1枚からエンジン用の欄を取る */
export function cardInfoOf(p: {
  id: string
  name: string
  kind: CardInfo['kind']
  kiryoku: number | null
  stats: Record<string, number> | null
  cost: string
  attr: string
  abilities: { header: string; cost: string; text?: string }[]
  battleAtk?: string
  battleDef?: string
  cells?: string[]
  charTypes?: string[]
  sex?: string
}): CardInfo {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    kiryoku: p.kiryoku,
    stats: p.stats,
    cost: p.cost,
    attr: p.attr,
    abilities: p.abilities.map((a) => ({ header: a.header, cost: abilityCostText(a) })),
    charTypes: p.charTypes ?? [],
    sex: (p.sex || (p.cells?.some((x) => x.includes('男性・女性')) ? '両方' : '')) as CardInfo['sex'],
    ...(p.kind === 'b' ? { battleAtk: p.battleAtk ?? '', battleDef: p.battleDef ?? '', place: p.cells?.[1] ?? '' } : {}),
  }
}
