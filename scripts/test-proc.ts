// core の処理手順（src/core/proc.ts）の単体テスト — PHASE-R2a §3-5
// 期待値は原典 _local/oldrule.txt の文から作る（各テストの頭に段番号と逐語を引く）。エンジン（カードの記述）は使わない:
// エンジンが返す操作（procTimingDone・procPay・procCheck・procEffect）はこのファイルの小さな代役が返す。

import { applyAction, type BoardAction } from '../src/core/actions'
import { EMPTY_BOARD, fillBoardDefaults, type BoardState, type CardInstance, type Seat } from '../src/core/board'
import { awaitingSeat, currentWindow, topFrame, type ProcDecl, type ProcTrace } from '../src/core/proc'
import { assignments, matchTokens, parseCostText, payNow } from '../src/engine/cost'
import type { EngineCtx } from '../src/engine/ctx'

let failures = 0
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`❌ ${msg}\n   実際: ${a}\n   期待: ${e}`)
  } else console.log(`✅ ${msg}`)
}

// ── 盤面の小道具
function card(iid: string, owner: Seat, zone: CardInstance['zone'], extra: Partial<CardInstance> = {}): CardInstance {
  return { iid, cardId: iid, owner, zone, index: 0, orientation: 'ready', faceUp: zone !== 'deck', kiryoku: zone === 'char' || zone === 'leader' ? 5 : null, attachedTo: null, ...extra }
}
function board(cards: CardInstance[], extra: Partial<BoardState> = {}): BoardState {
  const map: Record<string, CardInstance> = {}
  const idx: Record<string, number> = {}
  for (const c of cards) {
    const k = `${c.owner}:${c.zone}`
    map[c.iid] = { ...c, index: idx[k] ?? 0 }
    idx[k] = (idx[k] ?? 0) + 1
  }
  return { ...EMPTY_BOARD, cards: map, turn: { active: 'A', phase: 'メイン' }, ...extra }
}
function deck(owner: Seat, n: number): CardInstance[] {
  return Array.from({ length: n }, (_, i) => card(`deck${owner}${i}`, owner, 'deck'))
}

interface Sim {
  s: BoardState
  trace: ProcTrace[]
  stops: string[]
}
function act(sim: Sim, a: BoardAction) {
  const r = applyAction(sim.s, a)
  sim.s = r.state
  if (r.trace) sim.trace.push(...r.trace)
}
/** 今どこで止まっているか（記録用の短い名前） */
function where(s: BoardState): string {
  if (s.result) return 'result'
  if (s.procMeta.choice) return `choice:${s.procMeta.choice.kind}`
  const top = topFrame(s)
  if (!top) return s.procMeta.base ? 'base' : 'idle'
  if (top.status === 'window') return `${top.kind}[${top.step}]窓:${awaitingSeat(s)}`
  if (top.status === 'engine') return `${top.kind}[${top.step}]${top.engineWhat}`
  return `${top.kind}[${top.step}]${top.status}`
}
/** エンジンの代役: 窓は両者見送り、エンジンの段は「何もない・払えた・確かめた」で返す。止まった点を記録する */
function runAll(sim: Sim, opts: { onEngine?: (sim: Sim) => boolean } = {}) {
  for (let g = 0; g < 500; g++) {
    const w = where(sim.s)
    if (w === 'result' || w === 'idle' || w === 'base') return
    sim.stops.push(w)
    const top = topFrame(sim.s)!
    if (sim.s.procMeta.choice) {
      act(sim, { type: 'procChoose', id: sim.s.procMeta.choice.id, pick: [] })
      continue
    }
    if (top.status === 'window') {
      act(sim, { type: 'procPass', by: awaitingSeat(sim.s)! })
      continue
    }
    if (top.status === 'engine') {
      if (opts.onEngine && opts.onEngine(sim)) continue
      switch (top.engineWhat) {
        case 'timing':
          act(sim, { type: 'procTimingDone', frameId: top.id, items: [] })
          break
        case 'pay':
          act(sim, { type: 'procPay', frameId: top.id, ok: true, consume: [], kiryoku: [], trash: [], down: [] })
          break
        case 'check':
          act(sim, { type: 'procCheck', frameId: top.id, ok: true })
          break
        case 'effect':
          act(sim, { type: 'procEffect', frameId: top.id, items: [] })
          break
        case 'item':
          act(sim, { type: 'procItemDone', frameId: top.id })
          break
      }
      continue
    }
    return
  }
}
function decl(id: string, by: Seat, kind: ProcDecl['kind'], sourceIid: string, extra: Partial<ProcDecl> = {}): ProcDecl {
  return { id, by, kind, actionType: '通常型', label: id, sourceIid, targets: [], costGens: [], sources: [], trigger: null, usageKey: null, eng: {}, ...extra }
}

