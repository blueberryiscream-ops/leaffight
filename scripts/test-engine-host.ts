// つなぐ層（src/ui/engine/host.ts）のテスト — PHASE-R2u §3-5
// 期待の出所（原典 _local/oldrule.txt の段番号・FAQ の行）は各項目の頭に書く。今の実装の出力を写さない。
//   11-2（宣言の機会は AP→NAP の順に1人ずつ・見送り）・10-2-2（フェイズ終了の宣言と承認 367-369）・10-2-3（フェイズの順 370-375）・
//   10-2-4（先攻1ターン目 376-379）・10-4[4]（ドロー 389）・10-6（終了フェイズ [1]〜[3]・10-6-1 417-429）・10-7・10-8（436-441）・
//   15-10-1（呼び出し 680-706）・16-1（イベント 816-844）・15-4-2（ダメージ 612-632）・15-5-1（ダウン 633-649）・9-2（ダウン数）・
//   FAQ:2959-2960（宣言時に指定した支払い方法以外では払えない）・PHASE-R2u §1（ホストが正・1要求＝Undo 1回）・§2-2（自動見送り）
//   R2u-2: 10-5（メインフェイズ [1]〜[3] 391-394）・20-4（バトルの処理手順 1062-1127）・20-6（中断 1133-1136）・20-7／20-8（参加キャラの指定 1140-1145）・
//   20-10（結果ダメージ 1153-1157）・15-5-1[5]（ボーナスドロー 645-646）・FAQ:3465（参加キャラは指定した瞬間に消耗）・DESIGN §4.10（種目は挑んだ側が選ぶ＝利用者の決定）

import { EMPTY_BOARD, EMPTY_PROC_META, fillBoardDefaults, type BoardState, type CardInstance, type Seat } from '../src/core/board'
import { emptyHistory, undo, type History } from '../src/core/history'
import { MAIN_ACTIONS, PHASE_ACTIONS, activeSeat, awaitingSeat, currentWindow, phaseEndPending, startBattleAt, topFrame } from '../src/core/proc'
import type { CardInfo } from '../src/engine/ctx'
import { applyAction } from '../src/core/actions'
import type { ProcDecl } from '../src/core/proc'
import { currentStat, declare, drive } from '../src/engine/drive'
import { applyCostMod, continuousSeed, staticSourceActive, violations } from '../src/engine/layers'
import { select } from '../src/engine/eval'
import { setEnforce } from '../src/engine/enforce'
import type { CardDef } from '../src/engine/dsl'
import { applyEngineReq, buildEngineCtx, foldLog, isOwnMainDeclareWindow, legalDeclarations, paymentNeed, shouldAutoPass, type EngineReq } from '../src/ui/engine/host'
import { def as kusuguriDef } from '../_local/rules/cards/b_くすぐりマシ-ン'
import { def as misterDef } from '../_local/rules/cards/b_ミスタ-コンテスト'

let failures = 0
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`❌ ${msg}\n   実際: ${a}\n   期待: ${e}`)
  } else console.log(`✅ ${msg}`)
}

function card(iid: string, owner: Seat, zone: CardInstance['zone'], extra: Partial<CardInstance> = {}): CardInstance {
  return { iid, cardId: iid, owner, zone, index: 0, orientation: 'ready', faceUp: zone !== 'deck', kiryoku: null, attachedTo: null, ...extra }
}
function board(cards: CardInstance[]): BoardState {
  const map: Record<string, CardInstance> = {}
  cards.forEach((c, i) => (map[c.iid] = { ...c, index: i }))
  return { ...EMPTY_BOARD, cards: map, turn: { active: 'A', phase: 'メイン' } }
}
/** ターン n のメインフェイズの [2]（10-5-1 のアクションの窓）から始める盤面（[1]《メインフェイズ開始時》は済んだものとする） */
const inMain = (n: number, extra: Partial<BoardState['procMeta']> = {}): Pick<BoardState, 'turn' | 'procMeta'> => ({ turn: { active: 'A', phase: 'メイン', n }, procMeta: { ...EMPTY_PROC_META, phaseRun: MAIN_ACTIONS, ...extra } })
const hist = (s: BoardState): History => ({ ...emptyHistory(), present: s })
function req(h: History, r: EngineReq, sender: Seat | null = null): History {
  const x = applyEngineReq(h, ctxAll, r, sender)
  if (!x.ok) throw new Error(`要求が断られた: ${JSON.stringify(r)} → ${x.reason}`)
  return x.history
}
/** 宣言の番の席が見送り続ける（pred が真になるか、窓が無くなるまで） */
function passUntil(h: History, pred: (s: BoardState) => boolean, limit = 80): History {
  for (let i = 0; i < limit && !pred(h.present); i++) {
    const seat = awaitingSeat(h.present)
    if (!seat || h.present.procMeta.choice) break
    h = req(h, { kind: 'pass', by: seat })
  }
  return h
}

// ── 試験用のカード（名前・効果は架空。記述の形は src/engine/dsl.ts）
const info = (id: string, kind: CardInfo['kind'], kiryoku: number | null, cost = '', attr = ''): CardInfo => ({ id, name: id, kind, kiryoku, stats: null, cost, attr, abilities: [] })
const INFOS: CardInfo[] = [
  info('LA', 'c', 4, '', '力'),
  info('LB', 'c', 4, '', '力'),
  info('X', 'c', 2, '', '早'),
  info('Y', 'c', 2, '', '早'),
  info('Hit', 'e', null),
  info('Int', 'e', null),
  info('Pay1', 'e', null, 'W'),
  info('Pay2', 'e', null, 'WW'),
]
const oppChar = { cards: { zone: 'field' as const, side: 'opponent' as const, class: 'キャラ' as const } }
const DEFS: Record<string, CardDef> = {
  // 通常型のイベント: 相手のキャラ1体を対象に2ダメージ
  Hit: { id: 'Hit', name: 'Hit', kind: 'e', status: 'draft', abilities: [{ kind: 'play', speed: '通常型', choices: [{ slot: 't', chooser: 'you', pick: oppChar, count: [1, 1], mode: 'target', when: 'declare' }], effect: [{ op: 'damage', to: { ref: 'slot', slot: 't' }, amount: 2 }] }] },
  // 割込型のイベント:《イベントカードを使用したとき》（相手が）相手のキャラ1体を対象に1ダメージ
  Int: { id: 'Int', name: 'Int', kind: 'e', status: 'draft', abilities: [{ kind: 'play', speed: '割込型', trigger: { timing: 'イベントカードを使用したとき', actor: 'opponent' }, choices: [{ slot: 't', chooser: 'you', pick: oppChar, count: [1, 1], mode: 'target', when: 'declare' }], effect: [{ op: 'damage', to: { ref: 'slot', slot: 't' }, amount: 1 }] }] },
  // 使用代償 W・WW のイベント: 1枚ドロー
  Pay1: { id: 'Pay1', name: 'Pay1', kind: 'e', status: 'draft', abilities: [{ kind: 'play', speed: '通常型', choices: [], effect: [{ op: 'draw', player: 'you', n: 1 }] }] },
  Pay2: { id: 'Pay2', name: 'Pay2', kind: 'e', status: 'draft', abilities: [{ kind: 'play', speed: '通常型', choices: [], effect: [{ op: 'draw', player: 'you', n: 1 }] }] },
}
const ctx = buildEngineCtx([], null)
const ctxAll = { cards: Object.fromEntries(INFOS.map((c) => [c.id, c])), defs: DEFS }

// メインフェイズの窓を開いた盤面（カード無し＝宣言できるものが無い）
const s0 = drive(board([card('dA0', 'A', 'deck'), card('dB0', 'B', 'deck')]), ctx).state
const h0: History = hist(s0)
eq(!!currentWindow(s0) && awaitingSeat(s0), 'A', '前提: メインの窓が開き、宣言の番はアクティブプレイヤー A（11-2）')

// ② ゲストの不正な要求を捨てる
eq(applyEngineReq(h0, ctx, { kind: 'pass', by: 'B' }, 'B').ok, false, '② 番でない席の見送りは捨てる（11-2）')
eq(applyEngineReq(h0, ctx, { kind: 'pass', by: 'A' }, 'B').ok, false, '② 他の席を名乗る要求は捨てる（ホストが正 §1）')
eq(applyEngineReq(h0, ctx, { kind: 'choose', by: 'B', id: 'x', pick: [] }, 'B').ok, false, '② 無い選択への答えは捨てる')

// ③ 自動見送り: 宣言できるものが無ければ見送る・番でない席は見送らない
// R3⑤（利用者 2026-09-26）: 自分（AP）のメインフェイズだけは例外＝宣言できるものが無くても自動で終わらせない（フェイズ終了ボタンを光らせて誘導）
eq(isOwnMainDeclareWindow(s0, 'A'), true, '③ s0 は A の自分のメインフェイズの窓（R3⑤）')
eq(isOwnMainDeclareWindow(s0, 'B'), false, '③ B は AP でないので自分のメインフェイズの窓ではない')
eq(shouldAutoPass(s0, ctx, 'A'), false, '③ 自分のメインフェイズは宣言できるものが無くても自動見送りしない（R3⑤）')
eq(shouldAutoPass(s0, ctx, 'B'), false, '③ 番でない B は自動見送りしない')

// ④ 1要求＝history 1件（Undo 1回で要求の前に戻る）
const r3 = applyEngineReq(h0, ctx, { kind: 'pass', by: 'A' }, null)
eq(r3.ok && r3.history.past.length, 1, '④ 見送り1回で history は1件増える')
if (r3.ok) eq(undo(r3.history).present === s0, true, '④ Undo 1回で要求の前の盤面に戻る')

// ⑤ assist の旧データは free で読む（PHASE-R2u §1）
eq(fillBoardDefaults({ mode: 'assist' } as Partial<BoardState>).mode, 'free', '⑤ mode: assist の保存盤面は free として読む')

// ⑥ ターンの進行: 先攻の1ターン目のエントリーはドローしない・2ターン目以降はする（10-2-4 oldrule.txt:376-378・10-4[4]）
function runEntry(n: number): { hand: number; phase: string | undefined } {
  let h = hist({ ...board([card('dA0', 'A', 'deck'), card('dA1', 'A', 'deck'), card('dB0', 'B', 'deck')]), turn: { active: 'A', phase: 'エントリー', n } })
  h = { ...h, present: drive(h.present, ctx).state }
  for (let i = 0; i < 20 && h.present.turn?.phase === 'エントリー'; i++) {
    const seat = awaitingSeat(h.present)
    if (!seat) break
    const r = applyEngineReq(h, ctx, { kind: 'pass', by: seat })
    if (!r.ok) break
    h = r.history
  }
  return { hand: Object.values(h.present.cards).filter((c) => c.owner === 'A' && c.zone === 'hand').length, phase: h.present.turn?.phase }
}
eq(runEntry(1), { hand: 0, phase: 'メイン' }, '⑥ 先攻1ターン目: エントリーのドロー無しでメインへ（10-2-4）')
eq(runEntry(2), { hand: 1, phase: 'メイン' }, '⑥ 2ターン目: エントリーで1枚ドローしてメインへ（10-4[4]）')

