// core の処理手順（src/core/proc.ts）の単体テスト — PHASE-R2a §3-5
// 期待値は原典 _local/oldrule.txt の文から作る（各テストの頭に段番号と逐語を引く）。エンジン（カードの記述）は使わない:
// エンジンが返す操作（procTimingDone・procPay・procCheck・procEffect）はこのファイルの小さな代役が返す。

import { applyAction, type BoardAction } from '../src/core/actions'
import { EMPTY_BOARD, fillBoardDefaults, type BoardState, type CardInstance, type Seat } from '../src/core/board'
import { awaitingSeat, battleDecl, currentWindow, startBattleAt, topFrame, validChoicePick, type ProcChoice, type ProcDecl, type ProcTrace } from '../src/core/proc'
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
  if (s.procMeta.choice) return `choice:${s.procMeta.choice.purpose ?? s.procMeta.choice.kind}`
  const top = topFrame(s)
  if (!top) return s.procMeta.base ? 'base' : 'idle'
  if (top.status === 'window') return `${top.kind}[${top.step}]窓:${awaitingSeat(s)}`
  if (top.status === 'engine') return `${top.kind}[${top.step}]${top.engineWhat}`
  return `${top.kind}[${top.step}]${top.status}`
}
/** エンジンの代役: 窓は両者見送り、エンジンの段は「何もない・払えた・確かめた」で返す。止まった点を記録する */
function runAll(
  sim: Sim,
  opts: {
    onEngine?: (sim: Sim) => boolean
    pick?: (ch: ProcChoice) => string[] | undefined
    /** 席に1組（旧来の形。K9 の代役が参加キャラ全員に同じ値として広げる） */
    values?: Record<Seat, { atk: number; def: number } | null>
    kiryoku?: number | null
  } = {},
) {
  for (let g = 0; g < 500; g++) {
    const w = where(sim.s)
    if (w === 'result' || w === 'idle' || w === 'base') return
    sim.stops.push(w)
    const top = topFrame(sim.s)!
    if (sim.s.procMeta.choice) {
      const ch = sim.s.procMeta.choice
      // core の手順の選択は既定で先頭（参加キャラ・種目・[21] は「次へ」）、それ以外は選ばない
      const pick = opts.pick?.(ch) ?? (ch.purpose && ch.kind === 'select' ? ch.options.slice(0, ch.min).map((o) => o.key) : [])
      act(sim, { type: 'procChoose', id: ch.id, pick })
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
        case 'battleValues': {
          // K9: values は参加キャラごと（iid→値）。この代役は旧来どおり「席に1組」で受け取り、その席の全参加キャラに同じ値を当てる
          const bySeat = opts.values ?? { A: { atk: 3, def: 2 }, B: { atk: 3, def: 2 } }
          const b = top.battle!
          const perSeat = (seat: Seat): Record<string, { atk: number; def: number }> | null => {
            const v = bySeat[seat]
            if (!v) return null
            const out: Record<string, { atk: number; def: number }> = {}
            for (const iid of b.participants[seat]) out[iid] = v
            return out
          }
          act(sim, { type: 'procBattle', frameId: top.id, values: { A: perSeat('A'), B: perSeat('B') } })
          break
        }
        case 'place':
          act(sim, { type: 'procPlace', frameId: top.id, kiryoku: opts.kiryoku ?? null })
          break
        default:
          return
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
  // 統括11 の検証（C19 の直し）: 7-2 は「宣言---[1][2][3]」。[3] の窓は宣言の段で開き、処理は [4] から
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('a2', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  const cg: ProcDecl = decl('C', 'A', 'costGen', 'a2', { sources: [{ iid: 'a2', from: 'field', icon: 'G', attrs: ['賢'] }] })
  act(sim, { type: 'procDeclare', by: 'A', decl: cg })
  eq(where(sim.s), 'costGen[3]窓:A', '4a: 宣言の段で [3]《コストを発生するとき》の窓（相手の 11-2[2] の機会より前）')
  eq(currentWindow(sim.s)?.window.only, 'A', '4b: その窓はコストを発生させたプレイヤーだけ（7-2[3]）')
  act(sim, { type: 'procPass', by: 'A' })
  eq(where(sim.s), 'costGen[3]timing', '4c: 相手の番は無く、そのまま《〜とき》の処理へ')
  act(sim, { type: 'procTimingDone', frameId: topFrame(sim.s)!.id, items: [] })
  eq([where(sim.s), awaitingSeat(sim.s)], ['base', 'B'], '4c2: 宣言が終わってから 11-2[2] ノンアクティブプレイヤーの機会')
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq(sim.s.cards.a2.orientation, 'rested', '4d: [4] 発生源のキャラを消耗させる')
  eq(sim.s.costs.A.map((t) => [t.icon, t.attrs]), [['G', ['賢']]], '4e: [9] 発生したコストを得る（種類 G・属性 賢）')
  eq(sim.stops.filter((x) => x.startsWith('costGen[7]')), ['costGen[7]timing'], '4f: [7]《コストを発生する場合》は処理だけ（窓は無い）')
  eq(sim.stops.some((x) => x.startsWith('costGen[3]')), false, '4i: 処理の段では [3] の窓を開かない（処理は [4] から）')
}
{
  // 7-2「[5] 手順[3]で宣言したコストを発生させるアクションの処理を行う。」: [3] で宣言した行動は宣言の段では処理せず、[5] で処理する
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('a2', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('C', 'A', 'costGen', 'a2', { sources: [{ iid: 'a2', from: 'field', icon: 'G', attrs: ['賢'] }] }) })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('C2', 'A', 'costGen', 'a1', { sources: [{ iid: 'a1', from: 'field', icon: 'G', attrs: ['力'] }] }) })
  eq(where(sim.s), 'costGen[3]窓:A', '4j: [3] で宣言したコスト発生にもその宣言の [3] の窓')
  eq(sim.s.cards.a1.orientation, 'ready', '4k: [3] で宣言した行動は宣言の段では処理しない')
  runAll(sim) // 宣言の段の窓を見送る → メインの窓の NAP の番
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq(sim.s.costs.A.map((t) => t.attrs[0]), ['力', '賢'], '4l: [3] で宣言した行動は [5] で処理される（先に発生）→ その後 [9] で元のコスト')
}
{
  // 15-13-1[4]「このとき、このアクションを行ったプレイヤーはコストを発生させるアクションの宣言が行える」: その宣言の中で 7-2 の [1]〜[3]（NH-4 の解決）
  // 特殊能力の[4]で宣言したコスト発生は[7]で処理し、その種類はその特殊能力の中だけ（終わればその他のコスト W）
  const sim: Sim = { s: board([card('a1', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('X', 'A', 'ability', 'a1', { costGens: [[{ iid: 'a1', from: 'field', icon: 'R', attrs: ['力'] }]] }) })
  eq(where(sim.s), 'costGen[3]窓:A', '4m: 特殊能力の宣言[4]の中で《コストを発生するとき》の窓（宣言の段）')
  runAll(sim)
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
  // R2u-2: 旧 priority・battle の欄は読み込みで捨てる。assist は free として読む
  eq(['priority' in f, 'battle' in f, f.mode], [false, false, 'free'], '10c: 旧 priority・battle の欄を捨て、assist は free として読む')
}

// =============================================================================
// 11. 20-4 バトルの処理手順（oldrule.txt:1062-1127）: 段の順と止まる点
//    「[4]《バトルを挑まれたとき》…[6]…[7] …バトル参加キャラ１体を指定する。その後、そのキャラを消耗させる。…[8]…[10]…[11]…[13]…
//     [15]《バトルカードを選択するとき》[16] 未使用状態のバトルカードの中からバトルカード１枚を指定する。[17]…
//     [18] 1.バトル種目となったバトルカードを使用済み状態にする。…[19]…[20]…[21] 手順[19]に戻るか、次の手順に進むかを選択する。[22]…
//     [23] 攻撃能力値、防御能力値の決定。[24] バトルの結果の計算を行う。[25]…[26] 必要ならば、ダメージ処理、ダウン処理を行う。[27]…[28]…[29]」
// =============================================================================
function battleBoard(extra: CardInstance[] = []): BoardState {
  return board([card('la', 'A', 'leader'), card('a1', 'A', 'char'), card('lb', 'B', 'leader'), card('b1', 'B', 'char'), card('bc', 'B', 'battle', { used: false }), ...deck('A', 5), ...deck('B', 5), ...extra])
}
{
  const sim: Sim = { s: battleBoard(), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: battleDecl('BT', 'A') })
  eq(awaitingSeat(sim.s), 'B', '11a: [2] 相手プレイヤーの同時アクションの宣言の機会（20-1）')
  act(sim, { type: 'procPass', by: 'B' })
  let restedAfter7: unknown = null
  let usedAfter18: unknown = null
  runAll(sim, {
    pick: (ch) => (ch.purpose === 'battleParticipant' ? [ch.by === 'A' ? 'a1' : 'b1'] : undefined),
    onEngine: (s) => {
      const top = topFrame(s.s)!
      if (top.kind === 'battle' && top.step === 8 && restedAfter7 === null) restedAfter7 = s.s.cards.a1.orientation
      if (top.kind === 'battle' && top.step === 23) usedAfter18 = s.s.cards.bc.used
      return false
    },
  })
  const bs = sim.stops.filter((x) => x.startsWith('battle[') || x.startsWith('choice:battle')).filter((x, i, xs) => x !== xs[i - 1])
  eq(
    bs,
    [
      'battle[4]窓:A', 'battle[4]窓:B', 'battle[4]timing',
      'battle[6]窓:A', 'battle[6]窓:B', 'battle[6]timing', 'choice:battleParticipant',
      'battle[8]窓:A', 'battle[8]窓:B', 'battle[8]timing',
      'battle[10]窓:A', 'battle[10]窓:B', 'battle[10]timing', 'choice:battleParticipant',
      'battle[13]窓:A', 'battle[13]窓:B', 'battle[13]timing',
      'battle[15]窓:A', 'battle[15]窓:B', 'battle[15]timing', 'choice:battleCard',
      'battle[17]窓:A', 'battle[17]窓:B', 'battle[17]timing',
      'battle[19]窓:A', 'battle[19]窓:B', 'battle[19]timing',
      'battle[20]窓:A', 'battle[20]窓:B', 'battle[20]timing', 'choice:battleLoop',
      'battle[22]窓:A', 'battle[22]窓:B', 'battle[22]timing',
      'battle[23]battleValues',
      'battle[25]窓:A', 'battle[25]窓:B', 'battle[25]timing',
      'battle[27]窓:A', 'battle[27]窓:B', 'battle[27]timing',
      'battle[28]timing',
      'battle[29]窓:A', 'battle[29]窓:B', 'battle[29]timing',
    ],
    '11b: 窓は [4][6][8][10][13][15][17][19][20][22][25][27][29]、[28] は処理だけ。選択は [7][11][16][21]',
  )
  eq(restedAfter7, 'rested', '11c: [7] 指定したらそのキャラを消耗させる（指定した瞬間 FAQ:3465）')
  eq(usedAfter18, true, '11d: [18] 1. バトル種目となったバトルカードを使用済み状態にする')
  eq([sim.s.cards.a1.kiryoku, sim.s.cards.b1.kiryoku], [4, 4], '11e: [24][26] 結果ダメージ＝相手の攻撃能力値−自分の防御能力値（3−2＝1 ずつ・同時 FAQ:3461）')
  eq([sim.s.procMeta.battles.length, sim.s.procMeta.battles[0]?.aborted, sim.s.proc.length], [1, null, 0], '11f: バトルが終わった（中断していない）')
}
{
  // [11] 20-8「待機状態のキャラか、リーダーキャラを１体選択します。リーダーキャラの場合は、待機状態ではなく消耗状態であっても選択可能です。」
  const sim: Sim = { s: battleBoard(), trace: [], stops: [] }
  sim.s = { ...sim.s, cards: { ...sim.s.cards, lb: { ...sim.s.cards.lb, orientation: 'rested' }, b1: { ...sim.s.cards.b1, orientation: 'rested' } } }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: battleDecl('BT', 'A') })
  act(sim, { type: 'procPass', by: 'B' })
  let opts11: string[] = []
  runAll(sim, {
    pick: (ch) => {
      if (ch.purpose === 'battleParticipant' && ch.by === 'B') opts11 = ch.options.map((o) => o.key)
      return ch.purpose === 'battleParticipant' ? [ch.options[0].key] : undefined
    },
  })
  eq(opts11, ['lb'], '11g: [11] 消耗状態のキャラは選べない・リーダーは消耗状態でも選べる（20-8）')
}
{
  // [21]「バトルを挑んだプレイヤーは手順[19]に戻るか、次の手順に進むかを選択する。」（窓の回数は実行時に上限なし）
  const sim: Sim = { s: applyAction(startBattleAt(battleBoard(), { challenger: 'A', at: 19, participants: { A: ['a1'], B: ['b1'] }, battleCard: 'bc' }), { type: 'procRun' }).state, trace: [], stops: [] }
  let loops = 0
  runAll(sim, { pick: (ch) => (ch.purpose === 'battleLoop' ? [loops++ < 2 ? 'back' : 'next'] : undefined) })
  eq(sim.stops.filter((x) => x === 'battle[19]窓:A').length, 3, '11h: [21] で [19] に戻ると [19][20] の機会がもう一度ある（2回戻れば3回）')
}
{
  // [19]「お互いのプレイヤーがイベントカードを複数回使用できる機会」: 宣言があったら同じ段の機会をもう一度開く
  // 最初の [19] の窓で B がイベントを宣言
  const s0 = startBattleAt(battleBoard([card('ev', 'B', 'hand')]), { challenger: 'A', at: 19, participants: { A: ['a1'], B: ['b1'] }, battleCard: 'bc' })
  const sim2: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  act(sim2, { type: 'procPass', by: 'A' })
  act(sim2, { type: 'procDeclare', by: 'B', decl: decl('EV', 'B', 'event', 'ev') })
  act(sim2, { type: 'procPass', by: 'A' })
  runAll(sim2)
  eq(sim2.stops.filter((x) => x.startsWith('battle[19]窓')).length >= 2, true, '11i: [19] で宣言があったら [19] の機会をもう一度開く（両者が見送るまで）')
}