// =============================================================================
// 1. 15-13-1 特殊能力の使用（oldrule.txt:766-793）: 処理[6]〜[14] の段の順と止まる点
//    「[8] 《特殊能力を使用するとき》のタイミングでの処理、アクション宣言の機会。[9] …使用代償を支払う。
//     [10] 構成要素が満たされていない場合…中断する。[11] 《特殊能力を使用したとき》…[12] …[13] …効果が発生する。
//     《～の効果が発生したとき》のタイミングでの処理、アクション宣言の機会。[14] 発生した効果が処理される。」
// =============================================================================
{
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('b1', 'B', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  eq(where(sim.s), 'base', '1a: メインフェイズの窓が開く（手順の外）')
  eq(awaitingSeat(sim.s), 'A', '1b: 11-2[1] アクティブプレイヤーがアクション宣言をする機会')
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('X', 'A', 'ability', 'a1') })
  eq(awaitingSeat(sim.s), 'B', '1c: 11-2[2] ノンアクティブプレイヤーの機会')
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq(
    sim.stops,
    [
      'ability[8]窓:A', 'ability[8]窓:B', 'ability[8]timing',
      'ability[9]pay', 'ability[10]check',
      'ability[11]窓:A', 'ability[11]窓:B', 'ability[11]timing',
      'ability[12]check',
      'ability[13]窓:A', 'ability[13]窓:B', 'ability[13]timing',
      'ability[14]effect',
    ],
    '1d: 処理は [8]窓→[9]支払い→[10]確かめ→[11]窓→[12]確かめ→[13]窓→[14]効果 の順に止まる',
  )
  eq(sim.trace.filter((t) => t.kind === 'name').map((t) => t.text), ['支払い:X', 'X'], '1e: [9] 支払い、[13] で効果が発生（名前を記録）')
  eq(sim.s.proc.length, 0, '1f: 手順が終わるとスタックは空')
}