// ⑦ フェイズの終了（10-2-2 oldrule.txt:367-369）: AP がフェイズ終了を宣言 → NAP が認めれば終了・認めなければ宣言は無効でフェイズは続く
{
  // AP のフェイズの窓での見送り＝フェイズ終了の宣言（統括11 のレビュー: 見送りと終えるは1ボタン）
  const h1 = r3.ok ? r3.history : h0
  eq([h1.present.turn?.phase, phaseEndPending(h1.present), awaitingSeat(h1.present)], ['メイン', true, 'B'], '⑦ AP の見送りはフェイズ終了の宣言になり、NAP の答えを待つ（10-2-2）')
  eq(shouldAutoPass(h1.present, ctx, 'B'), true, '⑦ NAP に宣言できるものが無ければ自動で認める（鳴き無しボタン §2-2）')
  eq(applyEngineReq(h1, ctx, { kind: 'phase', by: 'A', answer: 'accept' }).ok, false, '⑦ AP は自分の宣言を認められない（10-2-2 認めるのは NAP）')
  eq(applyEngineReq(h0, ctx, { kind: 'phase', by: 'B' }).ok, false, '⑦ NAP はフェイズ終了を宣言できない（10-2-2）')
  const deny = req(h1, { kind: 'phase', by: 'B', answer: 'deny' })
  eq([deny.present.turn?.phase, phaseEndPending(deny.present), awaitingSeat(deny.present)], ['メイン', false, 'A'], '⑦ 認めない: 宣言は無効でフェイズは続き、AP の番から（10-2-2）')
  const acc = req(h1, { kind: 'phase', by: 'B', answer: 'accept' })
  const f = topFrame(acc.present)
  eq([acc.present.turn?.phase, f?.kind, f?.step, awaitingSeat(acc.present)], ['終了', 'endPhase', 1, 'A'], '⑦ 認める: 終了フェイズへ（10-2-3）。[1]《終了フェイズ開始時》の宣言の機会（10-6[1]）')
}

// ⑧ 終了フェイズ（10-6 [1]〜[3]・10-6-1 oldrule.txt:417-429）→ 手札調整 → ターン終了（10-8）→ 相手のターン（10-2 交互）
{
  let h = hist({ ...board([card('LA', 'A', 'leader', { kiryoku: 4 }), card('X', 'A', 'hand'), card('Pay1', 'A', 'hand'), card('dA0', 'A', 'deck'), card('dB0', 'B', 'deck'), card('dB1', 'B', 'deck')]), turn: { active: 'A', phase: '終了', n: 1 } })
  h = { ...h, present: drive(h.present, ctxAll).state }
  eq([topFrame(h.present)?.kind, topFrame(h.present)?.step], ['endPhase', 1], '⑧ 終了フェイズは [1]《終了フェイズ開始時》から（10-6[1]）')
  h = passUntil(h, (s) => s.proc.length === 0)
  eq([h.present.procMeta.phaseRun, !!h.present.procMeta.base, awaitingSeat(h.present)], [PHASE_ACTIONS, true, 'A'], '⑧ [2] 終了フェイズのアクションの窓（10-6-1: AP から）')
  const call = applyEngineReq(h, ctxAll, { kind: 'declare', req: { by: 'A', source: 'X' } })
  eq(call.ok, false, '⑧ 終了フェイズにキャラは呼び出せない（10-6-1 はイベント・特殊能力・コスト発生・その他だけ）')
  eq(legalDeclarations(h.present, ctxAll, 'A').map((d) => d.label).sort(), ['LA（コスト）', 'Pay1', 'X（コスト）'], '⑧ 終了フェイズでもイベント・コスト発生は宣言できる（10-6-1）')
  // イベントを1回使って、また窓が開く（何度でも 10-6-1）
  const ev = req(h, { kind: 'declare', req: { by: 'A', source: 'Pay1', payWith: ['X'] } })
  const ev2 = passUntil(ev, (s) => s.proc.length === 0 && s.procMeta.base?.state === 'awaitActive')
  eq([ev2.present.turn?.phase, ev2.present.cards.Pay1.zone, awaitingSeat(ev2.present)], ['終了', 'trash', 'A'], '⑧ 終了フェイズのアクションの後もフェイズの窓は AP から開き直す（10-6-1「何度でも」）')
  let e = req(ev2, { kind: 'pass', by: 'A' })
  e = req(e, { kind: 'phase', by: 'B', answer: 'accept' })
  eq([topFrame(e.present)?.kind, topFrame(e.present)?.step], ['endPhase', 3], '⑧ 終了フェイズの終了が認められると [3]《終了フェイズ終了時》の宣言の機会（10-6[3]）')
  e = passUntil(e, (s) => s.turn?.active === 'B' && s.turn.phase === 'メイン')
  eq({ active: e.present.turn?.active, n: e.present.turn?.n, phase: e.present.turn?.phase }, { active: 'B', n: 2, phase: 'メイン' }, '⑧ 手札調整→ターン終了の後は相手の2ターン目（10-2・10-7・10-8）。B はエントリーを経てメインへ')
}

// ⑨ 手順を捨てる（§2-3）: 手順と選択が空になり、メインならメインの窓から（drive が開き直す）
{
  const withEntry = hist(drive({ ...board([card('dA0', 'A', 'deck')]), turn: { active: 'A', phase: 'エントリー', n: 2 } }, ctx).state)
  const r = applyEngineReq(withEntry, ctx, { kind: 'abandon', by: 'B' })
  eq(r.ok && { proc: r.history.present.proc.length, choice: r.history.present.procMeta.choice, phase: r.history.present.turn?.phase, wait: awaitingSeat(r.history.present) }, { proc: 0, choice: null, phase: 'メイン', wait: 'A' }, '⑨ エントリーで捨てると手順と選択が空になり、メインの窓から（§2-3）')
  const r2 = applyEngineReq(hist(s0), ctx, { kind: 'abandon', by: 'A' })
  eq(r2.ok && awaitingSeat(r2.history.present), 'A', '⑨ メインで捨てるとメインの窓から（AP の番）')
}

// ① 通し: 呼び出し → イベント → 相手の割り込み → ダメージ → ダウン → 終了（15-10-1・16-1・11-2・15-4-2・15-5-1・9-2）
{
  const start = board([
    card('LA', 'A', 'leader', { kiryoku: 8 }),
    card('LB', 'B', 'leader', { kiryoku: 8 }),
    card('Y', 'B', 'char', { kiryoku: 2 }),
    card('X', 'A', 'hand'),
    card('Hit', 'A', 'hand'),
    card('Int', 'B', 'hand'),
    card('dA0', 'A', 'deck'),
    card('dB0', 'B', 'deck'),
  ])
  let h = hist(drive({ ...start, ...inMain(2) }, ctxAll).state)
  // 呼び出し（15-10-1）: 宣言 → 相手が見送る → [6]〜[14] の窓を両者が見送る → 印刷された気力で消耗状態でフィールドに出る（[13]）
  h = req(h, { kind: 'declare', req: { by: 'A', source: 'X' } })
  h = passUntil(h, (s) => s.proc.length === 0 && s.procMeta.base?.state === 'awaitActive')
  const x = h.present.cards.X
  eq([x.zone, x.kiryoku, x.orientation, awaitingSeat(h.present)], ['char', 2, 'rested', 'A'], '① 呼び出し: X が気力2・消耗状態でフィールドへ（15-10-1[13] oldrule.txt:708）。メインの窓は AP から')
  // イベント（16-1）: Y を対象に宣言 → [11]《イベントカードを使用したとき》に B が割り込み（Int で X に1ダメージ）
  const hitAt = h.past.length
  h = req(h, { kind: 'declare', req: { by: 'A', source: 'Hit', targets: ['Y'] } })
  h = passUntil(h, (s) => topFrame(s)?.kind === 'event' && topFrame(s)?.step === 11 && awaitingSeat(s) === 'B')
  eq([topFrame(h.present)?.kind, topFrame(h.present)?.step, h.present.cards.Hit.zone], ['event', 11, 'trash'], '① イベントは [6] でゴミ箱へ・[11]《イベントカードを使用したとき》に相手の宣言の機会（16-1）')
  eq(legalDeclarations(h.present, ctxAll, 'B').some((d) => d.req.source === 'Int'), true, '① B は割込型の Int を宣言できる（使用タイミング《イベントカードを使用したとき》）')
  const intAt = h.past.length
  h = req(h, { kind: 'declare', req: { by: 'B', source: 'Int', targets: ['X'] } })
  const logsFrom = h.past.length
  h = passUntil(h, (s) => s.proc.length === 0 && s.procMeta.base?.state === 'awaitActive')
  // 割り込みは窓が閉じた時点で処理され、イベントの [12]〜[14] より先（11-2・16-1）→ X が先に1ダメージ、その後 Y に2ダメージ
  const steps = h.past.slice(logsFrom).flatMap((p) => p.log.steps ?? [])
  const dmg = steps.filter((s) => s.text.startsWith('ダメージ')).map((s) => s.iids.join(','))
  eq(dmg, ['X', 'Y'], '① 割り込み（X に1）→ イベントの効果（Y に2）の順にダメージ（11-2・16-1[14]）。段はログに1行ずつ')
  eq([h.present.cards.X.kiryoku, h.present.cards.Y.zone, h.present.downs.B, h.present.result], [1, 'trash', 1, null], '① Y は気力0でダウン→ゴミ箱・B のダウン数1（15-4-2・15-5-1[6]・9-2）')
  eq([h.present.proc.length, awaitingSeat(h.present), activeSeat(h.present)], [0, 'A', 'A'], '① 手順が終わり、メインの窓は AP から（13-3・10-5-1）')
  // 非公開: 手札のカードの名前は、宣言して提示する（公開になる 16-1[3]）前のログに出ない
  eq([h.past.slice(0, hitAt).some((p) => /Hit|Int/.test(p.log.text)), h.past.slice(0, intAt).some((p) => /Int/.test(p.log.text))], [false, false], '① 宣言する前の手札のカード名はログに出ない（§1 非公開）')
}

// ⑩ 支払い（§2-1・payPool）: 指定した発生済みのコストだけで払う（FAQ:2959-2960）。発生済みだけで1通りなら聞かない
{
  const base = board([card('LA', 'A', 'leader', { kiryoku: 8 }), card('Pay1', 'A', 'hand'), card('Pay2', 'A', 'hand'), card('dA0', 'A', 'deck'), card('dA1', 'A', 'deck'), card('dB0', 'B', 'deck')])
  const withCosts = (attrs: string[][]): BoardState => ({ ...base, ...inMain(2), costs: { A: attrs.map((a, i) => ({ id: `k${i + 1}`, icon: 'W' as const, attrs: a, frameId: null })), B: [] } })
  const two = drive(withCosts([['根'], []]), ctxAll).state
  const need = paymentNeed(two, ctxAll, { by: 'A', source: 'Pay1' })
  eq([need.choose, need.pool], [true, ['k1', 'k2']], '⑩ 発生済みのコストの組み合わせが2通り（根・無属性）なら支払いを選ばせる（§2-1）')
  let h = req(hist(two), { kind: 'declare', req: { by: 'A', source: 'Pay1', payPool: ['k2'] } })
  h = passUntil(h, (s) => s.proc.length === 0 && s.procMeta.base?.state === 'awaitActive')
  eq([h.present.costs.A.map((t) => t.id), h.present.cards.Pay1.zone], [['k1'], 'trash'], '⑩ payPool で選んだ k2 だけを使って払う（残りの k1 は使わない）')
  let h2 = req(hist(two), { kind: 'declare', req: { by: 'A', source: 'Pay2', payPool: ['k1'] } })
  h2 = passUntil(h2, (s) => s.proc.length === 0 && s.procMeta.base?.state === 'awaitActive')
  eq([h2.present.costs.A.map((t) => t.id), h2.present.procMeta.aborted.length], [['k1', 'k2'], 1], '⑩ 指定した k1 だけでは WW に足りない → 指定していない k2 では払えず中断（FAQ:2959「指定した支払い方法以外で支払うことはできません」）')
  const same = drive(withCosts([['根'], ['根']]), ctxAll).state
  const auto = paymentNeed(same, ctxAll, { by: 'A', source: 'Pay1' })
  eq([auto.choose, auto.autoPool?.length], [false, 1], '⑩ 発生済みのコストだけで払え、組み合わせが1通り（根・根のどちらでも同じ）なら聞かない（§2-1 の例外）')
}

