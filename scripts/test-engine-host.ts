// つなぐ層（src/ui/engine/host.ts）のテスト — PHASE-R2u §3-5
// 期待の出所（原典 _local/oldrule.txt の段番号・FAQ の行）は各項目の頭に書く。今の実装の出力を写さない。
//   11-2（宣言の機会は AP→NAP の順に1人ずつ・見送り）・10-2-2（フェイズ終了の宣言と承認 367-369）・10-2-3（フェイズの順 370-375）・
//   10-2-4（先攻1ターン目 376-379）・10-4[4]（ドロー 389）・10-6（終了フェイズ [1]〜[3]・10-6-1 417-429）・10-7・10-8（436-441）・
//   15-10-1（呼び出し 680-706）・16-1（イベント 816-844）・15-4-2（ダメージ 612-632）・15-5-1（ダウン 633-649）・9-2（ダウン数）・
//   FAQ:2959-2960（宣言時に指定した支払い方法以外では払えない）・PHASE-R2u §1（ホストが正・1要求＝Undo 1回）・§2-2（自動見送り）

import { EMPTY_BOARD, fillBoardDefaults, type BoardState, type CardInstance, type Seat } from '../src/core/board'
import { emptyHistory, undo, type History } from '../src/core/history'
import { PHASE_ACTIONS, activeSeat, awaitingSeat, currentWindow, phaseEndPending, topFrame } from '../src/core/proc'
import type { CardInfo } from '../src/engine/ctx'
import { drive } from '../src/engine/drive'
import type { CardDef } from '../src/engine/dsl'
import { applyEngineReq, buildEngineCtx, legalDeclarations, paymentNeed, shouldAutoPass, type EngineReq } from '../src/ui/engine/host'

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
eq(shouldAutoPass(s0, ctx, 'A'), true, '③ 宣言できるものが無い A は自動見送り（§2-2）')
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
  let h = hist(drive({ ...start, turn: { active: 'A', phase: 'メイン', n: 2 } }, ctxAll).state)
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
  const withCosts = (attrs: string[][]): BoardState => ({ ...base, turn: { active: 'A', phase: 'メイン', n: 2 }, costs: { A: attrs.map((a, i) => ({ id: `k${i + 1}`, icon: 'W' as const, attrs: a, frameId: null })), B: [] } })
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

if (failures) {
  console.error(`\n${failures} 件失敗`)
  process.exit(1)
}
console.log('\nengine-host: すべて成功')