// =============================================================================
// 12. 20-6 中断・20-6-1「処理を中断する場合、手順[28]の処理を行いますが、バトルが終了したときに行う手順[29]の処理は行いません。」
//     [28]「・攻防修正値を失わせる処理・バトル終了時に失われる効果の処理・バトル終了時に処理される効果の処理」
// =============================================================================
{
  const s0 = startBattleAt(battleBoard(), { challenger: 'A', at: 19, participants: { A: ['a1'], B: ['b1'] }, battleCard: 'bc' })
  const sim: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  const bt = topFrame(sim.s)!.id
  // R3: 修正の記録（procMod）は継続効果の層（procLayers）に移した。期待は同じ（[28] の逐語から）
  const mod = (stat: string, kind: '能力値修正' | '攻防修正', until: 'turn' | 'battle') => ({ source: null, ability: null, by: 'A' as const, label: `${stat}`, kind, until, targets: ['a1'], host: null, body: { mod: { stat, delta: 1 } } })
  act(sim, { type: 'procLayers', add: [mod('atk', '攻防修正', 'battle'), mod('力', '能力値修正', 'battle'), mod('早', '能力値修正', 'turn')] })
  act(sim, { type: 'procBattle', frameId: bt, abort: 'テスト（放棄）' })
  act(sim, { type: 'procPass', by: 'A' })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  const bs = sim.stops.filter((x) => x.startsWith('battle['))
  eq([bs.includes('battle[28]timing'), bs.some((x) => x.startsWith('battle[29]')), bs.some((x) => x.startsWith('battle[20]'))], [true, false, false], '12a: 中断したら [28] だけ（[29] も残りの段も無い）')
  eq(sim.s.layers.list.map((m) => `${m.label}${m.kind}`), ['早能力値修正'], '12b: [28] で攻防修正と「バトル終了時まで」の効果は失われ、能力値修正（ターン終了時まで）は残る')
  eq(sim.s.procMeta.battles[0]?.aborted, 'テスト（放棄）', '12c: 中断の記録')
}
{
  // 20-6「手順[19]～手順[28]の間に…どちらかのプレイヤーのバトル参加キャラが失われる（バトルの結果でダウンした場合を除く）」
  const s0 = startBattleAt(battleBoard(), { challenger: 'A', at: 19, participants: { A: ['a1'], B: ['b1'] }, battleCard: 'bc' })
  const sim: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  act(sim, { type: 'procMove', iid: 'b1', to: 'trash' })
  act(sim, { type: 'procPass', by: 'A' })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq([sim.s.procMeta.battles[0]?.aborted, sim.stops.some((x) => x.startsWith('battle[29]'))], ['バトル参加キャラが失われた（20-6・NH-8: その陣営の参加キャラが全員失われた）', false], '12d: 参加キャラが失われたら中断（[28] だけ）')
}
{
  // バトルの結果でダウンしたら中断しない（[29] がある）
  const sim: Sim = { s: startBattleAt(battleBoard(), { challenger: 'A', at: 22, participants: { A: ['a1'], B: ['b1'] }, battleCard: 'bc' }), trace: [], stops: [] }
  sim.s = applyAction(sim.s, { type: 'procRun' }).state
  runAll(sim, { values: { A: { atk: 9, def: 0 }, B: { atk: 0, def: 0 } } })
  eq([sim.s.cards.b1.zone, sim.s.procMeta.battles[0]?.aborted, sim.stops.some((x) => x.startsWith('battle[29]'))], ['trash', null, true], '12e: 結果ダメージでダウンした参加キャラは中断に数えない')
}
{
  // [5]「この段階で、バトルを行うため条件を満たせない場合は処理を中断する。」20-3「いずれかのフィールドに選択可能なバトルカードが１枚以上」
  const sim: Sim = { s: battleBoard(), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: battleDecl('BT', 'A') })
  sim.s = { ...sim.s, cards: { ...sim.s.cards, bc: { ...sim.s.cards.bc, zone: 'trash' } } }
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq([sim.s.procMeta.battles[0]?.aborted?.includes('20-4[5]'), sim.s.cards.a1.orientation], [true, 'ready'], '12f: [5] で中断（参加キャラはまだ指定していない＝消耗しない FAQ:1186）')
}