// ⑪ 開始（P5b の後）とエンジンへの切り替え
{
  const pre = { ...board([card('LA', 'A', 'leader')]), turn: null, setup: { A: { deckName: 'd', mulliganUsed: false, leaderRevealed: false }, B: null } }
  eq(applyEngineReq(hist(pre), ctx, { kind: 'start', by: 'A', first: 'B' }).ok, false, '⑪ 開始準備（リーダーを表にする）が済むまで始められない（P5b）')
  const ready = { ...pre, setup: { A: { deckName: 'd', mulliganUsed: false, leaderRevealed: true }, B: null } }
  const st = applyEngineReq(hist(ready), ctx, { kind: 'start', by: 'A', first: 'B' })
  eq(st.ok && [st.history.present.turn?.active, st.history.present.turn?.n, st.history.present.mode], ['B', 1, 'engine'], '⑪ 先攻を選んで始める（先攻 B の1ターン目）')
  const free = { ...board([card('dA0', 'A', 'deck')]), mode: 'free' as const }
  const on = applyEngineReq(hist(free), ctx, { kind: 'engineOn', by: 'B' })
  eq(on.ok && [on.history.present.mode, awaitingSeat(on.history.present), on.history.past.length], ['engine', 'A', 1], '⑪ 手動からエンジンに戻すと今の盤面から drive で続く（メインの窓が開く・history 1件）')
}

// ⑫ メインフェイズ（10-5 oldrule.txt:391-394）: [1]《メインフェイズ開始時》→ [2] アクションの窓 → フェイズ終了が認められたら [3]《メインフェイズ終了時》→ 終了フェイズ
{
  let h = hist(drive({ ...board([card('dA0', 'A', 'deck'), card('dB0', 'B', 'deck')]), turn: { active: 'A', phase: 'メイン', n: 2 } }, ctx).state)
  eq([topFrame(h.present)?.kind, topFrame(h.present)?.step, awaitingSeat(h.present)], ['mainPhase', 1, 'A'], '⑫ メインフェイズは [1]《メインフェイズ開始時》の宣言の機会から（10-5[1]）')
  h = passUntil(h, (s) => s.proc.length === 0)
  eq([h.present.procMeta.phaseRun, !!h.present.procMeta.base, awaitingSeat(h.present)], [MAIN_ACTIONS, true, 'A'], '⑫ [2] メインフェイズのアクションの窓（10-5-1: AP から）')
  h = req(h, { kind: 'pass', by: 'A' })
  h = req(h, { kind: 'phase', by: 'B', answer: 'accept' })
  eq([h.present.turn?.phase, topFrame(h.present)?.kind, topFrame(h.present)?.step], ['メイン', 'mainPhase', 3], '⑫ フェイズ終了が認められると [3]《メインフェイズ終了時》の宣言の機会（10-5[3]）。まだメインフェイズ')
  h = passUntil(h, (s) => s.turn?.phase !== 'メイン')
  eq([h.present.turn?.phase, topFrame(h.present)?.kind, topFrame(h.present)?.step], ['終了', 'endPhase', 1], '⑫ [3] が終わると終了フェイズ [1]（10-2-3）')
  // エントリーの後もメインは [1] から（10-2-3 → 10-5[1]）
  let e = hist(drive({ ...board([card('dA0', 'A', 'deck'), card('dA1', 'A', 'deck')]), turn: { active: 'A', phase: 'エントリー', n: 2 } }, ctx).state)
  e = passUntil(e, (s) => s.turn?.phase === 'メイン')
  eq([topFrame(e.present)?.kind, topFrame(e.present)?.step], ['mainPhase', 1], '⑫ エントリーフェイズの後はメインフェイズ [1] から')
}

// ⑬ バトルの通し（20-4 oldrule.txt:1062-1127）: 挑む → [7] 参加 → [11] 参加 → [16] 種目 → [19]〜[22]（[21] で戻る）→ [23][24] 結果 → [26] ダウン → [29] → 終わり
const st = (p: number) => ({ 力: p, 早: 0, 賢: 0, 根: 0, 感: 0 })
const BINFOS: CardInfo[] = [
  { ...info('BL', 'c', 4), stats: st(1) },
  { ...info('BM', 'c', 4), stats: st(1) },
  { ...info('BX', 'c', 3), stats: st(5) },
  { ...info('BY', 'c', 2), stats: st(2) },
  { ...info('Kumi', 'b', null), battleAtk: '力', battleDef: '力' },
  { ...info('Odd', 'b', null), battleAtk: '？', battleDef: '？' },
]
const ctxB = { cards: Object.fromEntries(BINFOS.map((c) => [c.id, c])), defs: {} }
function reqB(h: History, r: EngineReq, sender: Seat | null = null): History {
  const x = applyEngineReq(h, ctxB, r, sender)
  if (!x.ok) throw new Error(`要求が断られた: ${JSON.stringify(r)} → ${x.reason}`)
  return x.history
}
/** 見送り続けて、条件を満たすか選択が出るまで */
function passB(h: History, pred: (s: BoardState) => boolean, limit = 120): History {
  for (let i = 0; i < limit && !pred(h.present); i++) {
    const seat = awaitingSeat(h.present)
    if (!seat || h.present.procMeta.choice) break
    h = reqB(h, { kind: 'pass', by: seat })
  }
  return h
}
const choiceOf = (s: BoardState) => s.procMeta.choice
const topOf = (s: BoardState) => s.proc[s.proc.length - 1]
function battleStart(battleCard: string): History {
  const cards = [
    card('BL', 'A', 'leader', { kiryoku: 8, orientation: 'rested' }),
    card('BX', 'A', 'char', { kiryoku: 3 }),
    card('BM', 'B', 'leader', { kiryoku: 8, orientation: 'rested' }),
    card('BY', 'B', 'char', { kiryoku: 2 }),
    card(battleCard, 'A', 'battle', { used: false }),
    card('dA0', 'A', 'deck'),
    card('dA1', 'A', 'deck'),
    card('dB0', 'B', 'deck'),
  ]
  return hist(drive({ ...board(cards), ...inMain(2) }, ctxB).state)
}
{
  let h = battleStart('Kumi')
  const decl = legalDeclarations(h.present, ctxB, 'A').filter((d) => d.req.battle)
  eq(decl.map((d) => d.label), ['バトルを挑む'], '⑬ メインの窓で AP はバトルを挑める（20-2・20-3）。ボタンは1つ')
  eq(applyEngineReq(h, ctxB, { kind: 'declare', req: { by: 'B', source: 'BY', battle: true } }).ok, false, '⑬ NAP はバトルを挑めない（20-2 自分のメインフェイズ）')
  h = reqB(h, { kind: 'declare', req: decl[0]?.req ?? { by: 'A', source: 'BX', battle: true } })
  eq(awaitingSeat(h.present), 'B', '⑬ [2] 相手プレイヤーの同時アクションの宣言の機会（20-4[2]）')
  h = passB(h, (s) => !!choiceOf(s))
  let ch = choiceOf(h.present)
  eq([ch?.purpose, ch?.by, [...(ch?.options.map((o) => o.key) ?? [])].sort()], ['battleParticipant', 'A', ['BX']], '⑬ [7] 挑んだ側が待機状態のキャラから参加キャラを指定（20-7。消耗状態のリーダーは候補でない）')
  h = reqB(h, { kind: 'choose', by: 'A', id: ch!.id, pick: ['BX'] })
  eq(h.present.cards.BX.orientation, 'rested', '⑬ [7] 指定したらそのキャラを消耗させる（20-4[7]・FAQ:3465 指定した瞬間）')
  h = passB(h, (s) => !!choiceOf(s))
  ch = choiceOf(h.present)
  eq([ch?.purpose, ch?.by, [...(ch?.options.map((o) => o.key) ?? [])].sort()], ['battleParticipant', 'B', ['BM', 'BY']], '⑬ [11] 挑まれた側は待機状態のキャラか、リーダー（消耗状態でもよい）から指定（20-8）')
  h = reqB(h, { kind: 'choose', by: 'B', id: ch!.id, pick: ['BY'] }, 'B')
  eq(h.present.cards.BY.orientation, 'rested', '⑬ [11] 指定したらそのキャラを消耗させる（20-4[11]）')
  h = passB(h, (s) => !!choiceOf(s))
  ch = choiceOf(h.present)
  eq([ch?.purpose, ch?.by], ['battleCard', 'A'], '⑬ [16] バトル種目は挑んだ側が選ぶ（DESIGN §4.10 利用者の決定）')
  eq(applyEngineReq(h, ctxB, { kind: 'choose', by: 'B', id: ch!.id, pick: ['Kumi'] }, 'B').ok, false, '⑬ [16] 挑まれた側の答えは捨てる（ホストが正）')
  h = reqB(h, { kind: 'choose', by: 'A', id: ch!.id, pick: ['Kumi'] })
  eq([topOf(h.present).step, h.present.cards.Kumi.used], [17, false], '⑬ [16] の後は [17]《バトルカードを選択したとき》の宣言の機会（まだ未使用）')
  h = passB(h, (s) => topOf(s)?.step === 19)
  eq(h.present.cards.Kumi.used, true, '⑬ [18] バトル種目のバトルカードを使用済み状態にする（20-4[18]1）')
  eq([topOf(h.present).kind, topOf(h.present).step, awaitingSeat(h.present)], ['battle', 19, 'A'], '⑬ [19] 挑んだプレイヤー（AP）から宣言の機会（20-4[19]）')
  h = passB(h, (s) => !!choiceOf(s))
  ch = choiceOf(h.present)
  eq([ch?.purpose, ch?.by], ['battleLoop', 'A'], '⑬ [21] 挑んだプレイヤーが [19] に戻るか進むかを選ぶ（20-4[21]）')
  h = reqB(h, { kind: 'choose', by: 'A', id: ch!.id, pick: ['back'] })
  eq(topOf(h.present).step, 19, '⑬ [21] で戻ると [19] の機会がもう一度ある')
  h = passB(h, (s) => !!choiceOf(s))
  ch = choiceOf(h.present)
  h = reqB(h, { kind: 'choose', by: 'A', id: ch!.id, pick: ['next'] })
  eq(topOf(h.present).step, 22, '⑬ [21] で進むと [22]（20-4[22]）')
  const handA = Object.values(h.present.cards).filter((c) => c.owner === 'A' && c.zone === 'hand').length
  const at22 = h.past.length
  h = passB(h, (s) => s.proc.length === 0 && s.procMeta.base?.state === 'awaitActive')
  // [23] 力/力 の種目: BX 攻5・防5／BY 攻2・防2（20-10）→ [24] A←2−5（0以下＝発生しない）・B←5−2=3
  const bl = h.present.procMeta.battles
  eq([bl.length, bl[0]?.aborted, bl[0]?.battleCard], [1, null, 'Kumi'], '⑬ バトルは中断せずに終わった（結果のダウンは 20-6 の中断に数えない）')
  eq([h.present.cards.BY.zone, h.present.downs.B, h.present.cards.BX.kiryoku, h.present.cards.BX.zone], ['trash', 1, 3, 'char'], '⑬ 結果ダメージ B←3 で BY（気力2）がダウン→ゴミ箱・B のダウン数1。A←−3 は 0 以下で発生しない（20-10・15-5-1）')
  eq(Object.values(h.present.cards).filter((c) => c.owner === 'A' && c.zone === 'hand').length, handA + 1, '⑬ 相手のキャラがダウンしたので A はボーナスドロー1枚（15-5-1[5]）')
  const stepTexts = h.past.slice(at22).flatMap((p) => p.log.steps ?? []).map((x) => x.text)
  eq([stepTexts.some((t) => t.startsWith('バトルの結果')), stepTexts.some((t) => t.startsWith('バトル終了'))], [true, true], '⑬ 結果とバトルの終わりが段としてログに出る（§2-4）')
  eq([awaitingSeat(h.present), h.present.turn?.phase], ['A', 'メイン'], '⑬ バトルの後はメインの窓（AP から）')
}