// =============================================================================
// 2. 16-1 イベントカードの使用（oldrule.txt:816-844）
//    「[3] 使用するイベントカードを１枚提示する。提示したイベントカードはこの時点で使用したと見なされる。」
//    「[6] 手順[3]で提示したイベントカードを再提示する。その後そのカードをごみ箱送りにする。」
// =============================================================================
{
  const sim: Sim = { s: board([card('ev', 'A', 'hand')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('E', 'A', 'event', 'ev') })
  eq(sim.s.cards.ev.zone, 'pending', '2a: 宣言[3] 提示したイベントは手札から提示エリアへ')
  act(sim, { type: 'procPass', by: 'B' })
  eq(sim.s.cards.ev.zone, 'trash', '2b: 処理[6] 再提示の後ゴミ箱送り（[8] の窓より前）')
  eq(where(sim.s), 'event[8]窓:A', '2c: [8]《イベントカードを使用するとき》の窓で止まる')
  // 打ち消されても手順どおりゴミ箱（H-8）・効果は発生しない
  act(sim, { type: 'procCounter', frameId: 'E' })
  runAll(sim)
  eq(sim.stops.includes('event[14]effect'), false, '2d: 打ち消された効果は [13] で終わり、[14] の効果の処理に進まない（H-8）')
  eq(sim.s.cards.ev.zone, 'trash', '2e: 打ち消されたイベントもゴミ箱（H-8・rule:834）')
}

// =============================================================================
// 3. 11-2 アクションの処理（oldrule.txt:468-481）
//    「[3] 同時アクション宣言をする機会（※[1]もしくは[2]においてアクションの宣言が行われている場合のみ）
//     [4] アクティブプレイヤーのアクションの処理を行う。[5] ノンアクティブプレイヤーのアクションの処理を行う。」
//    11-2-2「お互いアクション宣言を行っている場合、アクションの処理はアクティブプレイヤーから処理されます。」
// =============================================================================
{
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('b1', 'B', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procPass', by: 'A' })
  act(sim, { type: 'procDeclare', by: 'B', decl: decl('NAPの行動', 'B', 'ability', 'b1') })
  eq(awaitingSeat(sim.s), 'A', '3a: AP が[1]で見送り NAP が[2]で宣言したら、AP に[3]同時アクションの機会')
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('APの行動', 'A', 'ability', 'a1') })
  runAll(sim)
  eq(sim.trace.filter((t) => t.kind === 'name' && !t.text.startsWith('支払い')).map((t) => t.text), ['APの行動', 'NAPの行動'], '3b: AP 優先処理（後から宣言した AP の行動が先に処理される）')
}
{
  const sim: Sim = { s: board([card('a1', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procPass', by: 'A' })
  act(sim, { type: 'procPass', by: 'B' })
  eq([sim.s.procMeta.base, sim.s.procMeta.mainClosed], [null, true], '3c: 両者が宣言せずに見送ったら窓は閉じる（13-3-1: 同じ確認が2度来たら進める）')
}

// =============================================================================
// 4. 7-2 コスト発生（oldrule.txt:246-264）
//    「[3] 《コストを発生するとき》のタイミングでの処理、アクション宣言の機会。
//     ※この《コストを発生するとき》に行うアクションは、この『コストを発生させるアクション』を行ったプレイヤーのみ可能」
//    「[4] 手順[2]で提示したフィールドのキャラを再提示する。再提示できた場合、そのキャラを消耗させる。」「[9] プレイヤーは発生したコストを得る。」
//    7-3「発生したコストの種類は、割り込み型アクションを行ったアクション内に限り有効です。…ターン終了時までその他のコストとして扱われます。」
// =============================================================================
{
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('a2', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  const cg: ProcDecl = decl('C', 'A', 'costGen', 'a2', { sources: [{ iid: 'a2', from: 'field', icon: 'G', attrs: ['賢'] }] })
  act(sim, { type: 'procDeclare', by: 'A', decl: cg })
  act(sim, { type: 'procPass', by: 'B' })
  eq(where(sim.s), 'costGen[3]窓:A', '4a: [3]《コストを発生するとき》の窓')
  eq(currentWindow(sim.s)?.window.only, 'A', '4b: その窓はコストを発生させたプレイヤーだけ（7-2[3]）')
  act(sim, { type: 'procPass', by: 'A' })
  eq(where(sim.s), 'costGen[3]timing', '4c: 相手の番は無く、そのまま《〜とき》の処理へ')
  runAll(sim)
  eq(sim.s.cards.a2.orientation, 'rested', '4d: [4] 発生源のキャラを消耗させる')
  eq(sim.s.costs.A.map((t) => [t.icon, t.attrs]), [['G', ['賢']]], '4e: [9] 発生したコストを得る（種類 G・属性 賢）')
  eq(sim.stops.filter((x) => x.startsWith('costGen[7]')), ['costGen[7]timing'], '4f: [7]《コストを発生する場合》は処理だけ（窓は無い）')
}
{
  // 特殊能力の[4]で宣言したコスト発生は[7]で処理し、その種類はその特殊能力の中だけ（終わればその他のコスト W）
  const sim: Sim = { s: board([card('a1', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('X', 'A', 'ability', 'a1', { costGens: [[{ iid: 'a1', from: 'field', icon: 'R', attrs: ['力'] }]] }) })
  act(sim, { type: 'procPass', by: 'B' })
  let seenR = false
  runAll(sim, {
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (top.kind === 'ability' && top.engineWhat === 'pay') seenR = s.s.costs.A.some((t) => t.icon === 'R' && t.frameId === 'X')
      return false
    },
  })
  eq(seenR, true, '4g: 15-13-1[7] で発生した R は、その特殊能力の[9]では R（自分消耗コスト）として有効')
  eq(sim.s.costs.A.map((t) => [t.icon, t.frameId]), [['W', null]], '4h: 7-3 その特殊能力が終わったら、払わなかったコストはその他のコスト（W）')
}

// =============================================================================
// 5. 15-4-2 ダメージ処理手順（oldrule.txt:621-632）
//    「ダメージの値が０以下の場合、ダメージは発生したとは見なされずに気力の増減は行われません。」
//    「[1]《ダメージが発生するとき》… [2] ダメージが発生する。[3]《ダメージが発生したとき》… [4]《与えるとき》《受けるとき》…
//     [5]《与えたとき》《受けたとき》… [6] ダメージの値分、気力を減らす。」
// =============================================================================
{
  const sim: Sim = { s: board([card('b1', 'B', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 0, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  runAll(sim)
  eq([sim.stops, sim.s.cards.b1.kiryoku], [[], 5], '5a: 0点のダメージは発生しない（《ダメージが発生したとき》も来ない FAQ:905）')
}
{
  const sim: Sim = { s: board([card('b1', 'B', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 2, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  runAll(sim)
  eq(
    sim.stops.filter((x) => x.includes('timing')),
    ['damage[1]timing', 'damage[3]timing', 'damage[4]timing', 'damage[5]timing'],
    '5b: [1][3][4][5] の順に《〜とき》（窓の後に処理条件がある常時効果）',
  )
  eq(sim.s.cards.b1.kiryoku, 3, '5c: [6] ダメージの値分、気力を減らす')
}
{
  // [4] の窓で値が0になったら、以後の段は無く気力は減らない（「ダメージの値が０以下の場合…」）
  const sim: Sim = { s: board([card('b1', 'B', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 1, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  runAll(sim, {
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (top.kind === 'damage' && top.step === 4 && top.engineWhat === 'timing' && top.damage!.value > 0) {
        act(s, { type: 'procDamageEdit', frameId: top.id, delta: -1 })
        return true
      }
      return false
    },
  })
  eq([sim.stops.includes('damage[5]timing'), sim.s.cards.b1.kiryoku], [false, 5], '5d: 途中で0点になったダメージは以後の段が無く、気力は減らない')
}
{
  // 受け手が差し替わったら、差し替え後の受け手で同じ段を探し直す（FAQ:505-506・【決めたこと】[4][5] とも）
  const sim: Sim = { s: board([card('b1', 'B', 'char'), card('b2', 'B', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 1, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  let once = false
  runAll(sim, {
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (!once && top.kind === 'damage' && top.step === 5 && top.engineWhat === 'timing') {
        once = true
        act(s, { type: 'procDamageEdit', frameId: top.id, recipient: 'b2' })
        return true
      }
      return false
    },
  })
  eq(sim.stops.filter((x) => x === 'damage[5]timing').length, 2, '5e: [5] で受け手が差し替わると [5] をもう一度行う')
  eq([sim.s.cards.b1.kiryoku, sim.s.cards.b2.kiryoku], [5, 4], '5f: 差し替え後の受け手の気力が減る')
}

// =============================================================================
// 6. 15-5 ダウン（oldrule.txt:633-649）
//    「キャラの気力が１以上から０以下になった場合、そのキャラはダウンしたものとなり、ダウン処理が発生します。」
//    「[2]《ダウンするとき》… [3] ダウンしたキャラの使用者のダウン数に＋１する。[4]《ダウンしたとき》… [5] …相手プレイヤーは、
//     ボーナスドローとして自分のデッキから１枚ドローする。[6] ダウンしたキャラ、装備していたアイテムをゴミ箱送りにする。[7] ゲーム終了条件の判定をする。」
// =============================================================================
{
  const sim: Sim = { s: board([card('b1', 'B', 'char', { kiryoku: 0 })]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 2, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  runAll(sim)
  eq([sim.s.cards.b1.kiryoku, sim.s.cards.b1.zone, sim.s.downs.B], [-2, 'char', 0], '6a: 気力0のキャラがさらにダメージ→気力は減るがダウンは起きない（FAQ:1806）')
}
{
  const sim: Sim = { s: board([card('b1', 'B', 'char', { kiryoku: 1 }), card('item', 'B', 'char', { attachedTo: 'b1', kiryoku: null }), ...deck('A', 3)]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 1, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  let downsAt4: number | null = null
  runAll(sim, {
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (top.kind === 'down' && top.step === 4) downsAt4 = s.s.downs.B
      return false
    },
  })
  eq(sim.stops.filter((x) => x.startsWith('down') && x.includes('timing')), ['down[2]timing', 'down[4]timing'], '6b: [2]《ダウンするとき》・[4]《ダウンしたとき》で止まる')
  eq(downsAt4, 0, '6c: [3] で加えたダウン数は、そのダウン処理が終わる（[6]）まで確定しない（H-12）')
  eq(sim.trace.filter((t) => t.kind === 'name').map((t) => t.text).filter((x) => ['ダウン数+1', 'ボーナスドロー'].includes(x)), ['ダウン数+1', 'ボーナスドロー'], '6d: [3] ダウン数+1 → [5] ボーナスドロー')
  eq([sim.s.downs.B, sim.s.cards.b1.zone, sim.s.cards.item.zone, sim.s.cards.deckA0.zone], [1, 'trash', 'trash', 'hand'], '6e: [6] キャラと装備していたアイテムをゴミ箱・相手が1枚ドロー・ダウン数確定')
}
{
  // [2] でダウンしない（Ｍｙ同志・執念）→ [3] 以降は無い
  const sim: Sim = { s: board([card('b1', 'B', 'char', { kiryoku: 1 })]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 1, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  runAll(sim, {
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (top.kind === 'down' && top.step === 2 && top.engineWhat === 'timing') {
        act(s, { type: 'procCancelDown', frameId: top.id })
        act(s, { type: 'procSetKiryoku', iid: 'b1', value: 1 })
      }
      return false
    },
  })
  eq([sim.s.downs.B, sim.s.cards.b1.zone, sim.s.cards.b1.kiryoku], [0, 'char', 1], '6f: [2] でダウンしなければダウン数は増えず、キャラは残る')
}

// =============================================================================
// 7. H-12（決定）・9・15-5-2
//    9「次のいずれかを満たしたとき、即座にゲームは終了します。…キャラが５体以上ダウンする」
//    H-12「割り込みの中で起きたダウンの[7]は、その中の分だけで判定し、条件を満たしたら即座にゲーム終了（15-5-2・FAQ:1800・3511）」
// =============================================================================
{
  // お互い4体ダウン。A のキャラのダウン処理[4] の中で、B のキャラがダウン → B の負け（A の +1 は確定していない）FAQ:1800
  const sim: Sim = { s: board([card('a1', 'A', 'char', { kiryoku: 1 }), card('b1', 'B', 'char', { kiryoku: 1 }), ...deck('A', 3), ...deck('B', 3)], { downs: { A: 4, B: 4 } }), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 1, recipient: 'a1', dealerIid: null, dealerSeat: 'B' }] })
  let fired = false
  runAll(sim, {
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (!fired && top.kind === 'down' && top.step === 4 && top.engineWhat === 'timing') {
        fired = true
        act(s, { type: 'procDamage', damages: [{ value: 3, recipient: 'b1', dealerIid: 'a1', dealerSeat: 'A' }] })
        return true
      }
      return false
    },
  })
  eq([sim.s.result?.winner, sim.s.downs], ['A', { A: 4, B: 5 }], '7a: 割り込みの中のダウンの[7]は確定済み＋その分だけで判定→相手の負け（H-12）')
}
{
  // 15-5-2「同時処理内で複数のキャラのダウンが発生する場合、全てのダウン処理（手順[1]～[6]）が終わった後に…[7]をまとめて…
  //  お互いのゲーム終了条件を満たした場合は引き分け」（FAQ:1235）
  const sim: Sim = {
    s: board([card('la', 'A', 'leader', { kiryoku: 2 }), card('b1', 'B', 'char', { kiryoku: 2 }), ...deck('A', 3), ...deck('B', 3)], { downs: { A: 4, B: 4 } }),
    trace: [],
    stops: [],
  }
  act(sim, { type: 'procDamage', damages: [{ value: 2, recipient: 'la', dealerIid: null, dealerSeat: 'A' }, { value: 2, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  let resultAfterFirst: unknown = 'unset'
  runAll(sim, {
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (resultAfterFirst === 'unset' && top.kind === 'damage' && top.damage!.recipient === 'b1') resultAfterFirst = s.s.result
      return false
    },
  })
  eq(resultAfterFirst, null, '7b: 同時処理の中でリーダーがダウンしても、[7] をまとめるまで終わらない')
  eq(sim.s.result?.winner, null, '7c: お互いに終了条件（リーダーを失う・5体ダウン）→ 引き分け')
  eq(!!sim.s.result, true, '7d: 結果は出ている')
}
{
  // 9-1「リーダーキャラクターがフィールドから失われた場合、ゲームが終了します」（ダウン以外で失われたら即座 FAQ:2751・3103）
  const sim: Sim = { s: board([card('la', 'A', 'leader')]), trace: [], stops: [] }
  act(sim, { type: 'procMove', iid: 'la', to: 'deckTop' })
  eq(sim.s.result?.winner, 'B', '7e: リーダーがデッキに戻ったら即座に負け（9-1）')
}
{
  // 9-3「規定枚数のカードをデッキから引こうとしたとき、デッキの枚数が０枚のために引けなかった場合にそのプレイヤーは負け」
  const sim: Sim = { s: board([]), trace: [], stops: [] }
  act(sim, { type: 'procDraw', seat: 'A', n: 1 })
  eq(sim.s.result?.winner, 'B', '7f: デッキが0枚でドローできなければ負け（9-3）')
}

// =============================================================================
// 8. 同時処理（13-2 oldrule.txt:529-532）「『同時処理』が発生した場合、その処理の順番をアクティブプレイヤーが決定します。」
//    FAQ:1409「どちらのキャラから処理をするかはアクティブプレイヤーが決めて下さい」
// =============================================================================
{
  const sim: Sim = { s: board([card('b1', 'B', 'char'), card('b2', 'B', 'char')], { turn: { active: 'B', phase: 'メイン' } }), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 1, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }, { value: 1, recipient: 'b2', dealerIid: null, dealerSeat: 'A' }] })
  eq([sim.s.procMeta.choice?.kind, sim.s.procMeta.choice?.by], ['order', 'B'], '8a: 同時に発生した2件のダメージ→順を AP（B）が選ぶ')
  act(sim, { type: 'procChoose', id: sim.s.procMeta.choice!.id, pick: ['b2'] })
  runAll(sim)
  eq(sim.trace.filter((t) => t.text.startsWith('ダメージ:')).map((t) => t.text), ['ダメージ:b2:1', 'ダメージ:b1:1'], '8b: 選んだ順に受け手ごとに1件ずつ処理（H-1）')
}

// =============================================================================
// 9. 使用代償（8・8-2-1・8-3・8-3-1 oldrule.txt:272-305）— engine/cost.ts
//    8-2-1「コストアイコン１つに対して属性アイコン１つが割り当てます。この割り当ては可能な限り行います。」
//    「Ｗ賢感 → 賢さ属性を持つコスト１つと、感性属性のキャラが待機状態。もしくは、感性属性を持つコスト１つと、賢さ属性のキャラが待機状態。」
//    8-3-1「気力が０以下の場合、気力を減らす使用代償を支払うことができません。」
//    7-1-1「自分消耗コスト（[Ｒ]）…味方消耗コスト、その他のコストとしても扱うことができる。」
// =============================================================================
{
  eq(parseCostText('R＋気力－１').cost, { icons: ['R'], attrs: [], other: [{ kiryoku: 1 }] }, '9a: 元表記「R＋気力－１」の読み取り')
  eq(parseCostText('RW＋このキャラをゴミ箱送りにする').cost, { icons: ['R', 'W'], attrs: [], other: [{ trash: { ref: 'self' } }] }, '9b: 「RW＋このキャラをゴミ箱送りにする」')
  eq(parseCostText('WW賢').cost, { icons: ['W', 'W'], attrs: ['賢'] }, '9c: 「ＷＷ賢」')
  eq(assignments({ icons: ['W', 'W'], attrs: ['賢'] }).map((a) => a.req), [[{ icon: 'W', attr: '賢' }, { icon: 'W', attr: null }]], '9d: ＷＷ賢 → 賢さ属性のコスト1つと属性を問わないコスト1つ')
  eq(
    assignments({ icons: ['W'], attrs: ['賢', '感'] }).map((a) => [a.req[0].attr, a.readyAttrs]),
    [['賢', ['感']], ['感', ['賢']]],
    '9e: Ｗ賢感 → 賢のコスト＋感のキャラが待機、もしくは感のコスト＋賢のキャラが待機',
  )
  eq(assignments({ icons: [], attrs: ['早'] })[0].readyAttrs, ['早'], '9f: 早（コストアイコン無し）→ 早さ属性を持つキャラが待機状態でいる')
  eq(!!matchTokens([{ icon: 'W', attr: null }], [{ id: 't', icon: 'R', attrs: [] }]), true, '9g: R は W として払える（上位互換）')
  eq(!!matchTokens([{ icon: 'G', attr: null }], [{ id: 't', icon: 'W', attrs: [] }]), false, '9h: W は G として払えない')
  eq(!!matchTokens([{ icon: 'W', attr: '賢' }], [{ id: 't', icon: 'W', attrs: ['力'] }]), false, '9i: 属性が違うコストでは払えない')
  const ctx: EngineCtx = { cards: {}, defs: {} }
  const d = decl('X', 'A', 'ability', 'a1', { eng: { usePool: true } })
  const s0 = board([card('a1', 'A', 'char', { kiryoku: 0 })])
  eq(payNow(ctx, s0, 'X', d, { icons: [], attrs: [], other: [{ kiryoku: 2 }] }).ok, false, '9j: 気力0のキャラは「気力－２」を払えない（8-3-1）')
  const s1 = board([card('a1', 'A', 'char', { kiryoku: 1 })])
  eq(payNow(ctx, s1, 'X', d, { icons: [], attrs: [], other: [{ kiryoku: 2 }] }).kiryoku, [{ iid: 'a1', delta: -2 }], '9k: 気力1なら払える（0未満になってよい FAQ:3263）')
  // 払った結果 0未満→ダウン（FAQ:3263「気力が－１となり、ただちにダウン」）
  const sim: Sim = { s: s1, trace: [], stops: [] }
  act(sim, { type: 'procKiryoku', iid: 'a1', delta: -2, max: 5 })
  eq([sim.s.cards.a1.kiryoku, topFrame(sim.s)?.kind], [-1, 'down'], '9l: 気力1から−2で −1 になり、ダウンが起きる')
}

// =============================================================================
// 10. 旧データ（R2a より前に保存された盤面）の読み込み: 新しい手順の状態は既定値で補う（PHASE-R2a §1・§6）
// =============================================================================
{
  const old = { cards: {}, modifiers: {}, priority: null, mode: 'assist', battle: null, setup: { A: null, B: null } } as Partial<BoardState>
  const f = fillBoardDefaults(old)
  eq([f.proc, f.turn, f.downs, f.costs, f.result, f.procMeta.seq, f.procMeta.base], [[], null, { A: 0, B: 0 }, { A: [], B: [] }, null, 0, null], '10a: proc・turn・downs・costs・result・procMeta を既定値で補う')
  const partial = fillBoardDefaults({ procMeta: { seq: 3 } } as unknown as Partial<BoardState>)
  eq([partial.procMeta.seq, partial.procMeta.answers, partial.procMeta.aborted], [3, {}, []], '10b: procMeta の欄が欠けていても欄ごとに補う')
  // 既存の優先権の窓は proc と独立に今までどおり動く
  const r = applyAction(EMPTY_BOARD, { type: 'declareAction', action: { by: 'A', sourceIid: null, kind: 'その他', actionType: '通常型', label: 'x' } })
  eq([r.state.priority?.frames.length, r.state.proc.length], [1, 0], '10c: 既存の declareAction は priority の窓を開き、proc には触れない')
}

console.log(failures === 0 ? '\n✅ 全成功' : `\n❌ ${failures} 件失敗`)
process.exit(failures === 0 ? 0 : 1)