// =============================================================================
// 13. 複数参加（K9・DESIGN §5.2「参加キャラは複数持てる形」）: 参加キャラは陣営ごとの配列。攻防の値と結果ダメージは人が入れる（R4）
// =============================================================================
{
  const s0 = startBattleAt(battleBoard([card('a2', 'A', 'char')]), { challenger: 'A', at: 22, participants: { A: ['a1', 'a2'], B: ['b1'] }, battleCard: 'bc' })
  const sim: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  runAll(sim, { values: { A: null, B: { atk: 3, def: 2 } } })
  eq(sim.s.procMeta.battles[0]?.participants.A, ['a1', 'a2'], '13a: 参加キャラを複数持てる')
  eq(sim.trace.some((t) => t.kind === 'manual'), true, '13b: 複数参加・値の無いバトルの結果は人が処理（manual の記録）')
}
{
  // NH-8（決定 2026-09-27・holes.ts）: 複数参加で参加キャラが1体だけ失われても中断しない（残りで続ける）
  const s0 = startBattleAt(battleBoard([card('a2', 'A', 'char')]), { challenger: 'A', at: 19, participants: { A: ['a1', 'a2'], B: ['b1'] }, battleCard: 'bc' })
  const sim: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  act(sim, { type: 'procMove', iid: 'a2', to: 'trash' })
  act(sim, { type: 'procPass', by: 'A' })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim, { values: { A: null, B: { atk: 3, def: 2 } } })
  eq(sim.s.procMeta.battles[0]?.aborted, null, '13c: NH-8: 参加キャラ2体のうち1体が失われても中断しない（残りの1体で続ける）')
}
{
  // NH-8: その陣営の参加キャラが（resultDowned を除いて）全員失われたら中断する
  const s0 = startBattleAt(battleBoard([card('a2', 'A', 'char')]), { challenger: 'A', at: 19, participants: { A: ['a1', 'a2'], B: ['b1'] }, battleCard: 'bc' })
  const sim: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  act(sim, { type: 'procMove', iid: 'a2', to: 'trash' })
  act(sim, { type: 'procMove', iid: 'a1', to: 'trash' })
  act(sim, { type: 'procPass', by: 'A' })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq(sim.s.procMeta.battles[0]?.aborted, 'バトル参加キャラが失われた（20-6・NH-8: その陣営の参加キャラが全員失われた）', '13d: NH-8: その陣営の参加キャラが全員失われたら中断する')
}
{
  // FAQ:3878-3879: 挑んだキャラ1体×挑まれたキャラN体のNペア。挑んだキャラはN件のダメージを受け、挑まれた側は1件ずつ受ける
  const s0 = startBattleAt(battleBoard([card('b2', 'B', 'char')]), { challenger: 'A', at: 22, participants: { A: ['a1'], B: ['b1', 'b2'] }, battleCard: 'bc' })
  const sim: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  runAll(sim, { values: { A: { atk: 3, def: 2 }, B: { atk: 3, def: 2 } } })
  eq([sim.s.cards.a1.kiryoku, sim.s.cards.b1.kiryoku, sim.s.cards.b2.kiryoku], [3, 4, 4], '13e: FAQ:3878-3879 挑んだキャラ1体は挑まれた2体それぞれから結果ダメージを受ける（1点ずつ2件＝気力5→3）・挑まれた側は1件ずつ（気力5→4）')
}