// ⑭ [23] エンジンが攻防の値を出せない種目（攻・防が「？」）: 人が値を入れる（values 要求）。入れた値で結果を出す（20-10）
{
  let h = battleStart('Odd')
  h = reqB(h, { kind: 'declare', req: { by: 'A', source: 'BX', battle: true } })
  for (let i = 0; i < 12; i++) {
    h = passB(h, (s) => !!choiceOf(s) || topOf(s)?.engineWhat === 'battleValues')
    const ch = choiceOf(h.present)
    if (!ch) break
    const pick = ch.purpose === 'battleParticipant' ? [ch.by === 'A' ? 'BX' : 'BY'] : ch.purpose === 'battleCard' ? ['Odd'] : ['next']
    h = reqB(h, { kind: 'choose', by: ch.by, id: ch.id, pick })
  }
  const top = topOf(h.present)
  eq([top?.kind, top?.step, top?.status, top?.engineWhat], ['battle', 23, 'engine', 'battleValues'], '⑭ 攻防が能力値アイコン1つでない種目は [23] で止まり、人の入力を待つ')
  eq(applyEngineReq(h, ctxB, { kind: 'values', by: 'B', values: { A: { atk: 1, def: 0 }, B: { atk: 1, def: 0 } } }, 'A').ok, false, '⑭ 他の席を名乗る値の入力は捨てる')
  eq(applyEngineReq(h, ctxB, { kind: 'values', by: 'A', values: { A: { atk: 1.5, def: 0 }, B: { atk: 1, def: 0 } } }).ok, false, '⑭ 整数でない値は断る')
  eq(applyEngineReq(battleStart('Odd'), ctxB, { kind: 'values', by: 'A', values: { A: { atk: 1, def: 0 }, B: { atk: 1, def: 0 } } }).ok, false, '⑭ [23] でないときの値の入力は断る')
  // B（挑まれた側）が入れてもよい【決めたこと】。A 攻1・防0／B 攻3・防1 → A←3−0=3・B←1−1=0（発生しない）
  h = reqB(h, { kind: 'values', by: 'B', values: { A: { atk: 1, def: 0 }, B: { atk: 3, def: 1 } } }, 'B')
  h = passB(h, (s) => s.proc.length === 0 && s.procMeta.base?.state === 'awaitActive')
  eq([h.present.cards.BX.zone, h.present.downs.A, h.present.cards.BY.kiryoku], ['trash', 1, 2], '⑭ 入れた値で結果ダメージ A←3（BX 気力3→0 でダウン）・B←0（発生しない）（20-10・15-5）')
}

// ⑮ 自動の見送りはログで1行に畳む（統括11 の検証の気づき3）。フェイズ終了の宣言・承認は畳まない
{
  let h = battleStart('Kumi')
  h = reqB(h, { kind: 'declare', req: { by: 'A', source: 'BX', battle: true } })
  const from = h.past.length
  for (let i = 0; i < 4; i++) {
    const seat = awaitingSeat(h.present)
    if (!seat || choiceOf(h.present)) break
    h = reqB(h, { kind: 'pass', by: seat, auto: true })
  }
  const logs = h.past.slice(from).map((p) => p.log)
  const rows = foldLog(logs)
  eq([logs.length > 1, logs.every((l) => l.auto), rows.length, rows[0]?.text.startsWith('自動で見送り ×')], [true, true, 1, true], '⑮ 続いた自動の見送りは「自動で見送り ×N」の1行になる（Undo は1要求ずつのまま）')
  const pe = applyEngineReq(hist(s0), ctx, { kind: 'pass', by: 'A', auto: true })
  eq(pe.ok && pe.history.past[0].log.auto, undefined, '⑮ 自動でもフェイズ終了の宣言（10-2-2）はログで畳まない')
}

// =============================================================================
// R3: 継続効果の層（K3）・人の手直しの層・合法性の警告（K4）・場の制限の是正（K12）— PHASE-R3 §3-7
//   12-1（oldrule.txt:493-500）「これらの効果によって得られた能力値修正はターン終了時に失われます」「対象が失われた場合…失われます」
//   12-2（501-515）「新たにこれらの効果が発揮した場合は、既に発揮した全ての効果の後に発揮したとみなされ」「発生元がフィールドから失われた場合、その効果も失われます」
//   H-6（DESIGN §5.3・統括12 2026-09-26 D1）「印刷値（元の能力値・常に同じ）で入れ替えて上書き（例 元 力5・感1＋力+2 → 力1・感5）」・並びは装備するたびに装備させたプレイヤーが選ぶ（FAQ:443）
//   DESIGN §5.4「人の手直しの層」: 人が盤面を直した修正は導出の最後に重ねる・消すのも人
//   11-3（485-486）「プレイヤーは空打ちのアクションの宣言をすることができません」・【～の対象にならない】（1178-1179）・DESIGN §5.4「段階」（R3 は警告だけ）
//   15-2（590-605）「該当プレイヤーは即座に…１体づつ選択してゴミ箱送り」・17-1（846-853）・FAQ:3329（キャラ数制限を受けないキャラ）
// =============================================================================
{
  const st = (id: string, kind: CardInfo['kind'], stats: Record<string, number> | null, kiryoku: number | null = 5, abilities: { header: string; cost: string }[] = []): CardInfo => ({ id, name: id.replace(/\d+$/, ''), kind, kiryoku, stats, cost: '', attr: '', abilities })
  const S = (p: number, h: number, k: number, n: number, s: number) => ({ 力: p, 早: h, 賢: k, 根: n, 感: s })
  const R3I: CardInfo[] = [
    st('LA', 'c', S(1, 1, 1, 1, 1)),
    st('LB', 'c', S(1, 1, 1, 1, 1)),
    st('Q', 'c', S(5, 3, 3, 3, 1)),
    st('Tie', 'c', S(5, 5, 3, 1, 1)),
    st('P', 'c', S(3, 1, 2, 2, 2), 5, [{ header: 'Zap', cost: '' }]),
    st('Y', 'c', S(1, 1, 1, 1, 1)),
    st('Same1', 'c', S(1, 1, 1, 1, 1)),
    st('Same2', 'c', S(1, 1, 1, 1, 1)),
    st('Kinoko', 'i', null, null),
    st('Circ', 'i', null, null),
    st('LOnly', 'i', null, null),
    st('Denpa', 'i', null, null),
    st('Plain', 'i', null, null),
    st('NoEv', 'f', null, null),
    st('NoEvT', 'f', null, null),
    st('Hit', 'e', null, null),
    st('Heal', 'e', null, null),
    st('Snatch', 'e', null, null),
    { ...st('Robo', 'c', S(1, 1, 1, 1, 1)), charTypes: ['ロボ'] },
    { ...st('GC', 'c', S(1, 1, 1, 1, 1)), cost: 'WW' },
    st('OF', 'c', S(1, 1, 1, 1, 1), 5),
    st('CallSrc', 'c', S(1, 1, 1, 1, 1), 3),
    st('Caller', 'c', S(1, 1, 1, 1, 1)),
    st('Sabo', 'e', null, null),
    st('Weak', 'c', S(3, 3, 3, 3, 3)),
    st('WeakOpt', 'c', S(3, 3, 3, 3, 3)),
    st('PBP', 'c', S(1, 1, 1, 1, 1), 5),
    st('RC', 'e', null, null),
  ]
  const self = { ref: 'self' as const }
  const equipped = { ref: 'equipped' as const }
  const R3D: Record<string, CardDef> = {
    Kinoko: { id: 'Kinoko', name: 'Kinoko', kind: 'i', status: 'draft', holes: ['H-6'], equip: { targetKind: 'キャラ' }, abilities: [{ kind: 'static', effects: [{ ce: 'statSwap', who: equipped, tieBreak: { chooser: 'equipper', when: 'apply' } }] }] },
    Circ: { id: 'Circ', name: 'Circ', kind: 'i', status: 'draft', equip: { targetKind: 'キャラ' }, abilities: [{ kind: 'static', effects: [{ ce: 'untargetable', who: equipped, by: { kinds: ['特殊能力'] } }] }] },
    LOnly: { id: 'LOnly', name: 'LOnly', kind: 'i', status: 'draft', equip: { targetKind: 'キャラ', leaderOnly: true }, abilities: [] },
    Denpa: { id: 'Denpa', name: 'Denpa', kind: 'i', status: 'draft', equip: { targetKind: 'キャラ', bound: true }, abilities: [{ kind: 'static', effects: [{ ce: 'whenLost', do: [{ op: 'down', who: equipped }] }] }] },
    NoEv: { id: 'NoEv', name: 'NoEv', kind: 'f', status: 'draft', abilities: [{ kind: 'static', effects: [{ ce: 'prohibit', action: { kinds: ['イベント'], by: 'any' } }] }] },
    NoEvT: { id: 'NoEvT', name: 'NoEvT', kind: 'f', status: 'tested', abilities: [{ kind: 'static', effects: [{ ce: 'prohibit', action: { kinds: ['イベント'], by: 'any' } }] }] },
    P: { id: 'P', name: 'P', kind: 'c', status: 'draft', abilities: [{ kind: 'activated', name: 'Zap', cost: { icons: [], attrs: [] }, speed: '通常型', choices: [{ slot: 't', chooser: 'you', pick: { cards: { zone: 'field', side: 'opponent', class: 'キャラ', excludeLeader: true } }, count: [1, 1], mode: 'target', when: 'declare' }], effect: [{ op: 'damage', to: { ref: 'slot', slot: 't' }, amount: 1 }] }] },
    Hit: DEFS.Hit,
    // D11・R4a-2 単体テスト用: Heal（通常型・宣言時に対象。気力+3回復）と Snatch（割込型「イベントカードを
    // 使用したとき」・hijack）。対象の選び直し（宣言時と違う候補を選べる）と、元の使用者は使えないことを確かめる
    Heal: { id: 'Heal', name: 'Heal', kind: 'e', status: 'draft', cost: { icons: [], attrs: [] }, abilities: [{ kind: 'play', speed: '通常型', choices: [{ slot: 't', chooser: 'you', pick: { cards: { zone: 'field', side: 'both', class: 'キャラ', excludeLeader: true } }, count: [1, 1], mode: 'target', when: 'declare' }], effect: [{ op: 'kiryoku', who: { ref: 'slot', slot: 't' }, delta: 3, recover: true }] }] },
    Snatch: { id: 'Snatch', name: 'Snatch', kind: 'e', status: 'draft', cost: { icons: [], attrs: [] }, abilities: [{ kind: 'play', speed: '割込型', trigger: { timing: 'イベントカードを使用したとき', actor: 'opponent' }, choices: [], effect: [{ op: 'hijack', what: { declared: { ref: 'event', role: 'declaredAction' } } }] }] },
    GC: {
      id: 'GC',
      name: 'GC',
      kind: 'c',
      status: 'draft',
      abilities: [
        { kind: 'activated', name: 'Gen1', cost: { icons: [], attrs: [] }, speed: '通常型', choices: [], effect: [{ op: 'generateCost', icons: ['W', 'W'] }] },
        { kind: 'activated', name: 'Gen2', cost: { icons: [], attrs: [] }, speed: '通常型', choices: [], effect: [{ op: 'generateCost', icons: { callCostOf: self, extra: ['W'] } }] },
      ],
    },
    // D20・R4a-2 単体テスト用: offer（払う→ generateCost の useAs で相手のコストになる／払わない→気力－２）
    OF: { id: 'OF', name: 'OF', kind: 'c', status: 'draft', abilities: [{ kind: 'activated', name: 'Ask', cost: { icons: [], attrs: [] }, speed: '通常型', choices: [], effect: [{ op: 'offer', to: 'opponent', prompt: 'pay', pay: [], ifPaid: [{ op: 'generateCost', who: 'opponent', icons: ['W'], useAs: 'you' }], ifDeclined: [{ op: 'kiryoku', who: self, delta: -2 }] }] }] },
    // D17・R4a-2 単体テスト用: 効果で呼び出す（callByEffect）。呼び出されるとき（窓）はまだ場に出ていないことを確かめる
    Caller: { id: 'Caller', name: 'Caller', kind: 'c', status: 'draft', abilities: [{ kind: 'activated', name: 'DoCall', cost: { icons: [], attrs: [] }, speed: '通常型', choices: [], effect: [{ op: 'choose', choice: { slot: 'w', chooser: 'you', pick: { cards: { zone: 'hand', side: 'you', class: 'キャラクター' } }, count: [1, 1], mode: 'select', when: 'resolve' } }, { op: 'callByEffect', what: { ref: 'slot', slot: 'w' }, orientation: 'ready' }] }] },
    // 妨害工作の最小限（割込型「キャラクターカードが呼び出されるとき」でゴミ箱送り）
    Sabo: { id: 'Sabo', name: 'Sabo', kind: 'e', status: 'draft', cost: { icons: [], attrs: [] }, abilities: [{ kind: 'play', speed: '割込型', trigger: { timing: 'キャラクターカードが呼び出されるとき', actor: 'opponent' }, choices: [], effect: [{ op: 'trash', what: { ref: 'event', role: 'summonedChar' } }] }] },
    // PHASE-R4b0 追加: 光岡悟「短命」・佐藤雅史「消極的」と同じ形の conditional（処理条件がある常時効果。宣言を通らない）。
    // Weak（強制・自分のターン終了時に気力－1）・WeakOpt（できる・自分のターン終了時に気力+1。どちらも kiryoku で
    // 見る＝ duration:'endOfTurn' の statMod だと同じ《ターン終了時》の段2で即座に失われて検証しづらいため。
    // recover:true は付けない＝付けると NH-17（D15）の「回復を宣言化する」別経路（幸せ泥棒用）に入ってしまい、
    // 今回の追加（conditional の素の item 経路）の検証にならないため）
    Weak: { id: 'Weak', name: 'Weak', kind: 'c', status: 'draft', abilities: [{ kind: 'conditional', trigger: { timing: 'ターン終了時', when: { activeIs: 'you' } }, optional: false, effect: [{ op: 'kiryoku', who: self, delta: -1 }] }] },
    WeakOpt: { id: 'WeakOpt', name: 'WeakOpt', kind: 'c', status: 'draft', abilities: [{ kind: 'conditional', trigger: { timing: 'ターン終了時', when: { activeIs: 'you' } }, optional: true, effect: [{ op: 'kiryoku', who: self, delta: 1 }] }] },
    // PHASE-R4b §2(D)・統括17の直し 単体テスト用: payByPlayer が実際に 7-2[3]《コストを発生するとき》の窓を開くことを
    // 確かめる。RC は臨時収入と同じ本文「[WWW]を発生する。コストを発生するときに使うこともできる」の最小限（割込型のみ）
    PBP: { id: 'PBP', name: 'PBP', kind: 'c', status: 'draft', abilities: [{ kind: 'activated', name: 'Ask', cost: { icons: [], attrs: [] }, speed: '通常型', choices: [], effect: [{ op: 'payByPlayer', who: 'opponent', amount: ['W'], giveTo: 'you', ifPaid: [], ifNot: [] }] }] },
    RC: { id: 'RC', name: 'RC', kind: 'e', status: 'draft', cost: { icons: [], attrs: [] }, abilities: [{ kind: 'play', speed: '割込型', trigger: { timing: 'コストを発生するとき', actor: 'you' }, choices: [], effect: [{ op: 'generateCost', icons: ['W', 'W', 'W'] }] }] },
  }
  const ctx3 = { cards: Object.fromEntries(R3I.map((c) => [c.id, c])), defs: R3D }
  const base3 = (cs: CardInstance[]) => ({ ...board([card('LA', 'A', 'leader', { kiryoku: 10 }), card('LB', 'B', 'leader', { kiryoku: 10 }), card('dA', 'A', 'deck'), card('dB', 'B', 'deck'), ...cs]), mode: 'engine' as const })
  const act3 = (s: BoardState, a: Parameters<typeof applyAction>[1]) => applyAction(s, a).state
  const modSeed = (iid: string, stat: string, delta: number) => ({ source: null, ability: null, by: 'A' as const, label: `${stat}${delta}`, kind: '能力値修正' as const, until: 'turn' as const, targets: [iid], host: null, body: { mod: { stat, delta } } })

  // ⑯ H-6 と層の順・手直しの層は最後（右クリックの修正はエンジンの導出の後も残る）
  let s = base3([card('Q', 'A', 'char', { kiryoku: 5 }), card('Kinoko', 'A', 'hand')])
  s = act3(s, { type: 'procLayers', add: [modSeed('Q', '力', 2)] }) // 先に掛かった修正（力+2）
  s = act3(s, { type: 'attach', itemIid: 'Kinoko', targetIid: 'Q', itemName: 'Kinoko', targetName: 'Q' })
  s = act3(s, { type: 'moveCard', iid: 'Kinoko', toZone: 'char', toIndex: 100, cardName: 'Kinoko' })
  s = drive(s, ctx3).state // 常時効果の層（Kinoko の入れ替え）が足される＝力+2 の後
  eq([currentStat(ctx3, s, 'Q', '力'), currentStat(ctx3, s, 'Q', '感')], [1, 5], '⑯a H-6（D1）: 印刷値（元 力5・感1）で入れ替えて上書き・先に掛かった力+2は消える')
  s = act3(s, { type: 'procLayers', add: [modSeed('Q', '力', 1)] })
  s = act3(s, { type: 'addModifier', modifier: { id: 'hand1', targetIid: 'Q', sourceLabel: '手', stat: '感', delta: 1, kind: '能力値修正', scope: 'その他' }, cardName: 'Q' })
  s = drive(s, ctx3).state
  eq([currentStat(ctx3, s, 'Q', '力'), currentStat(ctx3, s, 'Q', '感')], [2, 6], '⑯b 入れ替えより後から来た修正は上に乗る（力+1）・右クリックの修正（手直しの層）は導出の最後に重なる')
  s = act3(s, { type: 'procPhase', to: 'ターン終了' })
  s = drive(s, ctx3).state
  eq([currentStat(ctx3, s, 'Q', '力'), currentStat(ctx3, s, 'Q', '感'), Object.keys(s.modifiers), s.layers.list.length], [1, 6, ['hand1'], 1], '⑯c 10-8 で効果の修正（ターン終了時まで）は外れ、常時効果（入れ替え）と手直しの層は残る（元 力5・感1 の入れ替え=力1・感5 に手直し 感+1）')
  s = act3(s, { type: 'removeModifier', modId: 'hand1', cardName: 'Q' })
  eq(currentStat(ctx3, s, 'Q', '感'), 5, '⑯d 手直しを消すのは人（消したら導出だけの値）')

  // ⑯e H-6 の並び（FAQ:443）: 印刷値の最高（力・早＝5）・最低（根・感＝1）が複数あるとき、装備させたプレイヤーに選ばせる（swapChoiceFix）
  {
    let t = base3([card('Tie', 'A', 'char'), card('Kinoko2', 'A', 'hand', { cardId: 'Kinoko' })])
    t = act3(t, { type: 'attach', itemIid: 'Kinoko2', targetIid: 'Tie', itemName: 'Kinoko2', targetName: 'Tie' })
    t = act3(t, { type: 'moveCard', iid: 'Kinoko2', toZone: 'char', toIndex: 100, cardName: 'Kinoko2' })
    t = drive(t, ctx3).state
    const ch = t.procMeta.choice
    eq([ch?.by, ch?.kind, ch?.options.length], ['A', 'select', 4], '⑯e 並びがあると drive が止まって装備させたプレイヤー（A）に問う（力/早 × 根/感 の4通り）')
    t = drive(act3(t, { type: 'procChoose', id: ch!.id, pick: ['早:根'] }), ctx3).state
    eq([currentStat(ctx3, t, 'Tie', '早'), currentStat(ctx3, t, 'Tie', '根'), currentStat(ctx3, t, 'Tie', '力'), currentStat(ctx3, t, 'Tie', '感')], [1, 5, 5, 1], '⑯e 選んだ組（早・根）だけが入れ替わり、他（力・感）は印刷値のまま')
  }

  // D24（吸血・カード本文「このキャラと「ロボ」は指定できない」）: charType 除外の選択（chara 相当の Selector）はロボを候補から外す
  {
    const robo = drive(base3([card('Q', 'A', 'char'), card('Robo2', 'A', 'char', { cardId: 'Robo' })]), ctx3).state
    const sel = { zone: 'field' as const, side: 'you' as const, class: 'キャラ' as const, where: { not: { charType: [{ ref: 'it' as const }, 'ロボ'] } } }
    eq(
      select(ctx3, robo, { self: null, you: 'A', slots: {}, trigger: null, declId: null, declared: {} }, sel).sort(),
      ['LA', 'Q'].sort(),
      '㉑ D24: charType 除外の Selector はキャラタイプ「ロボ」を持つカード（Robo2）を候補から外す（他の味方キャラは候補のまま）',
    )
  }

  // D21 generateCost（効果でコストを発生させる。得たコストは frameId 無し＝すぐ「その他の代償」として使える 7-3）
  {
    let g = drive(base3([card('GC', 'A', 'char')]), ctx3).state
    // 実戦では自動見送り（shouldAutoPass）を満たす窓だけクライアントが procPass を自動で送る（自分のメインフェイズは
    // 送らない＝R3⑤・DESIGN §5.3）。ここではそれを模して、宣言した能力の処理が終わって自分のメインフェイズに
    // 戻る（＝もう自動見送りの対象でない）ところまでだけ見送りきる
    const settle = (s: BoardState): BoardState => {
      let cur = s
      for (let i = 0; i < 50; i++) {
        const seat = awaitingSeat(cur)
        if (!seat || !shouldAutoPass(cur, ctx3, seat)) break
        const e = applyEngineReq(hist(cur), ctx3, { kind: 'pass', by: seat, auto: true })
        if (!e.ok) break
        cur = e.history.present
      }
      return cur
    }
    const useAbility = (s: BoardState, ability: string): BoardState => {
      const ea = applyEngineReq(hist(s), ctx3, { kind: 'declare', req: { by: 'A', source: 'GC', ability } })
      if (!ea.ok) throw new Error(`${ability} declare failed: ${ea.reason}`)
      return settle(ea.history.present)
    }
    g = useAbility(g, 'Gen1')
    eq(g.costs.A.map((t) => t.icon), ['W', 'W'], '㉒a D21 generateCost（固定の並び）: [WW] が「その他の代償」として発生する（frameId 無し）')
    eq(g.costs.A.every((t) => t.frameId === null), true, '㉒a′ 発生したコストは frameId 無し（宣言の途中に縛られない・すぐ使える）')
    g = useAbility(g, 'Gen2')
    eq(g.costs.A.map((t) => t.icon), ['W', 'W', 'W', 'W', 'W'], '㉒b D21 generateCost（callCostOf・D22 サクリファイスと同じ形）: GC の印刷コスト[WW]＋extra[W]＝[WWW] が追加で発生する')
  }

  // D11・R4a-2 単体テスト: 効果の乗っ取り（hijack）。対象の選び直し（宣言時と違う候補を選べる）・元の使用者は使えない
  {
    // どちらの席も、頼まれた窓（pred が true を返す）に来るまで見送り続ける（それ以外の窓では反応しない）
    const passUntil = (s: BoardState, pred: (s: BoardState) => boolean): BoardState => {
      let cur = s
      for (let i = 0; i < 100 && !pred(cur); i++) {
        const seat = awaitingSeat(cur)
        if (!seat) break
        cur = drive(act3(cur, { type: 'procPass', by: seat }), ctx3).state
      }
      return cur
    }
    let m = drive(base3([card('Q', 'A', 'char', { kiryoku: 1 }), card('Y', 'A', 'char', { kiryoku: 1 }), card('Heal', 'A', 'hand'), card('Snatch', 'B', 'hand')]), ctx3).state
    const d1 = declare(m, ctx3, { by: 'A', source: 'Heal', targets: ['Q'] })
    if (!d1.ok) throw new Error(`Heal declare failed: ${d1.reason}`)
    d1.actions.forEach((a) => (m = act3(m, a)))
    m = drive(m, ctx3).state
    // メインの窓（B も見送るまで閉じない・11-2）→ Heal 本体の処理（[6]〜）→ [8]（使用するとき）を経て
    // [11]《イベントカードを使用したとき》の窓で Snatch を宣言する
    m = passUntil(m, (s) => currentWindow(s)?.frame?.kind === 'event' && currentWindow(s)?.frame?.step === 11 && awaitingSeat(s) === 'B')
    const d2 = declare(m, ctx3, { by: 'B', source: 'Snatch' })
    if (!d2.ok) throw new Error(`Snatch declare failed: ${d2.reason}`)
    d2.actions.forEach((a) => (m = act3(m, a)))
    m = drive(m, ctx3).state
    // Heal の窓の残り・Snatch 自身の宣言〜効果（[6]〜[14]）を見送りきると、hijack が choose 't' を再び宣言する
    m = passUntil(m, (s) => !!s.procMeta.choice)
    let ch = m.procMeta.choice
    // 宣言時は Q を選んでいたが、乗っ取った側（B）はここで改めて選ぶ（Q・Y どちらも候補）
    eq([ch?.by, ch?.options.map((o) => o.key).sort()], ['B', ['Q', 'Y']], '対象の選び直し: 乗っ取った側（B）が改めて対象を選ぶ（Q・Y どちらも候補）')
    m = drive(act3(m, { type: 'procChoose', id: ch!.id, pick: ['Y'] }), ctx3).state
    eq([m.cards.Y.kiryoku, m.cards.Q.kiryoku], [4, 1], '対象の選び直し: 選び直した Y が回復・宣言時に指定した Q は元の使用者が使えず変わらない')
  }

  // K6・R4a-2 単体テスト: costMod（0コスト＋追加アイコン・下限）。applyCostMod は純関数（layers.ts）
  {
    eq(applyCostMod({ icons: [], attrs: [] }, { icons: { W: 1 }, kiryoku: 0 }).icons, ['W'], 'costMod: 0コストのアイコンにアイコンを1枚足すと[W]になる')
    eq(applyCostMod({ icons: ['W'], attrs: [] }, { icons: { W: -5 }, kiryoku: 0 }).icons, [], 'costMod: アイコンは種類ごとに0未満にならない（[W]1枚から5枚引いても0枚のまま）')
    eq(applyCostMod({ icons: [], attrs: [], other: [{ kiryoku: 2 }] }, { icons: {}, kiryoku: -5 }).other, [{ kiryoku: 0 }], 'costMod: 気力コストの最終値も0未満にならない')
  }

  // D20・R4a-2 単体テスト: offer（払う／払わない）。払う→ generateCost の useAs で発生させたコストが使用者（you）のものになる。
  // 払わない→ ifDeclined の気力減少が働く
  {
    const of0 = drive(base3([card('OF', 'A', 'char', { kiryoku: 5 })]), ctx3).state
    const ofDecl = declare(of0, ctx3, { by: 'A', source: 'OF', ability: 'Ask' })
    if (!ofDecl.ok) throw new Error(`Ask declare failed: ${ofDecl.reason}`)
    const passUntilChoice = (s: BoardState): BoardState => {
      let cur = s
      for (let i = 0; i < 50 && !cur.procMeta.choice; i++) {
        const seat = awaitingSeat(cur)
        if (!seat) break
        cur = drive(act3(cur, { type: 'procPass', by: seat }), ctx3).state
      }
      return cur
    }
    let asked = of0
    ofDecl.actions.forEach((a) => (asked = act3(asked, a)))
    asked = passUntilChoice(drive(asked, ctx3).state)
    const offerCh = asked.procMeta.choice
    eq([offerCh?.by, offerCh?.kind, offerCh?.options.map((o) => o.key), offerCh?.purpose], ['B', 'use', ['pay'], 'offer'], 'offer: B（opponent）に払うかを問う（procChoice kind:use・purpose:offer で画面⑦の2ボタンに出し分け）')
    const paid = drive(act3(asked, { type: 'procChoose', id: offerCh!.id, pick: ['pay'] }), ctx3).state
    eq([paid.costs.A.map((t) => t.icon), paid.costs.B.length], [['W'], 0], 'offer 払う: generateCost の useAs どおり、発生させたコストは you（A）のものになる（B には残らない）')
    const declined = drive(act3(asked, { type: 'procChoose', id: offerCh!.id, pick: [] }), ctx3).state
    eq(declined.cards.OF.kiryoku, 3, 'offer 払わない: ifDeclined の気力－２が働く（5→3）')
  }

  // PHASE-R4b §2(D)・統括17の直し 単体テスト: payByPlayer の「発生させる」が実際に 7-2[3] の窓を開き、
  // 割込型のコスト発生アクション（RC＝臨時収入と同じ本文の最小限）を使える。生成された [WWW] のうち1枚を
  // 選んで払う（払った1枚は you（A）へ・残り2枚は発生させた B の手元に残る＝7-3・FAQ:1353 と同じ理屈）
  {
    const passUntilChoice2 = (s: BoardState): BoardState => {
      let cur = s
      for (let i = 0; i < 50 && !cur.procMeta.choice && !cur.result; i++) {
        const seat = awaitingSeat(cur)
        if (!seat) break
        cur = drive(act3(cur, { type: 'procPass', by: seat }), ctx3).state
      }
      return cur
    }
    const p0 = drive(base3([card('PBP', 'A', 'char', { kiryoku: 5 }), card('RC', 'B', 'hand')]), ctx3).state
    const askDecl = declare(p0, ctx3, { by: 'A', source: 'PBP', ability: 'Ask' })
    if (!askDecl.ok) throw new Error(`payByPlayer Ask declare failed: ${askDecl.reason}`)
    let s = p0
    askDecl.actions.forEach((a) => (s = act3(s, a)))
    s = passUntilChoice2(drive(s, ctx3).state)
    const askCh = s.procMeta.choice
    eq([askCh?.by, askCh?.purpose], ['B', 'offer'], 'payByPlayer: B に発生させるかを問う（ask 段。offer の帯を流用）')
    s = drive(act3(s, { type: 'procChoose', id: askCh!.id, pick: ['pay'] }), ctx3).state
    const srcCh = s.procMeta.choice
    eq([srcCh?.by, srcCh?.min, srcCh?.options?.map((o) => o.key)], ['B', 0, ['LB']], 'payByPlayer: 発生源の選択（候補はリーダー LB のみ。0件でも進められる＝7-2）')
    s = drive(act3(s, { type: 'procChoose', id: srcCh!.id, pick: [] }), ctx3).state
    // [3] の窓（7-2）: B だけが宣言できる。ここで RC（臨時収入相当）を使う
    const rcDecl = declare(s, ctx3, { by: 'B', source: 'RC' })
    if (!rcDecl.ok) throw new Error(`RC declare failed: ${rcDecl.reason}`)
    rcDecl.actions.forEach((a) => (s = act3(s, a)))
    s = passUntilChoice2(drive(s, ctx3).state)
    eq(s.costs.B.map((t) => t.icon).sort(), ['W', 'W', 'W'], '7-2[3] の窓で RC（臨時収入相当）を使い、[WWW] が B に発生した')
    const tokCh = s.procMeta.choice
    eq([tokCh?.by, tokCh?.min, tokCh?.max], ['B', 1, 1], '払うトークンの選択（3枚中1枚。amount ["W"]）')
    const pick = [tokCh!.options[0].key]
    s = drive(act3(s, { type: 'procChoose', id: tokCh!.id, pick }), ctx3).state
    eq([s.costs.A.map((t) => t.icon), s.costs.B.length], [['W'], 2], 'payByPlayer: 払った1枚が you（A）へ・残り2枚は B の手元（7-3・FAQ:1353 と同じ理屈）')
  }

  // D17・R4a-2 単体テスト: 効果で呼び出す（callByEffect）。《キャラクターカードが呼び出されるとき》の窓では、
  // 呼び出されるキャラはまだ場に出ていない（手札のまま）ことを確かめる
  {
    const passOne = (s: BoardState, seat: Seat): BoardState => drive(act3(s, { type: 'procPass', by: seat }), ctx3).state
    const passUntilChoice2 = (s: BoardState): BoardState => {
      let cur = s
      for (let i = 0; i < 50 && !cur.procMeta.choice; i++) {
        const seat = awaitingSeat(cur)
        if (!seat) break
        cur = passOne(cur, seat)
      }
      return cur
    }
    let c0 = drive(base3([card('Caller', 'A', 'char'), card('CallSrc', 'A', 'hand')]), ctx3).state
    const callDecl = declare(c0, ctx3, { by: 'A', source: 'Caller', ability: 'DoCall' })
    if (!callDecl.ok) throw new Error(`DoCall declare failed: ${callDecl.reason}`)
    let cc = c0
    callDecl.actions.forEach((a) => (cc = act3(cc, a)))
    cc = passUntilChoice2(drive(cc, ctx3).state)
    // choose 'w' の候補は CallSrc だけ（自動で答える）
    const chW = cc.procMeta.choice
    if (!chW) throw new Error('choose w が来ない')
    cc = drive(act3(cc, { type: 'procChoose', id: chW.id, pick: ['CallSrc'] }), ctx3).state
    // ここが summon フレームの [1]《キャラクターカードが呼び出されるとき》の窓（両者見送るまで開いている）
    eq([topFrame(cc)?.kind, topFrame(cc)?.step, cc.cards.CallSrc.zone], ['summon', 1, 'hand'], 'D17: 呼び出されるときの窓では、呼び出されるキャラはまだ場に出ていない（手札のまま）')
    for (let i = 0; i < 10 && cc.cards.CallSrc.zone === 'hand'; i++) {
      const seat = awaitingSeat(cc)
      if (!seat) break
      cc = passOne(cc, seat)
    }
    eq([cc.cards.CallSrc.zone, cc.cards.CallSrc.orientation], ['char', 'ready'], 'D17: 窓が閉じると場に出る（指定の向き＝ready）')
  }

  // D17・R4a-2 単体テスト: 妨害工作と同じ形（割込型「キャラクターカードが呼び出されるとき」）で、呼び出されるキャラをゴミ箱送りにできる
  {
    const passUntilChoice3 = (s: BoardState): BoardState => {
      let cur = s
      for (let i = 0; i < 50 && !cur.procMeta.choice; i++) {
        const seat = awaitingSeat(cur)
        if (!seat) break
        cur = drive(act3(cur, { type: 'procPass', by: seat }), ctx3).state
      }
      return cur
    }
    let s0 = drive(base3([card('Caller', 'A', 'char'), card('CallSrc', 'A', 'hand'), card('Sabo', 'B', 'hand')]), ctx3).state
    const callDecl = declare(s0, ctx3, { by: 'A', source: 'Caller', ability: 'DoCall' })
    if (!callDecl.ok) throw new Error(`DoCall declare failed: ${callDecl.reason}`)
    let ss = s0
    callDecl.actions.forEach((a) => (ss = act3(ss, a)))
    ss = passUntilChoice3(drive(ss, ctx3).state)
    const chW2 = ss.procMeta.choice
    if (!chW2) throw new Error('choose w が来ない')
    ss = drive(act3(ss, { type: 'procChoose', id: chW2.id, pick: ['CallSrc'] }), ctx3).state
    // 窓は AP（A）の番から。B が割り込むには A がまず見送る（11-2）
    if (awaitingSeat(ss) === 'A') ss = drive(act3(ss, { type: 'procPass', by: 'A' }), ctx3).state
    const saboDecl = declare(ss, ctx3, { by: 'B', source: 'Sabo' })
    if (!saboDecl.ok) throw new Error(`Sabo declare failed: ${saboDecl.reason}`)
    saboDecl.actions.forEach((a) => (ss = act3(ss, a)))
    ss = drive(ss, ctx3).state
    for (let i = 0; i < 10 && ss.cards.CallSrc.zone === 'hand'; i++) {
      const seat = awaitingSeat(ss)
      if (!seat) break
      ss = drive(act3(ss, { type: 'procPass', by: seat }), ctx3).state
    }
    eq(ss.cards.CallSrc.zone, 'trash', '妨害工作: 呼び出されるとき（まだ場に出ていない）にゴミ箱送りにできる')
  }

  // D2（12-2 但し書き oldrule.txt:509-510）: バトルカードは、バトルが行われている限りカードの有無は問われず、バトルが行われている間有効
  {
    let d = base3([card('BCX', 'A', 'trash')])
    eq(staticSourceActive(d, 'BCX'), false, 'D2a: バトルが無ければ trash のバトルカードの常時効果は無効（通常の12-2どおり）')
    d = startBattleAt(d, { challenger: 'A', at: 19, battleCard: 'BCX' })
    eq(staticSourceActive(d, 'BCX'), true, 'D2b: そのバトルカードで種目を選んだバトルが進行中なら trash（使用済み）でも有効（12-2 但し書き）')
  }

  // ⑰ K4: 対象にならない（空打ち）・禁止は警告だけ（止めない）。自動見送りは違反のある宣言を数えない
  let k = drive(base3([card('P', 'A', 'char'), card('Y', 'B', 'char'), card('Circ', 'B', 'char', { attachedTo: 'Y', kiryoku: null, index: 100 })]), ctx3).state
  const zap = declare(k, ctx3, { by: 'A', source: 'P', ability: 'Zap', targets: ['Y'] })
  eq([zap.ok, zap.ok && zap.violations.map((v) => v.kind)], [true, ['untargetable']], '⑰a 対象にならないキャラを対象に宣言＝空打ちの警告（宣言そのものは通る）')
  eq([legalDeclarations(k, ctx3, 'A').some((d) => d.req.ability === 'Zap'), legalDeclarations(k, ctx3, 'A', { withWarned: true }).find((d) => d.req.ability === 'Zap')?.violations?.length], [false, 1], '⑰b 自動見送りの「宣言できるもの」に数えない（画面のボタンには警告つきで出す）')
  const ok = applyEngineReq(hist(k), ctx3, { kind: 'declare', req: { by: 'A', source: 'P', ability: 'Zap', targets: ['Y'] } })
  eq([ok.ok, ok.ok && ok.warnings.some((w) => w.startsWith('警告（K4）')), ok.ok && ok.trace.some((t) => t.kind === 'warn')], [true, true, true], '⑰c 確認のうえ送られた宣言は通す（警告はログに残す）')
  k = drive(base3([card('Hit', 'A', 'hand'), card('Y', 'B', 'char'), card('NoEv', 'B', 'field')]), ctx3).state
  const hit = declare(k, ctx3, { by: 'A', source: 'Hit', targets: ['Y'] })
  // 「宣言できるもの」に数えない＝legalDeclarations（withWarned なし）に出ない。shouldAutoPass 自体は R3⑤ で自分のメインフェイズは常に false（別に検証済み・③）
  eq([hit.ok, hit.ok && hit.violations.map((v) => v.kind), legalDeclarations(k, ctx3, 'A').filter((d) => !d.req.costGen).length], [true, ['prohibit'], 0], '⑰d 「〜できない」（prohibit）も警告・自動見送りでは宣言できないものとして数える')
  eq(shouldAutoPass(k, ctx3, 'A'), false, '⑰d′ 自分のメインフェイズなので shouldAutoPass 自体は R3⑤ により常に false')

  // D9・enforce.ts（R4a §3-6）: tested のカードの禁止（K4）は declare を断る（ok:false）。draft のカードは今までどおり警告
  const kT = drive(base3([card('Hit', 'A', 'hand'), card('Y', 'B', 'char'), card('NoEvT', 'B', 'field')]), ctx3).state
  const hitT = declare(kT, ctx3, { by: 'A', source: 'Hit', targets: ['Y'] })
  eq([hitT.ok, !hitT.ok && !!hitT.blocked?.length], [false, true], '⑳a ENFORCE既定 tested: tested のカード（NoEvT）の禁止は declare を断る（ok:false・根拠つき）')
  // 画面⑥（R2u・PHASE-R4b §2(C)）: tested で blocked になる宣言は、withWarned のときだけ理由つきで出る（灰色ボタン）。
  // 自動見送りの「宣言できるもの」には数えない（withWarned なしでは出ない）
  const legalHitT = legalDeclarations(kT, ctx3, 'A', { withWarned: true }).find((d) => d.req.source === 'Hit')
  eq([(legalHitT?.blockedReason?.length ?? 0) > 0, legalDeclarations(kT, ctx3, 'A').some((d) => d.req.source === 'Hit')], [true, false], '⑥ tested で blocked になる宣言（例: 魔法のサークレットを付けた柏木千鶴の《鬼化》相当）は理由つきで灰色ボタンに出す・自動見送りの数には入らない')
  setEnforce('warn')
  const hitTWarn = declare(kT, ctx3, { by: 'A', source: 'Hit', targets: ['Y'] })
  eq([hitTWarn.ok, hitTWarn.ok && hitTWarn.violations.map((v) => v.kind)], [true, ['prohibit']], '⑳b ENFORCE=warn: tested のカードでも断らず警告だけ（人の手直し・フリーモード用）')
  setEnforce('tested')
  const hitAgain = declare(k, ctx3, { by: 'A', source: 'Hit', targets: ['Y'] })
  eq([hitAgain.ok, hitAgain.ok && hitAgain.violations.map((v) => v.kind)], [true, ['prohibit']], '⑳c ENFORCE既定 tested に戻しても draft のカード（NoEv）は引き続き警告のまま（断らない）')

  // ⑱ K12: 場の制限を満たせない→使用権者が1体ずつ選んでゴミ箱送り（15-2）。候補が1枚なら聞かない（17-1）
  let l = drive(base3([card('Same1', 'A', 'char'), card('Same2', 'A', 'char')]), ctx3).state
  const ch = l.procMeta.choice
  eq([ch?.purpose, ch?.by, ch?.options.map((o) => o.key)], ['limitTrash', 'A', ['Same1', 'Same2']], '⑱a 同名キャラ制限（15-2）: 違反しているキャラから使用権者が選ぶ')
  l = drive(act3(l, { type: 'procChoose', id: ch!.id, pick: ['Same2'] }), ctx3).state
  eq([l.cards.Same2.zone, l.cards.Same1.zone, l.downs.A, l.procMeta.choice], ['trash', 'char', 0, null], '⑱b 選んだキャラだけゴミ箱送り（ダウンではない）・満たしたらそれ以上は送らない')
  l = drive(base3([card('Y', 'A', 'char'), card('LOnly', 'A', 'char', { attachedTo: 'Y', kiryoku: null, index: 100 })]), ctx3).state
  eq([l.cards.LOnly.zone, l.procMeta.choice], ['trash', null], '⑱c 装備対象（17-1）を満たさないアイテムは即座にゴミ箱送り（候補1枚は聞かない）')

  // ⑲ 常時効果の層の期限と「効果が失われたとき」: 装備先が変わったら元の装備先に処理する／装備対象を満たせずに外れたときは処理しない（FAQ:550・559）
  let w = drive(base3([card('Y', 'A', 'char'), card('P', 'A', 'char', { index: 1 }), card('Denpa', 'A', 'char', { attachedTo: 'Y', kiryoku: null, index: 100 }), card('Plain', 'A', 'char', { attachedTo: 'P', kiryoku: null, index: 101 }), card('dA2', 'A', 'deck'), card('dB2', 'B', 'deck')]), ctx3).state
  eq([w.layers.bound.Denpa, w.layers.list.filter((x) => x.source === 'Denpa').map((x) => x.host)], ['Y', ['Y']], '⑲a 装備対象が1枚に決まるアイテムは最初の装備先を控える・層は装備先つき')
  w = drive(act3(w, { type: 'procAttach', moves: [{ item: 'Denpa', to: 'P' }, { item: 'Plain', to: 'Y' }] }), ctx3).state
  w = passUntil({ ...hist(w) }, (x) => x.proc.length === 0).present
  eq([w.cards.Y.zone, w.cards.Plain.zone, w.cards.Denpa.zone, w.cards.P.zone, w.downs.A], ['trash', 'trash', 'trash', 'char', 1], '⑲b 外れた瞬間に元の装備先はダウン（入れ替えたアイテムも一緒にゴミ箱）・移った先はアイテムだけゴミ箱送り')

  // PHASE-R4b0 追加: conditional（宣言を通らない Auto。光岡悟「短命」・佐藤雅史「消極的」と同じ形）も、暗黙の対象が
  // サークレットで外れたら効果を及ぼさない（oldrule 1178・FAQ:697・3573）。処理の時点で外す＝宣言を断るのではない
  const finishTurnEnd = (s: BoardState): BoardState => {
    let cur = drive(act3(s, { type: 'procPhase', to: 'ターン終了' }), ctx3).state
    for (let i = 0; i < 100 && cur.proc.length && !cur.procMeta.choice; i++) {
      const seat = awaitingSeat(cur)
      if (!seat) break
      cur = drive(act3(cur, { type: 'procPass', by: seat }), ctx3).state
    }
    return cur
  }
  // 強制（短命と同じ形）: サークレット装備なら気力－1が起きない
  const mw = finishTurnEnd(drive(base3([card('Weak', 'A', 'char', { kiryoku: 5 }), card('Circ', 'A', 'char', { attachedTo: 'Weak', kiryoku: null, index: 100 })]), ctx3).state)
  eq(mw.cards.Weak.kiryoku, 5, 'R4b0: conditional（強制・短命と同じ形）もサークレット装備なら暗黙の対象が外れ、気力－1が起きない')
  // サークレットを装備していなければ今までどおり気力－1（回帰なし）
  const mw2 = finishTurnEnd(drive(base3([card('Weak', 'A', 'char', { kiryoku: 5 })]), ctx3).state)
  eq(mw2.cards.Weak.kiryoku, 4, 'R4b0: サークレットを装備していなければ今までどおり気力－1が起きる（回帰なし）')
  // できる（消極的と同じ形）: サークレット装備なら暗黙の対象が外れて項目ごと読み飛ばし＝「使うか」の問いも出ない
  const mo = finishTurnEnd(drive(base3([card('WeakOpt', 'A', 'char', { kiryoku: 3 }), card('Circ', 'A', 'char', { attachedTo: 'WeakOpt', kiryoku: null, index: 100 })]), ctx3).state)
  eq([mo.procMeta.choice, mo.cards.WeakOpt.kiryoku], [null, 3], 'R4b0: conditional（できる・消極的と同じ形）もサークレット装備なら読み飛ばし・「使うか」を問わず気力は変わらない')
  // サークレットを装備していなければ今までどおり「使うか」を問い、使うを選べば+1（回帰なし）
  const mo2pre = finishTurnEnd(drive(base3([card('WeakOpt', 'A', 'char', { kiryoku: 3 })]), ctx3).state)
  const useCh = mo2pre.procMeta.choice
  eq([useCh?.kind, useCh?.by], ['use', 'A'], 'R4b0: サークレットを装備していなければ今までどおり「使うか」を問う（回帰なし）')
  const mo2 = drive(act3(mo2pre, { type: 'procChoose', id: useCh!.id, pick: ['use'] }), ctx3).state
  eq(mo2.cards.WeakOpt.kiryoku, 4, 'R4b0: 使うを選べば気力+1（回帰なし）')
}