// =============================================================================
// 14. 17-3 アイテムカードの装備（oldrule.txt:864-889）
//    「[11] 手順[3]で提示したアイテムカードが手順[3]で指定した装備対象に装備される。[12] …装備制限を満たせない場合は、そのアイテムカードをゴミ箱送りにする。
//     [13] 《アイテムカードを装備したとき》のタイミングでの処理、アクション宣言の機会。」
// =============================================================================
{
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('it', 'A', 'hand')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('EQ', 'A', 'equip', 'it', { equipTo: 'a1', targets: ['a1'] }) })
  eq(sim.s.cards.it.zone, 'pending', '14a: [3] 提示したアイテムは提示エリアへ（使用したと見なされる）')
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq(sim.stops.filter((x) => x.startsWith('equip[')).filter((x, i, xs) => x !== xs[i - 1]), ['equip[8]窓:A', 'equip[8]窓:B', 'equip[8]timing', 'equip[9]pay', 'equip[13]窓:A', 'equip[13]窓:B', 'equip[13]timing'], '14b: [8]窓→[9]支払い→[13]窓')
  eq([sim.s.cards.it.attachedTo, sim.s.cards.it.zone], ['a1', 'char'], '14c: [11] 装備対象に装備される')
}
{
  // 17-2「１つの装備対象に、同じカード名のアイテムカードを２枚以上装備することはできません」→ [12] でゴミ箱送り
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('it1', 'A', 'char', { attachedTo: 'a1', cardId: 'x', kiryoku: null }), card('it2', 'A', 'hand', { cardId: 'x' })]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('EQ', 'A', 'equip', 'it2', { equipTo: 'a1', targets: ['a1'] }) })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq([sim.s.cards.it2.zone, sim.stops.some((x) => x.startsWith('equip[13]'))], ['trash', false], '14d: [12] 同名制限を満たせなければゴミ箱送り（[13] は無い）')
}
{
  // [10]「構成要素が満たされていない場合（…使用代償を支払えない…）…中断する。処理が中断する場合、手順[3]で提示したアイテムカードをゴミ箱送りにする。」
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('it', 'A', 'hand')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('EQ', 'A', 'equip', 'it', { equipTo: 'a1', targets: ['a1'] }) })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim, { onEngine: (s) => (topFrame(s.s)!.engineWhat === 'pay' ? (act(s, { type: 'procPay', frameId: topFrame(s.s)!.id, ok: false, consume: [], kiryoku: [], trash: [], down: [] }), true) : false) })
  eq(sim.s.cards.it.zone, 'trash', '14e: [10] 支払えなければ中断してゴミ箱送り')
}
{
  // 移し替え（「アイテムの装備と同じ扱い」FAQ:804・2874）: [11] から＝[13]《装備したとき》がある
  const sim: Sim = { s: board([card('a1', 'A', 'char'), card('a2', 'A', 'char'), card('it', 'A', 'char', { attachedTo: 'a1', kiryoku: null })]), trace: [], stops: [] }
  act(sim, { type: 'procTransfer', by: 'A', item: 'it', to: 'a2', id: 'MV' })
  runAll(sim)
  eq([sim.s.cards.it.attachedTo, sim.stops.includes('equip[13]窓:A'), sim.stops.some((x) => x.startsWith('equip[8]'))], ['a2', true, false], '14f: 移し替えは装備の [11]〜[13]（[13]《装備したとき》の窓あり）')
}