// H-9c battleUser: 層を作る時点（バトル進行中）で席を確定する。統括16「battleUser の解決は不具合」（HANDOFF-R4b.md §7・R4b-1 続き）
// B が置いた鬼ごっこ系のバトルカードを A が挑んだバトルの種目に選ぶ（addContinuous の env.you = B・nearestBattle().challenger = A）。
// バトル終了後（nearestBattle が無くなった後）も、ターン終了時まで宣言できないのは「挑んだ側」A（本文「このバトルを使用したプレイヤー」H-9c 仮の既定）。
// 置いた側 B はバトルを使用していないので禁止されない。
{
  let s = startBattleAt(board([]), { challenger: 'A', at: 19, battleCard: 'Oni' })
  const env = { self: 'Oni', you: 'B' as Seat, slots: {}, trigger: null, declId: null, declared: {} }
  const seed = continuousSeed(ctxAll, s, env, { ce: 'prohibit', action: { kinds: ['バトル'], by: 'battleUser' } }, 'turn', '鬼ごっこ効果', 'ability')
  let after = applyAction(s, { type: 'procLayers', add: [seed] }).state
  after = { ...after, proc: after.proc.map((f) => (f.kind === 'battle' ? { ...f, status: 'done' } : f)) } // バトル終了＝nearestBattle が無くなる
  const declBy = (by: Seat): ProcDecl => ({ id: 'x', by, kind: 'battle', actionType: '通常型', label: '', sourceIid: null, targets: [], costGens: [], sources: [], trigger: null, usageKey: null, eng: {} })
  eq(violations(ctxAll, after, declBy('A')).map((v) => v.kind), ['prohibit'], 'battleUser①: 挑んだ側（A）はバトル終了後もターン終了時まで宣言できない（層を作った時点で席を確定・H-9c）')
  eq(violations(ctxAll, after, declBy('B')).map((v) => v.kind), [], 'battleUser②: 置いた側（B）は禁止されない（このバトルを使用したのは挑んだ側 A）')
}

// くすぐりマシーン（b_くすぐりマシ-ン・R4b-2a）: 本文「攻:根 防:残り気力」・関係 FAQ 0件のため、本文どおりの1件のみ
// （FAQ 由来ではない。実カードの記述 _local/rules/cards/b_くすぐりマシ-ン.ts を実際にインポートし、drive() を通して
// 実際の evalBattleExpr（{attr:'根'}・{kiryoku:true}）で結果ダメージが出ることを確かめる）
{
  const kInfo = (id: string, kiryoku: number, kon: number): CardInfo => ({ id, name: id, kind: 'c', kiryoku, stats: { 根: kon }, cost: '', attr: '根', abilities: [] })
  const kInfos: CardInfo[] = [kInfo('KA', 5, 8), kInfo('KB', 5, 2), { id: 'KC', name: 'KC', kind: 'b', kiryoku: null, stats: null, cost: '', attr: '', abilities: [] }]
  const kCtx = { cards: Object.fromEntries(kInfos.map((c) => [c.id, c])), defs: { KC: kusuguriDef } }
  const kBoard: BoardState = { ...EMPTY_BOARD, cards: { KA: card('KA', 'A', 'char', { kiryoku: 5 }), KB: card('KB', 'B', 'char', { kiryoku: 5 }), KC: card('KC', 'A', 'battle') }, turn: { active: 'A', phase: 'メイン' } }
  let ks = startBattleAt(kBoard, { challenger: 'A', at: 19, participants: { A: ['KA'], B: ['KB'] }, battleCard: 'KC' })
  ks = drive(ks, kCtx).state
  for (let i = 0; i < 30 && !ks.result && ks.proc.length; i++) {
    if (ks.procMeta.choice) {
      // 20-4[21]「手順[19]に戻るか」の問い。次に進む
      const ch = ks.procMeta.choice
      const pick = ch.options.some((o) => o.key === 'next') ? ['next'] : [ch.options[0].key]
      ks = drive(applyAction(ks, { type: 'procChoose', id: ch.id, pick }).state, kCtx).state
      continue
    }
    const seat = awaitingSeat(ks)
    if (!seat) break
    ks = drive(applyAction(ks, { type: 'procPass', by: seat }).state, kCtx).state
  }
  // KA: 攻=根(8)・防=残り気力(5)／KB: 攻=根(2)・防=残り気力(5)。結果ダメージ（20-10）: KB←KAの攻8-KBの防5=3（気力5→2）／KA←KBの攻2-KAの防5=負→0（気力5のまま）
  eq([ks.cards.KA.kiryoku, ks.cards.KB.kiryoku], [5, 2], 'くすぐりマシーン: 攻=根・防=残り気力（本文どおり。FAQ無し）。KAの攻8-KBの防(残り気力)5=3ダメージ・KBの攻2-KAの防(残り気力)5は負でダメージ無し')
}