// =============================================================================
// 15. 18-2 フィールドカードの配置・19-2 バトルカードの配置
//    18-2「[11] フィールド上にフィールドカードがある場合はそれをゴミ箱送りにする。[12] …フィールドに配置される。」
//    19-2「[11] 手順[3]で提示したバトルカードがフィールドに配置される。[12]《バトルカードを配置したとき》」
// =============================================================================
{
  const sim: Sim = { s: board([card('f0', 'B', 'field'), card('f1', 'A', 'hand')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('FD', 'A', 'field', 'f1') })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq([sim.s.cards.f0.zone, sim.s.cards.f1.zone, sim.stops.includes('field[13]窓:A')], ['trash', 'field', true], '15a: 出ていたフィールドカードはゴミ箱・新しいカードを配置・[13] の窓')
}
{
  const sim: Sim = { s: board([card('b0', 'A', 'hand')]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('BC', 'A', 'battleCard', 'b0') })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq([sim.s.cards.b0.zone, sim.s.cards.b0.used, sim.stops.includes('battleCard[12]窓:A')], ['battle', false, true], '15b: バトルカードは未使用状態で配置・[12] の窓')
}

// =============================================================================
// 16. 15-10-1 キャラクターの呼び出し・15-10-2 タッグ化
//    15-10-1「[13] 手順[3]で提示したキャラクターカードを消耗状態でフィールドに出す。[14]《キャラクターカードが呼び出されたとき》」
//    15-10-2「[12] 手順[4]で提示した２枚のキャラクターカードをゴミ箱へ移動させる。[13] …タッグキャラクターカードを待機状態でフィールドに出す。」
//    「タッグ化を行った場合、フィールドの構成要素キャラが装備していたアイテムとダメージ（気力の上限－気力）を引き継ぎます。」
// =============================================================================
{
  const sim: Sim = { s: board([card('c1', 'A', 'hand', { kiryoku: 4 })]), trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('CL', 'A', 'call', 'c1') })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim, { kiryoku: 4 })
  eq(sim.stops.filter((x) => x.startsWith('call[')).map((x) => x.replace(/窓:[AB]/, '窓')).filter((x, i, xs) => x !== xs[i - 1]), ['call[8]窓', 'call[8]timing', 'call[9]pay', 'call[11]窓', 'call[11]timing', 'call[13]place', 'call[14]窓', 'call[14]timing'], '16a: 呼び出しの段 [8]窓→[9]支払い→[11]窓→[13]出す→[14]窓')
  eq([sim.s.cards.c1.zone, sim.s.cards.c1.orientation, sim.s.cards.c1.kiryoku], ['char', 'rested', 4], '16b: [13] 消耗状態でフィールドに出す')
}
{
  const sim: Sim = {
    s: board([card('p', 'A', 'char', { kiryoku: 2 }), card('q', 'A', 'hand', { kiryoku: 5 }), card('it', 'A', 'char', { attachedTo: 'p', kiryoku: null }), card('tg', 'A', 'hand', { kiryoku: 6 }), ...deck('B', 3)]),
    trace: [],
    stops: [],
  }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: decl('TG', 'A', 'tag', 'tg', { components: ['p', 'q'], targets: ['p', 'q'] }) })
  act(sim, { type: 'procPass', by: 'B' })
  let rec: unknown = null
  runAll(sim, { onEngine: (s) => ((topFrame(s.s)!.engineWhat === 'place' ? (rec = topFrame(s.s)!.eng.componentKiryoku) : null), false), kiryoku: 3 })
  eq([sim.s.cards.p.zone, sim.s.cards.q.zone, sim.s.cards.it.attachedTo, sim.s.cards.tg.orientation, sim.s.cards.tg.kiryoku], ['trash', 'trash', 'tg', 'ready', 3], '16c: 構成要素はゴミ箱・アイテムはタッグが引き継ぐ・待機状態で出す（気力はエンジンの値）')
  eq(rec, { p: 2 }, '16d: [12] フィールドの構成要素の気力を記録（ダメージの引き継ぎはエンジンが計算）')
  const sim2: Sim = { s: board([card('p', 'A', 'char', { kiryoku: 1 }), card('q', 'A', 'hand'), card('tg', 'A', 'hand'), ...deck('B', 3)]), trace: [], stops: [] }
  act(sim2, { type: 'procOpenMain' })
  act(sim2, { type: 'procDeclare', by: 'A', decl: decl('TG', 'A', 'tag', 'tg', { components: ['p', 'q'], targets: ['p', 'q'] }) })
  act(sim2, { type: 'procPass', by: 'B' })
  runAll(sim2, { kiryoku: 0 })
  eq([sim2.s.cards.tg.zone, sim2.s.downs.A], ['trash', 1], '16e: 気力0以下で出たらその瞬間にダウン（FAQ:3266）')
}

// =============================================================================
// 17. 10-4 エントリーフェイズ・10-7 手札調整フェイズ・10-8 ターン終了
//    10-4「[1]《エントリー開始時》[2] AP は任意に消耗状態の自分のキャラを待機状態にする。[3] AP は必ずフィールド上のすべてのバトルカードを未使用状態にする。
//     [4] AP は、必ず自分のデッキからカードを１枚ドローする。[5]《エントリー終了時》」
//    10-7「[3] 手札の上限枚数を超えている場合、手札が上限枚数になるように手札のカードを選んでゴミ箱送りにする。」4-2-1「手札の上限枚数は７枚です。」
//    10-8「・コストの破棄・能力値修正を失わせる処理・《ターン終了時》に失われる効果の処理・《ターン終了時》に処理される効果の処理」
// =============================================================================
{
  const sim: Sim = { s: board([card('a1', 'A', 'char', { orientation: 'rested' }), card('a2', 'A', 'char', { orientation: 'rested' }), card('bA', 'A', 'battle', { used: true }), card('bB', 'B', 'battle', { used: true }), ...deck('A', 3)], { turn: { active: 'A', phase: 'エントリー' } }), trace: [], stops: [] }
  act(sim, { type: 'procPhaseStart' })
  runAll(sim, { pick: (ch) => (ch.purpose === 'entryReady' ? ['a1'] : undefined) })
  eq(sim.stops.filter((x) => x.startsWith('entry[') || x.startsWith('choice:entry')).map((x) => x.replace(/窓:[AB]/, '窓')).filter((x, i, xs) => x !== xs[i - 1]), ['entry[1]窓', 'entry[1]timing', 'choice:entryReady', 'entry[5]窓', 'entry[5]timing'], '17a: [1]窓→[2]AP の任意の選択→[5]窓')
  eq([sim.s.cards.a1.orientation, sim.s.cards.a2.orientation], ['ready', 'rested'], '17b: [2] 選んだキャラだけ待機状態に（任意 FAQ:510）')
  eq([sim.s.cards.bA.used, sim.s.cards.bB.used], [false, false], '17c: [3] お互いのすべてのバトルカードを未使用状態に（FAQ:3452）')
  eq([sim.s.cards.deckA0.zone, sim.s.turn?.phase], ['hand', 'メイン'], '17d: [4] AP が1枚ドロー・エントリーが終わったらメインフェイズ')
}
{
  const hand = Array.from({ length: 8 }, (_, i) => card(`h${i}`, 'A', 'hand'))
  const sim: Sim = { s: board([card('a1', 'A', 'char'), ...hand], { turn: { active: 'A', phase: '手札調整' }, costs: { A: [{ id: 'k', icon: 'W', attrs: [], frameId: null }], B: [] } }), trace: [], stops: [] }
  sim.s = { ...sim.s, layers: { ...sim.s.layers, list: [{ id: 'm', seq: 1, source: null, ability: null, by: 'A', label: '力+2', kind: '能力値修正', until: 'turn', battleId: null, targets: ['a1'], host: null, body: { mod: { stat: '力', delta: 2 } } }] } }
  act(sim, { type: 'procPhaseStart' })
  runAll(sim, { pick: (ch) => (ch.purpose === 'handDiscard' ? ['h0'] : undefined) })
  eq([sim.s.cards.h0.zone, Object.values(sim.s.cards).filter((c) => c.zone === 'hand').length], ['trash', 7], '17e: [3] 上限7枚を超えた分を選んでゴミ箱送り')
  eq(sim.stops.includes('turnEnd[1]timing'), true, '17f: 手札調整フェイズの後にターン終了（10-8）《ターン終了時》の処理')
  eq([sim.s.costs.A.length, sim.s.layers.list.length], [0, 0], '17g: 10-8 コストの破棄・能力値修正を失わせる')
}