// ミスター・コンテスト（b_ミスタ-コンテスト・R4b-2b）: 本文「攻:全能力合計値 防:全能力合計値」・関係 FAQ 0件のため、
// 本文どおりの1件のみ（FAQ 由来ではない。実カードの記述 _local/rules/cards/b_ミスタ-コンテスト.ts を実際にインポートし、
// drive() を通して実際の evalBattleExpr（sum:[attr,attr,attr,attr,attr]）で全能力合計値どおりの結果ダメージが出ることを確かめる）
{
  const mInfo = (id: string, kiryoku: number, stats: Record<string, number>): CardInfo => ({ id, name: id, kind: 'c', kiryoku, stats: stats as CardInfo['stats'], cost: '', attr: '', abilities: [] })
  const mInfos: CardInfo[] = [
    mInfo('MA', 6, { 力: 1, 早: 1, 賢: 1, 根: 1, 感: 1 }),
    mInfo('MB', 6, { 力: 0, 早: 1, 賢: 1, 根: 1, 感: 1 }),
    { id: 'MC', name: 'MC', kind: 'b', kiryoku: null, stats: null, cost: '', attr: '', abilities: [] },
  ]
  const mCtx = { cards: Object.fromEntries(mInfos.map((c) => [c.id, c])), defs: { MC: misterDef } }
  const mBoard: BoardState = { ...EMPTY_BOARD, cards: { MA: card('MA', 'A', 'char', { kiryoku: 6 }), MB: card('MB', 'B', 'char', { kiryoku: 6 }), MC: card('MC', 'A', 'battle') }, turn: { active: 'A', phase: 'メイン' } }
  let ms = startBattleAt(mBoard, { challenger: 'A', at: 19, participants: { A: ['MA'], B: ['MB'] }, battleCard: 'MC' })
  ms = drive(ms, mCtx).state
  for (let i = 0; i < 30 && !ms.result && ms.proc.length; i++) {
    if (ms.procMeta.choice) {
      const ch = ms.procMeta.choice
      const pick = ch.options.some((o) => o.key === 'next') ? ['next'] : [ch.options[0].key]
      ms = drive(applyAction(ms, { type: 'procChoose', id: ch.id, pick }).state, mCtx).state
      continue
    }
    const seat = awaitingSeat(ms)
    if (!seat) break
    ms = drive(applyAction(ms, { type: 'procPass', by: seat }).state, mCtx).state
  }
  // MA: 攻防=全能力合計値=5（力1+早1+賢1+根1+感1）／MB: 攻防=全能力合計値=4（力0+早1+賢1+根1+感1）。
  // 結果ダメージ（20-10）: MB←MAの攻5-MBの防4=1（気力6→5）／MA←MBの攻4-MAの防5=負→0（気力6のまま）
  eq([ms.cards.MA.kiryoku, ms.cards.MB.kiryoku], [6, 5], 'ミスター・コンテスト: 攻防=全能力合計値（本文どおり。FAQ無し）。MAの攻5-MBの防4=1ダメージ・MBの攻4-MAの防5は負でダメージ無し')
}

if (failures) {
  console.error(`\n${failures} 件失敗`)
  process.exit(1)
}
console.log('\nengine-host: すべて成功')