// =============================================================================
// 18. 割り振りの選択（《サバイバル》FAQ:4109「キャラの気力が０より小さくならないように」）: 選択肢ごとの上限
// =============================================================================
{
  const ch: ProcChoice = { id: 'c', by: 'A', kind: 'select', prompt: '', options: [{ key: 'x', label: 'x' }, { key: 'z', label: 'z' }], min: 3, max: 3, repeat: true, caps: { x: 1, z: 5 }, frameId: null }
  eq([validChoicePick(ch, ['x', 'x', 'x']), validChoicePick(ch, ['x', 'z', 'z']), validChoicePick(ch, ['z', 'z'])], [false, true, false], '18a: 上限を超える割り振り・数の足りない割り振りは受け付けない')
}

// =============================================================================
// 19. 旧データ（R2b より前に保存された盤面）: 新しい欄（修正の記録・バトルの記録・フェイズの段）は既定値で補う
// =============================================================================
{
  const f = fillBoardDefaults({ procMeta: { seq: 1, base: null, mainClosed: false, choice: null, answers: {}, used: {}, leaderLost: [], aborted: [] } } as unknown as Partial<BoardState>)
  eq([f.layers.list, f.procMeta.battles, f.procMeta.phaseRun], [[], [], null], '19a: 層・battles・phaseRun を既定値で補う')
  // R3: R2b の修正の記録（procMeta.mods）は層に移す（旧データ）。R3 より前の手直しの層（modifiers）には連番を補う
  const g = fillBoardDefaults({
    modifiers: { m1: { id: 'm1', targetIid: 'a1', sourceLabel: '手', stat: '力', delta: 1, kind: '能力値修正', scope: 'その他' } },
    procMeta: { seq: 3, base: null, mainClosed: false, choice: null, answers: {}, used: {}, leaderLost: [], aborted: [], mods: [{ id: 'mod2', iid: 'a1', stat: '早', delta: 2, kind: '能力値修正', until: 'turn', battleId: null }] },
  } as unknown as Partial<BoardState>)
  eq(
    [g.layers.list.map((l) => [l.kind, l.until, l.targets, l.body]), 'mods' in g.procMeta, g.modifiers.m1.seq],
    [[['能力値修正', 'turn', ['a1'], { mod: { stat: '早', delta: 2 } }]], false, 1],
    '19c: 旧データの procMeta.mods は層に、modifiers に連番を補う',
  )
}

// =============================================================================
// 20. 継続効果の層の入れ物（K3・R3。core は入れ物・連番・期限だけ。中身は読まない）
//     12-2「新たにこれらの効果が発揮した場合は、既に発揮した全ての効果の後に発揮したとみなされ」（oldrule.txt:505-506）＝連番は足した順
//     12-2「これらの効果は効果の発生元が存在し続ける必要があります」（510-511）＝常時効果（whileSource）は [28]・10-8 では外さない
//     20-4[28]「・攻防修正値を失わせる処理・バトル終了時に失われる効果の処理」（1122-1124）／10-8「・能力値修正を失わせる処理・《ターン終了時》に失われる効果の処理」（439-441）
// =============================================================================
{
  const seed = (label: string, kind: '能力値修正' | '攻防修正' | null, until: 'turn' | 'battle' | 'whileSource') => ({ source: null, ability: until === 'whileSource' ? 0 : null, by: 'A' as const, label, kind, until, targets: ['a1'], host: null, body: {} })
  const s0 = startBattleAt(battleBoard(), { challenger: 'A', at: 19, participants: { A: ['a1'], B: ['b1'] }, battleCard: 'bc' })
  const sim: Sim = { s: applyAction(s0, { type: 'procRun' }).state, trace: [], stops: [] }
  const bt = topFrame(sim.s)!.id
  act(sim, { type: 'procLayers', add: [seed('能力・ターン', '能力値修正', 'turn'), seed('攻防・バトル', '攻防修正', 'battle'), seed('常時の攻防', '攻防修正', 'whileSource'), seed('常時の能力', '能力値修正', 'whileSource')] })
  const l = sim.s.layers.list
  eq([l.map((x) => x.seq).every((q, i) => i === 0 || q > l[i - 1].seq), l[1].battleId, l[0].battleId], [true, bt, null], '20a: 層の連番は足した順・バトル終了時まで／攻防修正はそのバトルに結びつく')
  act(sim, { type: 'procBattle', frameId: bt, abort: 'テスト' })
  act(sim, { type: 'procPass', by: 'A' })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq(sim.s.layers.list.map((x) => x.label), ['能力・ターン', '常時の攻防', '常時の能力'], '20b: [28] は攻防修正（効果で足したもの）とバトル終了時までの効果を外す。常時効果の層は残す（12-2）')
  act(sim, { type: 'procPhase', to: 'ターン終了' })
  runAll(sim)
  eq(sim.s.layers.list.map((x) => x.label), ['常時の攻防', '常時の能力'], '20c: 10-8 は能力値修正（効果で足したもの）とターン終了時までの効果を外す。常時効果の層は残す')
  act(sim, { type: 'procLayers', remove: [sim.s.layers.list[0].id], update: [{ id: sim.s.layers.list[1].id, body: { x: 1 } }], bound: { i1: 'a1' }, unusable: ['bc'] })
  eq([sim.s.layers.list.map((x) => [x.label, x.body]), sim.s.layers.bound, sim.s.layers.unusable], [[['常時の能力', { x: 1 }]], { i1: 'a1' }, ['bc']], '20d: 層を外す・中身を書き換える・控え（bound・unusable）を置く')
}
{
  // 15-4「気力は気力上限以上の値はとりません」（616）・FAQ:249 取り除いたら残り気力は上限と同じ値に調整。orient は効果で状態を戻す（「常に消耗状態」FAQ:2476）
  const sim: Sim = { s: board([card('a1', 'A', 'char', { kiryoku: 6 }), card('a2', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procLayers', clamp: [{ iid: 'a1', value: 5 }, { iid: 'a2', value: 9 }], orient: [{ iid: 'a2', to: 'rested', why: 'テスト' }] })
  eq([sim.s.cards.a1.kiryoku, sim.s.cards.a2.kiryoku, sim.s.cards.a2.orientation], [5, 5, 'rested'], '20e: clamp は上限を超えた分だけ下げる（上げない）・orient は状態を変える')
}
{
  // 20-3「選択可能なバトルカードがある」・20-4[16]: 効果で使用できないバトルカードは選べない（控え unusable）
  const s0 = board([card('la', 'A', 'leader'), card('a1', 'A', 'char'), card('lb', 'B', 'leader'), card('b1', 'B', 'char'), card('bc', 'B', 'battle', { used: false }), ...deck('A', 5), ...deck('B', 5)])
  const sim: Sim = { s: { ...s0, layers: { ...s0.layers, unusable: ['bc'] } }, trace: [], stops: [] }
  act(sim, { type: 'procOpenMain' })
  act(sim, { type: 'procDeclare', by: 'A', decl: battleDecl('BT', 'A') })
  act(sim, { type: 'procPass', by: 'B' })
  runAll(sim)
  eq(sim.s.procMeta.battles[0]?.aborted, '選択可能なバトルカードが無い（20-3・20-4[5]）', '20f: 使用できないバトルカードしか無ければ [5] で中断（20-3）')
}
{
  // 15-2「キャラは１体づつ選択してゴミ箱送りにします」（594-596）・17-1（851-853）: 場の制限の是正は選んだものをゴミ箱送り（ダウンではない）。リーダーは選ばせない
  const sim: Sim = { s: board([card('la', 'A', 'leader'), card('a1', 'A', 'char'), card('it', 'A', 'char', { attachedTo: 'a1', kiryoku: null }), card('a2', 'A', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procChoice', choice: { id: 'lim', by: 'A', kind: 'select', purpose: 'limitTrash', prompt: '場の制限', options: [{ key: 'a1', label: 'a1' }, { key: 'a2', label: 'a2' }], min: 1, max: 1, frameId: null } })
  act(sim, { type: 'procChoose', id: 'lim', pick: ['a1'] })
  eq([sim.s.cards.a1.zone, sim.s.cards.it.zone, sim.s.cards.a2.zone, sim.s.downs.A], ['trash', 'trash', 'char', 0], '20g: 選んだキャラ（と装備していたアイテム）をゴミ箱送り・ダウン数は増えない')
  act(sim, { type: 'procLimitTrash', iids: ['la', 'a2'], reason: 'テスト' })
  eq([sim.s.cards.la.zone, sim.s.cards.a2.zone], ['leader', 'trash'], '20h: 選ぶ余地が無いときのゴミ箱送り（リーダーは送らない）')
}
{
  // FAQ:1484「入れ替えたアイテムが一番最後になります」: 付け替えは同時・装備の順の最後
  const sim: Sim = { s: board([card('x', 'A', 'char'), card('y', 'B', 'char'), card('p', 'A', 'char', { attachedTo: 'x', kiryoku: null }), card('q', 'B', 'char', { attachedTo: 'y', kiryoku: null }), card('r', 'B', 'char', { attachedTo: 'y', kiryoku: null })]), trace: [], stops: [] }
  sim.s = { ...sim.s, cards: { ...sim.s.cards, q: { ...sim.s.cards.q, index: 100 }, r: { ...sim.s.cards.r, index: 101 } } }
  act(sim, { type: 'procAttach', moves: [{ item: 'p', to: 'y' }, { item: 'q', to: 'x' }] })
  eq([sim.s.cards.p.attachedTo, sim.s.cards.q.attachedTo, sim.s.cards.p.index > sim.s.cards.r.index], ['y', 'x', true], '20i: 2枚の付け替えは同時・付け替えたアイテムは装備の順の最後')
}
{
  // 15-4-2「[5] 《ダメージを与えたとき》《ダメージを受けたとき》…[6] ダメージの値分、気力を減らす」: 受けない（prevent）なら [5] の処理も [6] も無い
  const sim: Sim = { s: board([card('b1', 'B', 'char')]), trace: [], stops: [] }
  act(sim, { type: 'procDamage', damages: [{ value: 2, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  runAll(sim, { onEngine: (s) => false })
  // [5] の窓まで進んだ（runAll は窓を見送るので、手で止める）
  const sim2: Sim = { s: board([card('b1', 'B', 'char')]), trace: [], stops: [] }
  act(sim2, { type: 'procDamage', damages: [{ value: 2, recipient: 'b1', dealerIid: null, dealerSeat: 'A' }] })
  for (let g = 0; g < 50 && !(topFrame(sim2.s)?.kind === 'damage' && topFrame(sim2.s)!.step === 5 && topFrame(sim2.s)!.status === 'window'); g++) {
    const t = topFrame(sim2.s)!
    if (t.status === 'window') act(sim2, { type: 'procPass', by: awaitingSeat(sim2.s)! })
    else if (t.status === 'engine' && t.engineWhat === 'timing') act(sim2, { type: 'procTimingDone', frameId: t.id, items: [] })
  }
  act(sim2, { type: 'procDamageEdit', frameId: topFrame(sim2.s)!.id, prevent: 'テスト' })
  runAll(sim2)
  eq([sim.s.cards.b1.kiryoku, sim2.s.cards.b1.kiryoku, sim2.s.proc.length, sim2.trace.some((t) => t.text.startsWith('受けない:b1'))], [3, 5, 0, true], '20j: ダメージを受けない（[5] の前）＝気力は減らない・手順は終わる')
}

console.log(failures === 0 ? '\n✅ 全成功' : `\n❌ ${failures} 件失敗`)
process.exit(failures === 0 ? 0 : 1)
